# LaunchAI background worker (BullMQ consumer + autonomous warmup executor).
#
# Target platform: Fly.io (long-lived machine, stable egress IP).
# This image runs `tsx src/worker/index.ts` as a persistent process with NO
# inbound HTTP server — it only consumes jobs from Upstash Redis and talks out
# to Supabase / DeepSeek / Mosaiq Cloud.
#
# The browser itself runs remotely in Mosaiq Cloud pods (BROWSER_RUNTIME=mosaiq),
# so this image does NOT bundle Chromium — Playwright's browser download is
# skipped. (`chromium.connectOverCDP` connects to a remote pod and needs no
# local browser binary.)
#
# NOTE: the warmup/grooming code path imports `@mosaiq/cloud-sdk`. Until that
# package is published to npm and added to package.json (see
# docs/CLOUD-DEPLOYMENT.md Phase 0), this image can only run the launch-asset
# pipeline (URL -> marketing assets), which never imports the browser runtime.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# pnpm via corepack, pinned to the version in package.json#packageManager.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Dependency layer (cached unless the manifests change).
# devDependencies are required at runtime here (tsx, typescript), so we do
# NOT pass --prod.
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
# NODE_ENV=production above makes pnpm skip devDependencies; tsx lives there.
RUN pnpm install --frozen-lockfile --prod=false

# Application source.
COPY . .

# Background worker: no port to expose. Fly keeps the machine running.
CMD ["pnpm", "start:worker"]
