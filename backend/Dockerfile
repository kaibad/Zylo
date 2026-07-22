# ---------- Dependencies ----------
FROM node:22.23-alpine3.24 AS deps

WORKDIR /app

COPY package*.json ./

# Install only production dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---------- Production ----------
FROM node:22.23-alpine3.24 AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init=1.2.5-r4

# Create a dedicated non-root user with a fixed UID/GID
RUN addgroup -g 10001 -S appgroup && \
    adduser -S -D -u 10001 -G appgroup appuser

WORKDIR /app

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application files
COPY package*.json ./
COPY src/ ./src/

# Set ownership
RUN chown -R 10001:10001 /app

# Run as the non-root user
USER 10001:10001

EXPOSE 5000

# Start the application
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
