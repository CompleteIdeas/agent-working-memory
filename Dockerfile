# Multi-stage build for AgentWorkingMemory
# Lightweight deployment: ~200MB image, no GPU required

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ src/
RUN npx tsc

# Stage 2: Production
FROM node:20-alpine AS runner

WORKDIR /app

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

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:8400/health || exit 1

EXPOSE 8400

# Persist data and models
VOLUME ["/data", "/models"]

CMD ["node", "dist/index.js"]
