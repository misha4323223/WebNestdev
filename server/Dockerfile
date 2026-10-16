FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json ./
COPY server/package.json ./server/package.json
RUN npm install

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src

RUN npm run build

FROM node:22-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Какая сборка внутри образа. Workflow передаёт сюда SHA коммита, и /api/health отдаёт
# это значение — так выкатка (и человек) видят, действительно ли на ВМ новая версия,
# а не старая, оставшаяся после неудачного деплоя.
ARG GIT_SHA=unknown
ENV WEBNESTDEV_BUILD=${GIT_SHA}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist

RUN npx playwright install --with-deps chromium

EXPOSE 8787
CMD ["node","server/dist/index.js"]
