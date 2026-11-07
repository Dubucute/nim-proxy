// src/vision.js — Make image content portable across upstreams.
//
// NVIDIA's hosted gateway returns a bare `403 {"message":"Forbidden"}` for
// `image_url` parts whose URL points at an external host (verified against
// meta/muse-glimmer-30b: https://upload.wikimedia.org/... -> 403, same image as
// a data URI -> 200). The model is fully vision-capable; only the gateway's URL
// fetch is blocked. Clients that inline images as data URIs work today, so the
// proxy resolves remote URLs into data URIs itself and leaves the caller's
// request shape otherwise untouched.

'use strict';

const http = require('http');
const https = require('https');

const IMAGE_TYPES = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'tiff']);
const MIME_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff' };

class ImageFetchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ImageFetchError';
    this.status = status || 400;
  }
}

/** Is this already an inline data URI? */
function isDataUri(url) {
  return typeof url === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(url);
}

function isHttpUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeImage(mimeType) {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}

/** True when the message array carries at least one image part. */
function hasImageContent(messages) {
  return (messages || []).some((m) => Array.isArray(m?.content)
    && m.content.some((part) => part?.type === 'image_url'));
}

function extToMime(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = path.slice(path.lastIndexOf('.') + 1);
    return MIME_EXT[ext] || null;
  } catch {
    return null;
  }
}

/**
 * Fetch a remote image with size and type limits, returning a data URI.
 * Redirects are followed manually so each hop is re-validated against the
 * allow-list — a trusted host pointing at a private network must not slip past.
 */
async function urlToDataUri(url, {
  maxBytes = 8 * 1024 * 1024,
  timeoutMs = 15000,
  maxRedirects = 3,
  allowedHosts = null, // Set<string> or null (allow all public hosts)
  denyPrivate = true,
} = {}) {
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new ImageFetchError(`Invalid image URL: ${current}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ImageFetchError(`Unsupported image URL protocol "${parsed.protocol}"`);
    }
    if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw new ImageFetchError(
        `Image host "${parsed.hostname}" is not in ALLOWED_IMAGE_HOSTS. Inline the image as a data URI instead.`,
        403,
      );
    }
    if (denyPrivate && isPrivateHost(parsed.hostname)) {
      throw new ImageFetchError(`Refusing to fetch an image from a private address (${parsed.hostname}).`, 400);
    }

    const response = await requestOnce(parsed, timeoutMs);

    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) throw new ImageFetchError(`Redirect from ${current} without a Location header`);
        if (response.body) response.body.destroy();
        current = new URL(location, current).toString();
        continue;
      }
      if (response.status >= 400) {
        if (response.body) response.body.destroy();
        throw new ImageFetchError(
          `Could not download the image (HTTP ${response.status}) from ${redactHost(parsed)}. `
          + 'NVIDIA\'s gateway also refuses many external image URLs — send the image as a data URI.',
          response.status === 404 ? 404 : 400,
        );
      }

      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > maxBytes) {
        response.body.destroy();
        throw new ImageFetchError(`Image is ${Math.round(declaredLength / 1024 / 1024)}MB, over the ${Math.round(maxBytes / 1024 / 1024)}MB limit`, 413);
      }

      const chunks = [];
      let total = 0;
      await new Promise((resolve, reject) => {
        response.body.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            response.body.destroy();
            reject(new ImageFetchError(`Image exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit`, 413));
            return;
          }
          chunks.push(c);
        });
        response.body.on('end', resolve);
        response.body.on('error', reject);
      });

      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) throw new ImageFetchError('Downloaded image is empty');

      const mime = looksLikeImage(contentType) ? contentType : (extToMime(current) || sniffMime(buffer));
      if (!mime) {
        throw new ImageFetchError(
          `Downloaded content is not a recognised image (content-type "${contentType || 'unknown'}").`,
          415,
        );
      }
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } finally {
      if (response.body && !response.body.destroyed) response.body.destroy();
    }
  }

  throw new ImageFetchError(`Too many redirects while fetching ${url}`);
}

function requestOnce(parsed, timeoutMs) {
  const lib = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(parsed, {
      timeout: timeoutMs,
      headers: { accept: 'image/*,*/*', 'user-agent': 'nim-proxy/vision' },
    }, (res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode, headers: res.headers, body: res });
    });
    const timer = setTimeout(() => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(new ImageFetchError(`Failed to fetch image: ${err.message}`)); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function sniffMime(buffer) {
  const head = buffer.subarray(0, 12);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  return null;
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  return false;
}

function redactHost(parsed) {
  return `${parsed.host}${parsed.pathname.slice(0, 40)}`;
}

/**
 * Rewrite image_url parts of a NIM request so remote URLs become data URIs.
 * Returns { request, changed, notes }.
 */
async function inlineRemoteImages(request, options = {}) {
  const notes = [];
  if (!options.enabled || !Array.isArray(request.messages)) return { request, changed: false, notes };

  let changed = false;
  const messages = [];
  for (const message of request.messages) {
    if (!Array.isArray(message?.content)) { messages.push(message); continue; }

    const content = [];
    for (const part of message.content) {
      const url = part?.type === 'image_url' ? (part.image_url?.url ?? (typeof part.image_url === 'string' ? part.image_url : null)) : null;
      if (url && isHttpUrl(url)) {
        const dataUri = await urlToDataUri(url, options);
        content.push({ ...part, image_url: { ...part.image_url, url: dataUri } });
        changed = true;
        notes.push(`inlined ${redactHost(new URL(url))} as data URI`);
      } else {
        content.push(part);
      }
    }
    messages.push({ ...message, content });
  }

  return { request: changed ? { ...request, messages } : request, changed, notes };
}

module.exports = {
  urlToDataUri,
  inlineRemoteImages,
  hasImageContent,
  isDataUri,
  isHttpUrl,
  sniffMime,
  isPrivateHost,
  ImageFetchError,
  IMAGE_TYPES,
};
