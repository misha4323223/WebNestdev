FROM node:26-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci

COPY . .
RUN npm run build

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/functions/worker.mjs ./server/dist/functions/worker.mjs
COPY --from=build /app/server/src/functions/preview-runtime.mjs ./server/dist/functions/preview-runtime.mjs
COPY --from=build /app/server/src/functions/preview-supervisor.mjs ./server/dist/functions/preview-supervisor.mjs
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/dist ./dist

EXPOSE 8787 8792

CMD ["node", "server/dist/index.js"]
