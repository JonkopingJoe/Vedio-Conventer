# ── Stage 1: install production dependencies ───────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime image ─────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Install FFmpeg (pinned to Debian's available version)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (respects .dockerignore)
COPY . .

# Runtime directories (volumes will be mounted here in compose)
RUN mkdir -p tmp data

# Run as non-root for security
RUN useradd -r -u 1001 -g root appuser \
 && chown -R appuser:root /app
USER appuser

EXPOSE 3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
