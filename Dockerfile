# syntax=docker/dockerfile:1
# One image for the whole app: the Hono server answers /api and serves the built web app.

FROM node:24.22.1-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps

# Vite inlines VITE_* into the bundle at build time, so this key must be present here, not at runtime.
# Passed as a build secret so it stays out of the image history; it is a publishable Pollar key and ends up in the
# browser bundle anyway. Build with: docker build --secret id=VITE_POLLAR_API_KEY,env=VITE_POLLAR_API_KEY .
RUN --mount=type=secret,id=VITE_POLLAR_API_KEY,env=VITE_POLLAR_API_KEY,required=true \
    test -n "$VITE_POLLAR_API_KEY" && npm run build -w apps/web

# Bundle the server (and @nilo/core, which ships TypeScript sources) into one file so the runtime needs no node_modules.
RUN npx esbuild apps/server/src/index.ts --bundle --platform=node --format=esm --target=node24 \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=dist/server.mjs

FROM node:24.22.1-slim
WORKDIR /app
# TRUST_PROXY: the image runs behind Traefik, so the faucet's per-IP limit reads the client IP from X-Forwarded-For.
ENV NODE_ENV=production \
    PORT=5173 \
    STATIC_DIR=public \
    TRUST_PROXY=1

COPY --from=build /app/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/web/dist ./public

USER node
EXPOSE 5173
CMD ["node", "server.mjs"]
