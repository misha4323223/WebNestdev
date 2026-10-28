FROM node:26-bookworm-slim AS build
WORKDIR /app

# Номер сборки — не только в образе выполнения, но и в самом бандле: по нему открытая вкладка панели
# понимает, что на сервере уже другая версия, и перезагружает себя вместе с ассетами новой сборки
# (см. src/lib/app-build.ts). Vite подставляет в `import.meta.env` переменные с префиксом VITE_ из
# окружения сборки, поэтому достаточно ENV — конфигурация Vite не трогается. Тот же ARG объявлен в
# образе выполнения ниже: значения совпадают всегда, включая сборку без переданного SHA (unknown).
ARG GIT_SHA=unknown
ENV VITE_BUILD=${GIT_SHA}

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
# Сертификаты российского доверенного УЦ читаются из файлов рядом с кодом (server/certs). tsc их
# не копирует, поэтому в сборку и в образ они попадают отдельно: без них GigaChat
# и другие сервисы на этом УЦ падают на проверке TLS.
COPY server/certs ./server/certs

RUN npm run build

# Только production-зависимости. В образ не должны попадать vite, typescript, tsx и React:
# фронт уже собран в `dist`, сервер работает из `server/dist`, а каждый мегабайт здесь
# умножается на число хранимых версий образа.
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev

FROM node:26-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Какая сборка внутри образа. Workflow передаёт сюда SHA коммита, и /api/health отдаёт
# это значение — так выкатка (и человек) видят, действительно ли на ВМ новая версия,
# а не старая, оставшаяся после неудачного деплоя.
ARG GIT_SHA=unknown
ENV WEBNESTDEV_BUILD=${GIT_SHA}

# curl — чтобы дверь платформы можно было проверить изнутри контейнера, то есть там, где
# она существует (`docker compose exec webnestdev-server curl -s localhost:8787/api/health`).
# `docker` — только клиент: он говорит с демоном хоста через смонтированный сокет. Статический
# бинарник из официального `-cli` образа весит 43 МБ, тогда как пакет `docker.io` тянул 282 МБ
# вместе с containerd, runc и iptables, которые внутри этого контейнера никогда не запускаются.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker:29.9-cli /usr/local/bin/docker /usr/local/bin/docker

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/certs ./server/certs
# Docker-брокер едет в том же образе и запускается другой командой (docker-compose.yml). Так у него
# нет отдельного тега и отдельной выкатки: обновление и откат сервера возвращают обе части вместе.
COPY deploy/docker-broker ./deploy/docker-broker

# Браузер нужен только headless: сервер нигде не открывает окно (все запуски —
# `chromium.launch({ headless: true })`), поэтому полный Chromium (393 МБ) не ставится —
# хватает headless-shell (261 МБ). Системные библиотеки для него ставит `--with-deps`.
RUN npx playwright install --with-deps --only-shell chromium

EXPOSE 8787
CMD ["node","server/dist/index.js"]
