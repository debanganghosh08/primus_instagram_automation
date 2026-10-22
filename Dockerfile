# comment-to-DM — production image.
#
# Multi-stage so the runtime image carries no TypeScript, no test runner and no
# dev dependencies. Node 20 LTS, which is what this service targets.
#
# The base tag is pinned to the Node 20 line. For a fully reproducible build,
# replace it with a digest once you have pulled it:
#   docker image inspect node:20-alpine --format '{{index .RepoDigests 0}}'
#   FROM node@sha256:<digest> AS build

# ---------- build ----------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install from the lockfile only, so the image is reproducible.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build


# ---------- runtime --------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# The migration runner reads these at boot.
COPY migrations ./migrations

# Run unprivileged. The `node` user ships with the image.
USER node

EXPOSE 3000

# The service's own health endpoint, which also checks the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run with `--init` (or `init: true` in compose) so PID 1 forwards SIGTERM and
# the graceful shutdown path actually runs on redeploy.
CMD ["node", "dist/index.js"]
