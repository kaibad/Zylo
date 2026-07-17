# Containerization Documentation

This document explains the Docker setup for the Zylo application, covering the frontend
container, the backend container, the Nginx configuration, the `.dockerignore` files, and
the Docker Compose orchestration. For each piece, the rationale, behavior, and mechanics
are described so the setup can be maintained or extended with full context.

---

## 1. Frontend Dockerfile (`frontend/Dockerfile`)

### What it does

This is a multi-stage build that produces a small, production-ready Nginx image serving a
built React application.

**Stage 1: Build stage**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci && npm cache clean --force
COPY . .
RUN npm run build
```

- `node:20-alpine` is used only to compile the frontend. Alpine keeps the base image small.
- `package*.json` is copied before the rest of the source code. This is a Docker layer
  caching technique: as long as dependencies do not change, Docker reuses the cached
  `npm ci` layer instead of reinstalling packages on every build, which significantly
  speeds up rebuilds.
- `npm ci` (instead of `npm install`) performs a clean, reproducible install strictly from
  `package-lock.json`, which is what you want in CI/CD and production builds.
- `npm run build` compiles the React app into static assets (typically output to `dist/`).

**Stage 2: Production stage**

```dockerfile
FROM nginx:1.27-alpine AS production
RUN rm -rf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
```

- The final image is based on `nginx:1.27-alpine`, not `node`. Node and the entire build
  toolchain are discarded after the build stage. Only the compiled static files and Nginx
  itself ship to production. This is the core benefit of a multi-stage build: a smaller
  attack surface and a smaller image (no Node runtime, no `node_modules`, no source code
  in the final artifact).
- The default Nginx config and default landing page are removed so nothing but the
  intended app and config is served.
- `COPY --from=build /app/dist ...` pulls only the compiled output from the first stage.

### Why port 8080 (and not 80)

```dockerfile
EXPOSE 8080
...
USER nginx
```

This is directly tied to running Nginx as a non-root user, which is a deliberate security
hardening decision.

- Ports below 1024 (including port 80, Nginx's traditional default) are "privileged ports"
  on Linux. Only the root user can bind a process to them. Since this container explicitly
  drops root privileges with `USER nginx`, the Nginx worker process is no longer allowed
  to bind to port 80.
- Port 8080 is an unprivileged port (above 1024), so the non-root `nginx` user can bind to
  it without issue.
- Running as non-root is a standard container security practice: if the Nginx process is
  ever compromised (for example, through a request-smuggling or path-traversal bug), the
  attacker does not get root inside the container, which limits what they can do (for
  instance, they cannot install packages, modify system files owned by root, or as easily
  escalate further).
- The external mapping back to standard port 80 is handled outside the container, in
  Docker Compose (`"80:8080"`), so end users still access the app over the conventional
  HTTP port even though the container itself listens on 8080 internally.

### Ownership and signal handling

```dockerfile
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid
```

Because the container will run as `nginx` (not root), every directory Nginx needs to
write to at runtime: the served files, its cache directory, its logs, and its PID file —
must be owned by that user in advance. Root can perform this `chown` during the image
build; the non-root user could not perform it later. This is why these ownership changes
happen before the `USER nginx` instruction switches the effective user for all subsequent
instructions and for the running container.

```dockerfile
CMD ["nginx", "-g", "daemon off;"]
```

`daemon off` keeps Nginx running in the foreground. Containers need their main process to
stay in the foreground; if Nginx were allowed to daemonize (its default behavior), the
foreground process would exit immediately and Docker would consider the container to have
stopped.

---

## 2. Backend Dockerfile (`backend/Dockerfile`)

### What it does

Also a multi-stage build, applied to a Node.js API backend.

**Stage 1: Dependencies**

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
```

- This stage exists solely to install dependencies. Isolating it means dependency
  installation is cached independently from any later source code changes.
- `--mount=type=cache,target=/root/.npm` uses BuildKit's cache mount feature: it persists
  npm's download cache between builds (separately from the Docker layer cache), so even
  when the dependency layer itself has to be rebuilt, npm does not need to re-download
  packages from the registry.
- `--omit=dev` excludes devDependencies (test runners, linters, type definitions, etc.),
  since none of that is needed to run the application in production. This reduces both
  image size and the number of packages that could carry vulnerabilities.

**Stage 2: Production**

```dockerfile
FROM node:20-alpine AS production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN apk --no-cache add dumb-init
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 5000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
```

- A dedicated `appuser`/`appgroup` is created rather than relying on any pre-existing
  non-root user, so the runtime privileges are scoped specifically to this application.
- Only `node_modules` (from the deps stage), `package*.json`, and the `src/` directory are
  copied into the final image: no build tooling, no test files, no `.git` history.
- `dumb-init` addresses the "PID 1 problem": in Linux containers, the process running as
  PID 1 has OS-level responsibilities it does not normally have (reaping zombie
  processes, correctly forwarding signals like `SIGTERM`/`SIGINT`). Node.js itself does not
  handle these responsibilities well when run directly as PID 1, which can cause containers
  to hang or ignore shutdown signals (for example, from `docker stop` or Kubernetes). By
  making `dumb-init` PID 1 and having it spawn `node`, signals are properly forwarded to
  the Node process and orphaned child processes are reaped correctly, allowing graceful
  shutdowns.
- Ownership is granted to `appuser` before the `USER appuser` switch, for the same reason
  described in the frontend section: root must perform the `chown` before privileges are
  dropped.
- Port 5000 is above 1024, so it can be bound without root privileges: no special
  handling is required here the way it was for port 80 vs 8080 on the frontend.

---

## 3. Nginx Configuration (`frontend/nginx.conf`)

```nginx
server {
    listen 8080;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://zylo-backend:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location ~ /\. {
        deny all;
        return 404;
    }
}
```

Line by line:

- `listen 8080;`: matches the `EXPOSE 8080` and `USER nginx` decision in the Dockerfile,
  explained above: Nginx runs as a non-root user and therefore cannot bind to a privileged
  port such as 80.
- `server_name _;`: a catch-all server name. This block responds to any hostname the
  request arrives with, which is appropriate here since routing to this container is
  handled by Docker Compose networking rather than by virtual-host based routing.
- `root` and `index`: point Nginx at the compiled React build output and its entry HTML
  file.
- The four `add_header` lines are baseline security headers:
  - `X-Frame-Options: SAMEORIGIN` prevents the site from being embedded in an `<iframe>`
    on another domain, mitigating clickjacking attacks.
  - `X-Content-Type-Options: nosniff` stops browsers from guessing ("sniffing") a
    response's MIME type, which prevents certain content-type confusion attacks (for
    example, a browser deciding to execute a file as JavaScript when it was served as
    plain text).
  - `X-XSS-Protection: 1; mode=block` enables legacy browser-level cross-site scripting
    filtering. It is largely superseded by Content-Security-Policy in modern browsers but
    is harmless to include for older clients.
  - `Referrer-Policy: strict-origin-when-cross-origin` limits how much of the current
    page's URL is leaked to other sites via the `Referer` header, reducing incidental
    information disclosure.
  - `always` ensures each header is added regardless of the response status code
    (including error responses), not just on 2xx responses.
- `location / { try_files $uri $uri/ /index.html; }`: this is the standard pattern for a
  Single Page Application. React handles routing client-side (for example with React
  Router), so if a request comes in for a path like `/dashboard/settings` that does not
  correspond to a real file on disk, Nginx falls back to serving `index.html` and lets the
  React app's router take over, rather than returning a 404.
- `location /api/ { proxy_pass http://zylo-backend:5000; ... }`: this is a reverse proxy
  block that forwards any request under `/api/` to the backend container. `zylo-backend`
  resolves via Docker's internal DNS to the backend service defined in Compose; this is
  what allows the frontend and backend to communicate without either being aware of the
  other's actual IP address.
  - `proxy_http_version 1.1` plus the `Upgrade`/`Connection` headers allow protocol
    upgrades (for example WebSockets) to pass through the proxy correctly; HTTP/1.0
    (Nginx's default proxy version) does not support these.
  - `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` preserve information
    about the original client request that would otherwise be lost once Nginx proxies the
    request onward. The backend can use these to log the real client IP, know whether the
    original request was HTTP or HTTPS, and see the original Host header.
  - `proxy_cache_bypass $http_upgrade` ensures upgraded connections are not served from
    cache.
- `location ~ /\. { deny all; return 404; }`: blocks any request for a dotfile (for
  example `.env`, `.git/config`, `.htaccess`) from being served. Returning 404 rather than
  403 avoids confirming to an attacker that a hidden file exists at that path.

---

## 4. `.dockerignore` Files

**`backend/.dockerignore`**

```
node_modules
.git
.github
.env
.env.*
coverage
logs
Dockerfile
README.md
```

**`frontend/.dockerignore`**

```
node_modules
dist
.git
.github
.vscode
.env
.env.*
Dockerfile
README.md
```

### Why this matters

- `.dockerignore` controls what gets sent to the Docker build context, and consequently
  what can end up baked into an image layer via a `COPY . .` instruction.
- `node_modules` is excluded because it is reinstalled fresh inside the container by
  `npm ci`; copying a host machine's `node_modules` in would risk platform-specific
  binaries (built for the host OS/architecture) ending up in a Linux container, causing
  runtime failures, and would also bloat the build context.
- `.env` and `.env.*` are excluded so that local secrets and environment-specific
  configuration never get copied into an image layer, where they could persist in image
  history and potentially be extracted later even if deleted in a subsequent layer.
- `.git` and `.github` are excluded because version control history and CI workflow
  definitions have no purpose inside a runtime image and would only increase its size and
  exposed surface.
- `dist` is excluded from the frontend context because it is a build artifact: it is
  generated inside the container by `npm run build`, not copied in from the host.
- `coverage` and `logs` (backend) are local development/test artifacts, not needed at
  runtime.
- Excluding `Dockerfile` and `README.md` themselves is a minor optimization; they play no
  runtime role in the image being built.

Overall effect: smaller, faster builds and a materially reduced risk of secrets or
irrelevant/host-specific files leaking into a production image.

---

## 5. Docker Compose (`docker-compose.yml`)

### PostgreSQL service

```yaml
postgres-db:
  image: postgres:16.14-alpine
  container_name: zylo-db
  restart: unless-stopped
  environment:
    POSTGRES_USER: zylo_user
    POSTGRES_PASSWORD: zylo_pass
    POSTGRES_DB: zylo_db
  ports:
    - "5432:5432"
  volumes:
    - pgdata:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U zylo_user -d zylo_db"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 10s
  tmpfs:
    - /tmp
    - /run
```

- `postgres:16.14-alpine` pins an exact, minimal-footprint image version rather than a
  moving tag like `latest`, so builds are reproducible over time.
- `restart: unless-stopped` means the database container automatically restarts after a
  crash or host reboot, unless it was deliberately stopped by an operator.
- `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` bootstrap the initial database and
  role on first startup. These are plaintext here for local/dev convenience; in a
  production environment these should come from Docker secrets, a `.env` file excluded
  from version control, or a secrets manager rather than being committed in plain text.
- `volumes: pgdata:/var/lib/postgresql/data` gives Postgres a named, persistent volume so
  data survives container recreation (`docker compose down` without `-v`, image updates,
  etc.). Without this, all data would be lost every time the container is removed.
- The `healthcheck` uses `pg_isready`, Postgres's own readiness-check utility, so Compose
  can determine not just that the container process is running, but that the database is
  actually able to accept connections. This backs the `depends_on: condition:
service_healthy` used by the backend service (see below).
- `tmpfs: [/tmp, /run]` mounts these directories as in-memory, ephemeral filesystems
  rather than writing them to the container's own writable layer or the host disk. This
  is a modest hardening/performance measure: temp files never persist and do not
  accumulate on disk.

### Backend service

```yaml
backend:
  build:
    context: ./backend
    dockerfile: Dockerfile
  container_name: zylo-backend
  restart: unless-stopped
  environment:
    PORT: "5000"
    DB_USER: zylo_user
    DB_PASSWORD: zylo_pass
    DB_HOST: postgres-db
    DB_PORT: "5432"
    DB_NAME: zylo_db
  expose:
    - "5000"
  depends_on:
    postgres-db:
      condition: service_healthy
  security_opt:
    - no-new-privileges:true
  read_only: true
  tmpfs:
    - /tmp
```

- `DB_HOST: postgres-db` uses the Compose service name as a hostname. Docker Compose
  creates an internal DNS entry per service on the shared network, so the backend can
  reach the database by service name without hardcoded IP addresses.
- `expose: "5000"` makes port 5000 reachable to other containers on the same Compose
  network (in this case, the frontend, via the Nginx reverse proxy), but does not publish
  it to the host machine. This is deliberate: the backend should only be reachable through
  the frontend's proxy, not directly from outside the Docker host.
- `depends_on: condition: service_healthy` makes Compose wait until Postgres's healthcheck
  passes (not merely until the Postgres container has started) before starting the
  backend. This avoids a race condition where the backend starts and immediately fails
  because the database is not yet ready to accept connections.
- `security_opt: no-new-privileges:true` prevents any process inside the container from
  gaining additional privileges beyond what it started with (for example, via a setuid
  binary), even though the container already runs as a non-root user by virtue of the
  Dockerfile's `USER appuser`. This is defense in depth.
- `read_only: true` makes the container's root filesystem read-only at the OS level. This
  means that even if an attacker achieves code execution inside the container, they cannot
  write to the filesystem, install tools, or modify application files at runtime. Since
  Node.js applications sometimes need a writable location for temporary files, `tmpfs:
/tmp` provides a small writable, in-memory exception to this rule.

### Frontend service

```yaml
frontend:
  build:
    context: ./frontend
    dockerfile: Dockerfile
  container_name: zylo-frontend
  restart: unless-stopped
  ports:
    - "80:8080"
  depends_on:
    - backend
  security_opt:
    - no-new-privileges:true
```

- `ports: "80:8080"` is where the port story concludes: standard HTTP port 80 on the
  Docker host is mapped to port 8080 inside the container, which is the unprivileged port
  the non-root Nginx process is actually listening on. End users hit the conventional port
  80; internally, the container satisfies the constraint that a non-root process cannot
  bind to a privileged port.
- `depends_on: [backend]` (a plain list, not a healthcheck condition) only waits for the
  backend container to have started, not for it to be fully ready. This is acceptable here
  because the frontend does not fail to start if the backend is briefly unavailable: API
  requests would simply fail until the backend is ready, which is a much lower-risk
  failure mode than the backend crashing outright without its database.

### Volumes

```yaml
volumes:
  pgdata:
    driver: local
```

Declares the named volume used by Postgres. Using the default `local` driver keeps data on
the Docker host's filesystem, managed by Docker rather than manually bind-mounted to a
specific host path.

---

## 6. Operational Commands

```bash
docker compose up -d
```

Builds (if needed) and starts all services in the background (detached mode).

```bash
docker logs --tail=100 zylo-backend
```

Shows the last 100 lines of logs from the backend container: useful for a quick check of
recent activity or errors without streaming the entire log history. (Note: the container
name is `zylo-backend`; a hyphen, not an equals sign, separates the words.)

```bash
docker compose down -v
```

Stops and removes all containers, networks, and: because of the `-v` flag: the named
volumes as well. This means `pgdata` is deleted and all database data is lost. Use this
only when a clean slate is genuinely intended (for example, wiping local dev data), not in
production.

```bash
docker compose up --build
```

Rebuilds images from the Dockerfiles before starting the containers, rather than reusing
previously built images. This is necessary after changing a Dockerfile, `nginx.conf`, or
application source code, since Compose does not automatically detect that a rebuild is
needed unless told to.

---

## Summary of Key Design Decisions

| Decision                                                  | Reason                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Multi-stage builds (frontend and backend)                 | Keeps build tooling and source out of the final image; smaller size, smaller attack surface          |
| Non-root users in both containers                         | Limits blast radius if a container process is compromised                                            |
| Nginx listens on 8080, not 80                             | Non-root processes cannot bind to privileged ports; host-side mapping restores port 80 for end users |
| `dumb-init` as PID 1 in backend                           | Correct signal handling and zombie process reaping for graceful shutdowns                            |
| `read_only: true` + scoped `tmpfs` on backend             | Prevents runtime filesystem tampering while still allowing necessary temp writes                     |
| `depends_on` with `service_healthy` for Postgres          | Prevents the backend from starting before the database can actually accept connections               |
| Backend only `expose`d, not `port`-published              | Backend is reachable only via the frontend's reverse proxy, not directly from the host network       |
| `.dockerignore` excluding `node_modules`, `.env*`, `.git` | Prevents secrets, host-specific binaries, and irrelevant history from leaking into image layers      |
| Security headers in `nginx.conf`                          | Baseline mitigation against clickjacking, MIME-sniffing, and referrer leakage                        |
