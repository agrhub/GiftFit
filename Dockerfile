# GiftFit on Cloud Run (owner: A8). Built remotely by Cloud Build: see deploy/README.md.
# Multi-stage: the runtime image holds only Next's standalone server, its traced node_modules,
# public/, .next/static and the files read from disk at runtime. No Playwright, no Chromium,
# no dev dependencies, no tests, no real face recordings.
#
# Run `npm run gate` (lint, typecheck, unit, build) before deploying; the image build skips the
# lint and type-check passes by default (SKIP_BUILD_CHECKS=1) to save Cloud Build minutes.

ARG NODE_IMAGE=node:22-slim

# ---- deps: full install (dev deps are needed by `next build`) ------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: next build with output: "standalone" -------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG SKIP_BUILD_CHECKS=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    GIFTFIT_SKIP_BUILD_CHECKS=${SKIP_BUILD_CHECKS}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build \
 && test -f .next/standalone/server.js \
 && test ! -d .next/standalone/node_modules/playwright-core \
 && test ! -d .next/standalone/fixtures/youcam/real

# ---- runtime -------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    GIFTFIT_DATA_DIR=/tmp/giftfit

# Next's standalone server and the traced node_modules (sharp included for next/image).
COPY --from=build --chown=node:node /app/.next/standalone ./
# Next does not copy these two into the standalone folder.
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Files read from disk at runtime. File tracing already includes them (next.config.ts); copying
# them explicitly means a tracing change can never drop the judge demo or the ingest snapshots.
COPY --from=build --chown=node:node /app/fixtures/youcam/ai-demo ./fixtures/youcam/ai-demo
COPY --from=build --chown=node:node /app/fixtures/youcam/images ./fixtures/youcam/images
COPY --from=build --chown=node:node /app/fixtures/youcam/*.json ./fixtures/youcam/
COPY --from=build --chown=node:node /app/fixtures/ingest ./fixtures/ingest
COPY --from=build --chown=node:node /app/packages/plugin/giftfit.js ./packages/plugin/giftfit.js

USER node
EXPOSE 8080
# server.js honours PORT (Cloud Run sets 8080) and HOSTNAME.
CMD ["node", "server.js"]
