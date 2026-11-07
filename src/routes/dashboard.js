// src/routes/dashboard.js — GET /logs (HTML dashboard) and GET /api/logs (JSON).
//
// The original rendered the request log into HTML with template literals and no
// escaping, and the model name came straight from the request body — so any
// client could store `<img src=x onerror=...>` into the dashboard and have it
// execute in the operator's browser (confirmed by test). Every interpolation now
// goes through escapeHtml, the page ships a CSP that forbids inline handlers,
// and the dashboard can be turned off entirely with DASHBOARD_ENABLED=false.

'use strict';

const express = require('express');
const shared = require('../../shared');
const { ProxyError } = require('../errors');

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusClass(status) {
  if (status < 300) return 'status-2xx';
  if (status < 500) return 'status-4xx';
  return 'status-5xx';
}

const STYLE = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px; }
  h1 { font-size:22px; margin-bottom:6px; color:#f0f6fc; }
  .sub { color:#8b949e; font-size:12px; margin-bottom:18px; }
  .stats { display:flex; gap:14px; margin-bottom:20px; flex-wrap:wrap; }
  .stat-card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:14px 20px; min-width:110px; }
  .stat-card .num { font-size:26px; font-weight:600; color:#f0f6fc; }
  .stat-card .label { font-size:11px; color:#8b949e; margin-top:4px; text-transform:uppercase; letter-spacing:0.05em; }
  .stat-card.ok .num { color:#3fb950; }
  .stat-card.err .num { color:#f85149; }
  .models { display:flex; gap:8px; margin-bottom:20px; flex-wrap:wrap; }
  .model-tag { background:#21262d; border:1px solid #30363d; border-radius:4px; padding:4px 10px; font-size:12px; color:#8b949e; }
  .model-tag .c { color:#f0f6fc; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { text-align:left; padding:8px 10px; border-bottom:2px solid #30363d; color:#8b949e; text-transform:uppercase; font-size:11px; letter-spacing:0.05em; }
  td { padding:6px 10px; border-bottom:1px solid #21262d; vertical-align:top; }
  td.nowrap { white-space:nowrap; }
  tr:hover td { background:#161b22; }
  .status { display:inline-block; padding:1px 8px; border-radius:4px; font-weight:600; font-size:11px; }
  .status-2xx { background:#0e4429; color:#3fb950; }
  .status-4xx { background:#492808; color:#d29922; }
  .status-5xx { background:#490202; color:#f85149; }
  .model-name { font-family:'SF Mono','Cascadia Code','Fira Code',monospace; color:#79c0ff; word-break:break-all; }
  .dur { font-family:'SF Mono',monospace; }
  .tokens { color:#8b949e; }
  .error-msg { color:#f85149; font-size:11px; word-break:break-word; }
  .time { color:#484f58; font-size:11px; white-space:nowrap; }
  .badge { display:inline-block; padding:0 6px; border-radius:3px; font-size:10px; background:#1f2937; color:#8b949e; margin-left:4px; }
  .badge.retry { color:#d29922; }
  .footer { margin-top:18px; font-size:11px; color:#484f58; }
  .bar { height:4px; background:#f85149; color:#fec8d8; font-size:11px; padding:4px 10px; border-radius:4px; margin-bottom:16px; }
`;

function renderDashboard({ rows, stats, topModels, generatedAt, warnings }) {
  const warningBanner = warnings.length
    ? `<div class="bar">${warnings.map(escapeHtml).join(' &middot; ')}</div>` : '';

  const body = rows.map((e) => {
    const tokens = e.totalTokens ? `${e.promptTokens}&rarr;${e.completionTokens} (${e.totalTokens})` : '&mdash;';
    const badges = [
      e.stream ? '<span class="badge">stream</span>' : '',
      e.retries ? `<span class="badge retry">retried x${e.retries}</span>` : '',
      e.outcome && e.outcome !== 'ok' ? `<span class="badge">${escapeHtml(e.outcome)}</span>` : '',
      Number.isInteger(e.keyIndex) && e.keyIndex >= 0 ? `<span class="badge">key#${e.keyIndex + 1}</span>` : '',
    ].join('');
    return `<tr>
      <td class="time">${escapeHtml(e.timeLocal)}</td>
      <td class="nowrap"><span class="status ${statusClass(e.status)}">${e.status}</span></td>
      <td class="model-name">${escapeHtml(e.model)}${badges}${e.error ? `<br><span class="error-msg">${escapeHtml(e.error)}</span>` : ''}</td>
      <td class="dur nowrap">${escapeHtml(e.durationFmt)}</td>
      <td class="tokens nowrap">${tokens}</td>
      <td>${escapeHtml(e.endpoint)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="robots" content="noindex, nofollow">
<title>NIM Proxy &mdash; request log</title>
<style>${STYLE}</style>
</head>
<body>
<h1>NIM Proxy &mdash; request log</h1>
<div class="sub">last ${rows.length} of ${stats.buffered} buffered &middot; updated ${escapeHtml(generatedAt)} &middot; <a href="/api/logs" style="color:#58a6ff">JSON</a></div>
${warningBanner}
<div class="stats">
  <div class="stat-card"><div class="num">${stats.total}</div><div class="label">Requests</div></div>
  <div class="stat-card ok"><div class="num">${stats.total - stats.errors}</div><div class="label">Success</div></div>
  <div class="stat-card err"><div class="num">${stats.errors}</div><div class="label">Errors</div></div>
  <div class="stat-card"><div class="num">${stats.avgMs}ms</div><div class="label">Avg</div></div>
  <div class="stat-card"><div class="num">${stats.p95Ms}ms</div><div class="label">p95</div></div>
  <div class="stat-card"><div class="num">${stats.tokens}</div><div class="label">Tokens</div></div>
</div>
<div class="models">${topModels.map(([model, count]) => `<span class="model-tag"><span class="c">${count}</span> ${escapeHtml(model)}</span>`).join('')}</div>
<table>
<thead><tr><th>Time</th><th>Status</th><th>Model</th><th>Dur</th><th>Tokens</th><th>Endpoint</th></tr></thead>
<tbody>${body || '<tr><td colspan="6" style="color:#8b949e">No requests yet.</td></tr>'}</tbody>
</table>
<div class="footer">Buffer holds the last ${stats.buffered} requests in memory only. Nothing here is persisted.</div>
</body>
</html>`;
}

function createDashboardRouter(deps) {
  const router = express.Router();
  const { config, requestLog, keyPool, catalog } = deps;

  const warnings = () => {
    const out = [];
    if (config.corsOrigins === '*') out.push('CORS_ORIGIN=* — any website can call this proxy from a browser');
    if (config.rateLimitMax > 0) out.push(`rate limit active: ${config.rateLimitMax} req/${Math.round(config.rateLimitWindowMs / 1000)}s per client`);
    if (keyPool.size === 0) out.push('no NIM_API_KEY configured — /v1 requests will fail');
    return out;
  };

  router.get('/logs', (req, res, next) => {
    if (!config.dashboardEnabled) return next(new ProxyError('Dashboard disabled (DASHBOARD_ENABLED=false)', { status: 404 }));
    const limit = Math.min(Number(req.query.limit) || 100, config.requestLogSize);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderDashboard({
      rows: requestLog.recent(limit),
      stats: requestLog.stats(),
      topModels: requestLog.byModel(10),
      generatedAt: new Date().toISOString(),
      warnings: warnings(),
    }));
  });

  router.get('/api/logs', (req, res, next) => {
    if (!config.exposeInternalEndpoints) return next(new ProxyError('Internal endpoints disabled', { status: 404 }));
    res.json({
      stats: requestLog.stats(),
      uptimeSec: Math.round(process.uptime()),
      keys: keyPool.status(),
      catalogue: {
        models: catalog.size,
        ageMs: catalog.ageMs,
        lastError: catalog.lastError,
      },
      entries: requestLog.recent(Math.min(Number(req.query.limit) || 50, config.requestLogSize)),
    });
  });

  return router;
}

module.exports = { createDashboardRouter, escapeHtml, renderDashboard, CSP };
