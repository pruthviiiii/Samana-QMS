# Three images from one build:
#   web     the Next.js standalone server: screens only, forwards /api to the API
#           service, holds no database or integration credential
#   api     the API service: the route table on a plain Node HTTP server, with
#           the Prisma client and the database pool; not published outside the
#           private network
#   worker  the scheduler: routing tick, deliveries and retention against the
#           database on two timers
# Runtime stages install production packages with --ignore-scripts because the
# Prisma client is generated during the build stage and bundled into dist-api.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY server ./server
COPY public ./public
COPY db ./db
COPY scripts ./scripts
COPY next.config.ts postcss.config.mjs proxy.ts instrumentation.ts tsconfig.json next-env.d.ts components.json ./
RUN npm run build:node && npm run build:api && npm run build:worker

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/dist-node/standalone/ ./
USER node
EXPOSE 3000
# Health goes through the proxy to the API, so it proves the whole chain.
HEALTHCHECK --interval=30s --timeout=20s --start-period=30s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production API_PORT=3001
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/dist-api/ ./dist-api/
COPY --chown=node:node scripts/migrate.mjs scripts/sql.mjs scripts/db.mjs scripts/bootstrap.mjs scripts/create-app-role.mjs ./scripts/
COPY --chown=node:node db/ ./db/
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=20s --start-period=30s CMD node -e "fetch('http://localhost:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist-api/api.mjs"]

FROM node:22-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/dist-worker/ ./dist-worker/
USER node
CMD ["node","dist-worker/worker.mjs"]
