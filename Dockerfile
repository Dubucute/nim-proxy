# syntax=docker/dockerfile:1

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="nim-proxy" \
      org.opencontainers.image.description="OpenAI-compatible proxy for NVIDIA NIM" \
      org.opencontainers.image.source="https://github.com/Dubucute/nim-proxy"

# curl is needed by the healthcheck; ca-certificates for TLS to NVIDIA.
RUN apk add --no-cache curl \
  && addgroup -S -g 10001 app \
  && adduser -S -u 10001 -G app app

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared.js server.js ./
COPY src ./src
COPY api ./api
COPY benchmark_data.json ./

# Never bake secrets into the image: .env is excluded by .dockerignore and the
# config refuses to start serving traffic without keys from the environment.
USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

# tini-style init so SIGTERM reaches node and drains connections.
ENTRYPOINT ["node", "server.js"]
