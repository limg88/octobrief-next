# Web and worker of Octobrief in one image, built from the root of the repository:
#   docker build -f deploy/Dockerfile -t octobrief-app .
# What enters the build context is in deploy/Dockerfile.dockerignore: no .env file, no data.
# Node 24 runs the TypeScript sources of the workspace as they are; only the web is built.
FROM node:24-bookworm-slim
ARG PNPM_VERSION=12.10.1
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=true
RUN npm install --global "pnpm@${PNPM_VERSION}" \
    && mkdir -p /app /data/blobs \
    && chown node:node /app /data/blobs
USER node
WORKDIR /app
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @octobrief/web build \
    && pnpm store prune
ENV NODE_ENV=production \
    PORT=3310 \
    BLOB_DIR=/data/blobs \
    RECIPES_DIR=/app/recipes \
    TEMPLATES_DIR=/app/templates
EXPOSE 3310
# The web by default; the worker, the migrations and the demo issuer override the command.
WORKDIR /app/apps/web
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3310"]
