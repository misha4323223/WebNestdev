FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json ./
COPY server/package.json ./server/package.json
RUN npm install

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/dist ./dist

EXPOSE 8787

CMD ["node", "server/dist/index.js"]
