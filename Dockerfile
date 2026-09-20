FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY app ./app
COPY components ./components
COPY hooks ./hooks
COPY lib ./lib
COPY public ./public
COPY db ./db
COPY scripts ./scripts
COPY .openai ./.openai
COPY vite.config.ts next.config.ts middleware.ts tsconfig.json components.json ./
RUN npm run build:node && npm run build:worker

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/dist-node/standalone/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=20s --start-period=30s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]

FROM node:22-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist-worker/ ./dist-worker/
COPY --chown=node:node scripts/migrate.mjs scripts/sql.mjs scripts/bootstrap.mjs ./scripts/
COPY --chown=node:node db/ ./db/
USER node
CMD ["node","dist-worker/worker.mjs"]
