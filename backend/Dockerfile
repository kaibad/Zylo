# ---- Dependencies ----
FROM node:22.23-alpine3.24 AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- Production stage ----
FROM node:22.23-alpine3.24 AS production

# Security: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Security: remove unnecessary packages
RUN apk add --no-cache dumb-init=1.2.5-r4

WORKDIR /app

# Copy only production dependencies from Dependencies stage
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

# Security: own files by non-root user
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

# Security: use dumb-init for proper signal handling (PID 1 problem)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]