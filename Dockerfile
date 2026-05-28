# Multi-stage build for AgentWorkingMemory
# Lightweight deployment: ~200MB image, no GPU required.
#
# Build provenance (cache-bust + visibility):
#   docker build --build-arg BUILD_REF=$(git rev-parse --short HEAD) \
#                --build-arg BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ) ...
# Railway: --build-arg BUILD_TIMESTAMP=$(date +%s) on every deploy
# guarantees a fresh image digest even when source content is bit-identical
# to a prior successful build (which can otherwise leave Railway thinking
# there's nothing to deploy and reporting "Deploy failed").

# Stage 1: Build
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ src/
RUN npx tsc

# Stage 2: Production
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# wget is needed for the HEALTHCHECK below; bookworm-slim doesn't include it.
# Installed in a single layer with apt-get clean to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite and models
RUN mkdir -p /data /models

# Environment
ENV AWM_PORT=8400
ENV AWM_DB_PATH=/data/memory.db
ENV NODE_ENV=production
# Models cache dir for @huggingface/transformers
ENV HF_HOME=/models

# --- Build provenance & cache-bust ---
# These ARGs are intentionally LAST so they don't invalidate the heavy
# upstream layers (npm ci, tsc) — only the final tiny layer changes per
# build, but the image content-hash always differs.
ARG BUILD_TIMESTAMP=unset
ARG BUILD_REF=unset
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV BUILD_REF=${BUILD_REF}
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"
LABEL org.opencontainers.image.revision="${BUILD_REF}"

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:8400/health || exit 1

EXPOSE 8400

# NOTE: We intentionally do NOT declare `VOLUME` here.
# Railway's builder rejects Dockerfiles with VOLUME directives
# (use Railway's own volume system via service config: mount /data).
# Other runtimes (docker compose, kubernetes) also handle volumes
# at the orchestrator layer — declaring VOLUME in the image only
# adds friction. The /data directory is created by `mkdir -p /data /models`
# above and is mounted at runtime by whichever orchestrator runs the image.

# Print build provenance at container start, then exec the server.
# `exec` chains PID-1 to node so SIGTERM/SIGINT from Railway/docker reach
# the app cleanly (graceful shutdown of ConsolidationScheduler, etc.).
CMD ["sh", "-c", "echo \"AWM build ${BUILD_REF} @ ${BUILD_TIMESTAMP}\" && exec node dist/index.js"]
