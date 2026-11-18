# Состояние production и оперативная память

Дата среза: **18.11.2026, 07:44 UTC**. Документ фиксирует факты, которые нельзя терять
между сессиями.
Секреты здесь не хранятся: только имена переменных, пути и способы проверки.

**Актуально на 18.11.2026, 16:39 UTC:** обе ноды включены, `node-1` — primary,
`node-2` — streaming standby; обе на сборке `457a1e923b92`. Deploy run `44347132678`
завершён успешно 18.11.2026, 16:39 UTC; публичный `/api/ready` и локальный health обеих нод
отдают `build=457a1e923b92aaa915933d01fbaf3f9204979e43`. Production работает в
`WEBNESTDEV_WORKSPACE_MODE=local`, `OWNER_ROUTING=1`; проекты на локальных каталогах.
Deploy синхронизирует override обеих нод; токен внутренней двери — общий
`NODE1_RUNNER_TOKEN`. В контейнер сервера передаются `CLIENT_DB_*`, но
`CLIENT_DB_ADMIN_URL` пока пуст, поэтому клиентская база выключена. Подробности — в
[`LOCAL_WORKSPACES.md`](LOCAL_WORKSPACES.md) и [`CLIENT_DATABASE_PLAN.md`](CLIENT_DATABASE_PLAN.md).

**Медиа (18.11.2026):** изображения и видео из `image.generate`, `net.download` и
диагностические снимки browser.* уходят в бакет; ассеты проекта локально не хранятся.
У `net.download` остаётся сетевой предел **50 МБ на файл** — для роликов больше нужна
потоковая загрузка.

**API-хост выкачен и проверен 18.11.2026, 07:20–07:44 UTC.** `api.nestdev.ru` резолвится в
NLB `178.236.27.102`, TLS — Let's Encrypt на `api.nestdev.ru` (до 16.02.2027). Внешние
проверки: `GET /bmg/api/products?limit=1` — 200, preflight `OPTIONS /bmg/api/orders` — 204
с CORS `*`, `POST /bmg/api/orders` — 201. В POST присланная цена `1` проигнорирована:
товар пересчитан в 8900, доставка 390, итого 9290; созданы тестовые заказы `BM-1811-4606`
и `BM-1811-3215`. `bmg` перепубликован (release `670169f8-942e-4c76-9337-8ba31e7a5414`):
HTML содержит `/_webnestdev/api-bridge.js`, мост ведёт на `https://api.nestdev.ru/bmg`,
статика через CDN отдаёт 200.

**Защита API-двери выкачена 18.11.2026, 07:43 UTC.** Per-IP лимит 120 запросов в минуту на
сайт, общий счётчик в PostgreSQL, `429` + `Retry-After`, preflight не считается. Подробности
и замер — в разделе 28.

**Post-deploy 17.11.2026, 21:12–21:44 UTC.** Живые функции: 11 вызовов через временно
опубликованный `bmg`, все 2xx; после opt-in `cache.ttlSeconds=60` — 1 miss, 2 HIT,
`hitRatio=0.667`; сайт возвращён в `draft`, тестовые релизы удалены. Медиа: `HEAD` 200,
`Range: bytes=0-1023` — 206, `Content-Range: bytes 0-1023/438251`. Заказ на origin:
201, присланная цена `1` проигнорирована, пересчитано `3900 × 2 = 7800`, доставка 390,
итого 8190. Полный отказ `node-1`: power OFF 21:32:35, `node-2` primary 21:35:23
(RTO ~75 с), запись в PostgreSQL и Gluster прошла; `node-1` вернулась, rejoin 21:38:27,
switchover primary обратно 21:39, rejoin `node-2` 21:39:52. Итог — исходная топология,
`node-1` primary / `node-2` standby.

**POST без CDN (выкачено и проверено 18.11.2026, 07:20 UTC).** CDN-ресурс `hosting` отдаёт
`405` (Angie) на POST `/api/promo` и `/api/orders`; на origin через NLB те же запросы —
200/201. В API CDN-ресурса нет поля `allowedHttpMethods`; по документации MWS POST/PUT по
умолчанию закрыты и включаются для юрлиц через поддержку. В консоли у ресурса `hosting` на
вкладке «Безопасность» этой опции нет. Поэтому сделан отдельный прямой хост:

- `api.nestdev.ru` — A-запись на NLB `178.236.27.102`, без CDN. Имя вынесено из
  `*.host.nestdev.ru`, потому что reg.ru не сохраняет A-запись под wildcard-CNAME
  (`api.host` периодически возвращался к CNAME на CDN); TLS выпускается on-demand;
- Caddy отправляет этот хост в `webnestdev-server:8792`; путь `/<slug>/api/...` сервер сам
  проверяет и снимает префикс, поэтому подделать slug через Host нельзя;
- ответы API-хоста получают CORS `*` и preflight `OPTIONS`; POST работает;
- при публикации сайта с функциями и заданном `HOSTING_API_HOST` в staging-релиз
  добавляется `/_webnestdev/api-bridge.js`, который переписывает относительные `/api`
  на API-хост. Манифест пересчитывается после вставки; исходники проекта не меняются;
- в production override обеих нод задано `HOSTING_API_HOST=api.nestdev.ru`.

DNS-запись в reg.ru: `A  api  -> 178.236.27.102`, TTL 300. `*.host` CNAME на CDN не
трогать. Важно: в reg.ru поле «Имя» относительное — полное `api.nestdev.ru` создаёт
`api.nestdev.ru.nestdev.ru`. Запись `api.host` под wildcard-CNAME reg.ru не удерживает:
авторитетные NS возвращают CNAME на CDN. Сайты с функциями нужно перепубликовать после
включения `HOSTING_API_HOST`, чтобы в их релизах появился мост. Ограничение: CSP сайта
должен разрешать `connect-src` на `https://api.nestdev.ru`; иначе браузер заблокирует
запрос.

**Ранее отмеченные исправления (вошли в `775d297`):** query передаётся объектом,
manifest функций — `0644`, `--restart` убран из functions-preview, в health добавлен
`previews.functions`, functions-preview разрешён правом `serverlessFunctions`.

**SSH-ключ агента:** `/tmp/nestdev-agent` (права `600`), в git не хранится. `/tmp` в workspace
эфемерный: после перезапуска файл нужно восстановить из защищённого источника
`~/.ssh/nestdev-agent-2026-11-13`, не печатая содержимое.

**17.11.2026, 20:53 UTC, нагрузочная проба:** `npm run load:check -- --url
https://nestdev.ru/api/ready --concurrency 20 --duration 15` — 776 запросов, 50,8 RPS,
p50 337,5 мс, p95 539,7 мс, p99 2481,7 мс, 0 ошибок, все 200. Это внешний путь через CDN/NLB,
а не доказательство ёмкости origin; для вывода о масштабе нужен повтор на `/api/products` и
сравнение до/после. Живого трафика функций после выкатки не было: `activity.functions.requests=0`,
поэтому кеш и инвалидация проверены unit-тестами и health-режимом, но не реальным вызовом.

**13.11.2026, доступ агента:** вход восстановлен без GitHub. Рабочий ключ —
`~/.ssh/nestdev-agent-2026-11-13` (копия `/tmp/nestdev-agent`), публичная часть установлена в
`/home/Misha/.ssh/authorized_keys` на `node-1`. Проверено: `hostname=webnestdev`,
`USER=Misha`, `SUDO=ok`. Старый `~/.ssh/nestdev-agent-new` оставлен как резерв.

## 1. Роли ВМ

| ВМ | Роль | Адрес | Текущее питание |
| --- | --- | --- | --- |
| `node-1` | production primary: API, Caddy, HAProxy, PostgreSQL primary, `node1-runner` | `10.0.0.4`, management `2.59.83.250` | `ON` |
| `node-2` | standby/worker: PostgreSQL streaming standby, API/Caddy/broker/runner, общий storage | `10.0.0.5`; внешний NAT динамический, читать из MWS API | `ON` — включена, streaming standby |

**На 17.11.2026, 15:32 UTC:** primary PostgreSQL — `node-1`; `node-2` включена и работает
streaming standby (`pg_is_in_recovery()=t`, лаг ~1 мс). На обеих нодах доступен `runsc`,
`/api/ready` отвечает сборкой `960b983`, Gluster видит по два brick'а на каждом томе.
Целевой production — две включённые ноды; текущий режим уже двухнодовый.

**Не включать и не повышать `node-2`, пока `node-1` не жива и не является primary:** иначе
контроллер `node-2` может повысить её и получится два primary. После включения она должна
стартовать standby, а не primary.

`node-2` — **не тестовая и не одноразовая машина**. Это вторая нода production-контура;
её PostgreSQL, storage, runner и env-файлы — production-конфигурация, а не тестовая
заготовка. На 17.11.2026, 15:32 UTC она включена и работает standby.

Правило работы:

1. На 17.11.2026, 15:32 UTC `node-1` — primary, `node-2` — включённый standby; HA-проверки
   TLS, domain/preview failover и плановый switchover остаются отдельными задачами.
2. Доводить задачу до конца, не выключая работающую ВМ в середине.
3. Перед production-запуском проверить standby `node-2` и выполнить плановый переезд primary
   на неё по [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md).
4. Питание менять только по явной просьбе пользователя; после выключения проверять MWS
   `power=OFF`.
5. После production-HA `node-2` работает постоянно; это фиксируется отдельным решением.

Production не должен зависеть от базы или storage одной ноды как от единственного
экземпляра; после выкатки это проверяется падением `node-1`.

## 2. Текущая production-сборка

- Публичный адрес: `https://nestdev.ru`.
- `GET /api/ready` отвечает `ok:true`.
- Текущая production-сборка на обеих нодах: `457a1e923b92aaa915933d01fbaf3f9204979e43` —
  коммит `457a1e9` в `main` (`feat(client-db): передать настройки пилота в контейнер сервера`).
- Образ: `ghcr.io/misha4323223/webnestdev:sha-457a1e923b92` — собран и опубликован
  workflow `deploy` (run `44347132678`).
- Выкачена 18.11.2026, 16:39 UTC на `node-1` и `node-2`; `GET /api/ready` на обеих нодах
  и на `https://nestdev.ru/api/ready` отдаёт `build=457a1e923b92aaa915933d01fbaf3f9204979e43`,
  deploy run — success.
  Предыдущая сборка `1a7e994` (run `44342600200`) осталась в истории.
- Перед ней в тот же день выкачена AI-сборка `d14676f` (run `43704849397`); все `AGENT_*`
  флаги на обеих нодах выключены, reviewer и остальные экспериментальные ветки не активны.
- Исправление: локальный кэш зависимостей передаётся Docker с флагом `-v`; без него
  установка падала с `invalid reference format`. Флаг проверен на живой установке
  зависимостей проекта `9ad6af70…` на `node-1`. Код также включает hybrid fallback,
  отдельный лимит hybrid/общий бюджет ноды, static-only панель preview и трёхминутный
  idle для Docker/hybrid (static — пятнадцать минут); подробности — в разделе 20 и
  [`HYBRID_PREVIEW.md`](HYBRID_PREVIEW.md).
- Прод работает на базе `node-1`; `node-2` включена и является streaming standby
  (`pg_is_in_recovery()=t`, лаг ~1 мс), поэтому PostgreSQL failover доступен. Аварийное
  переключение 12.11.2026 описано в разделе 19.
- NLB `webnestdev-nlb-main` — публичный ingress; DNS при переключении не меняется. Локальный
  API `node-1` отвечает `200`; публичный `https://nestdev.ru` и `/api/ready` — `200`.

## 2.1. Custom domains: инфраструктура выкачена, feature flag включён

- 13.11.2026 custom domains этапов 1–3 выкачены на `node-1`; на 18.11.2026, 07:44 UTC текущая
  сборка обеих нод — `db53447` (run `44259985492`, образ `sha-db534474f381`).
- Живой Caddy: `src-caddy-1` на обеих нодах, image `caddy:2.11.8-alpine`, version `v2.11.8`.
- Сертификаты перенесены из `src_caddy-data` в общий
  `/var/lib/webnestdev/data/caddy-data`; старые сертификаты на месте, `https://nestdev.ru` и
  `/api/ready` отвечают `200`. Резервная копия старого тома сделана до выкатки.
- `custom-domains.caddy` лежит в `/var/lib/webnestdev/data/caddy-custom`; Caddy читает его
  read-only. `webnestdev-caddy-reload.timer` active/enabled на обеих нодах; автоматический
  validate/reload после изменения файла проверен вручную на `node-1`, на `node-2` установлен
  выкаткой 14.11.2026.
- В PostgreSQL создана `public.webnestdev_site_domains` (префикс `getTable`); 2 строки —
  `nestdevtest.ru` (apex, canonical) и `www.nestdevtest.ru`, обе `active`,
  `certificate_status=active`.
- `/api/tls-ask` разрешает custom domains в `configuring`/`issuing_certificate`/`active`;
  TLS-активация проверяет сертификат через NLB IP с SNI и переводит домен в `active`.
- `CUSTOM_DOMAINS_ENABLED` включён (`1`) на обеих нодах; карточка «Свой домен» видна в
  панели на вкладке «Хостинг». 14.11.2026 подключён тестовый домен `nestdevtest.ru`
  (apex + `www`); TXT/A/CNAME настроены, проверка ждёт публикации делегирования `.ru`.
- `custom.nestdev.ru` → `178.236.27.102` (A, TTL 3600) — target для CNAME/apex готов.
- `nestdevtest.ru` (reg.ru, NS `ns1/ns2.reg.ru`): `A @` → `178.236.27.102`,
  `CNAME www` → `custom.nestdev.ru`, `TXT _nestdev-verify` и `TXT _nestdev-verify.www` с одним
  токеном. Публичные резолверы и API обеих нод пока получают `NXDOMAIN` на весь домен:
  реестр `.ru` ещё не опубликовал делегирование (serial `4071096` не менялся).
- 14.11.2026 UI custom domains исправлен: имена записей показываются относительно зоны
  (`_nestdev-verify`, `_nestdev-verify.www`, `@`, `www`), полное имя — в подсказке. Причина:
  reg.ru сам дописывает домен, и FQDN в поле «Имя» давал
  `_nestdev-verify.nestdevtest.ru.nestdevtest.ru` (`3bb0714`).
- `host.nestdev.ru` — bare CNAME target; TLS-ошибка на нём ожидаема и не является ошибкой
  custom domains (wildcard `*.host.nestdev.ru` не покрывает bare-имя).
- `node-2` включена 14.11.2026; выкатка `43644567616` доставила ей актуальные compose/Caddy
  и reload-таймер, обе ноды работают на `3bb0714`. Общий Gluster `caddy-data`, блокировки Caddy
  и HA-переключение custom domains ещё не проверены.
- Проверки: CI/deploy `43644567616` — success; сборка `3bb0714` на обеих нодах;
  предыдущая полная проверка — `npm test` сервера 1828 тестов, 0 fail, 10 skip;
  `tsc` server/frontend — 0; `npm run build` — ok; Caddy 2.11.8 `Valid configuration`.
- Первая выкатка `ecbc9d6` упала на `ERR_MODULE_NOT_FOUND: tldts`; deploy откатил API на
  предыдущую сборку, затем Dockerfile был исправлен (`5551969`). Не удалять вложенные
  зависимости `server/node_modules` из production-образа.

## 3. Env-файлы

### `node-1`

- Основной файл: `/home/Misha/webnestdev/src/.env`.
- Права `600`.
- Compose-проект использует его для API, runner и HA-override.
- `NODE2_PG_PASSWORD` уже записан фактическим значением роли `webnestdev` на `node-2`.
- `WEBNESTDEV_RUNNER_TOKEN` и `NODE1_RUNNER_TOKEN` совпадают с токеном `node1-runner`.

### `node-2`

Здесь **нет основного `.env`**, и создавать его пустым нельзя. Compose использует два файла:

- `/home/ubuntu/webnestdev/src/runtime.env`
- `/home/ubuntu/webnestdev/src/node2.env`

Это подтверждается меткой контейнера:

```text
com.docker.compose.project.environment_file=
  /home/ubuntu/webnestdev/src/runtime.env,
  /home/ubuntu/webnestdev/src/node2.env
```

Не копировать `.env.bak` и не создавать новый `.env`: остальные настройки второй ноды
уже лежат в `runtime.env` и `node2.env`, включая `NODE2_PG_PASSWORD`.

Оба файла должны содержать `WEBNESTDEV_RUNNER_TOKEN` и `NODE1_RUNNER_TOKEN` с тем же
значением, что и `node2-runner`. Секреты не печатать и не коммитить.

## 4. Runner-токен

- Контейнеры: `node1-runner` на `node-1`, `node2-runner` на `node-2`.
- API читает `WEBNESTDEV_RUNNER_TOKEN`; HA-override также использует `NODE1_RUNNER_TOKEN`.
- Токены `node1-runner`, `node2-runner`, API на `node-1` и API на `node-2` должны совпадать.
- На момент среза совпадение проверено, длина каждого токена — 64 символа.
- Скрипт синхронизации: `deploy/scripts/vm-deploy.sh`, режим `MODE=token`.
- Режим не перезапускает сервис; после записи API нужно перезапустить штатным compose,
  если он уже работает.

На `node-1`:

```bash
ssh node1 'MODE=token bash -s' < deploy/scripts/vm-deploy.sh
```

На `node-2` нужно явно передать **оба** env-файла:

```bash
ssh node2 'MODE=token APP_DIR="$HOME/webnestdev/src" ENV_FILE="$HOME/webnestdev/src/runtime.env" bash -s' \
  < deploy/scripts/vm-deploy.sh
ssh node2 'MODE=token APP_DIR="$HOME/webnestdev/src" ENV_FILE="$HOME/webnestdev/src/node2.env" bash -s' \
  < deploy/scripts/vm-deploy.sh
```

Если в логе появилось `.../.env нет — RUNNER_TOKEN не синхронизирую`, выбран не тот файл:
на `node-2` это должны быть `runtime.env` и `node2.env`.

## 5. `NODE2_PG_PASSWORD`

- Это фактический пароль роли `webnestdev` на PostgreSQL `node-2`, а не заглушка.
- Значение уже записано в `/home/Misha/webnestdev/src/.env` на `node-1`.
- На `node-2` оно лежит в её compose env-файлах.
- `docker compose -f docker-compose.yml -f docker-compose.override.yml config --quiet`
  на `node-1` проходит без ошибки о missing value.
- Значение не выводится в чат и логи.

Для будущей ротации/переноса используется режим `MODE=pg-password`:

```bash
ssh node1 'MODE=pg-password PG_PASSWORD_FILE=/tmp/node2-pg.secret bash -s' \
  < deploy/scripts/vm-deploy.sh
```

`PG_PASSWORD_FILE` — временный файл с правами `600`; скрипт читает его, обновляет
`NODE2_PG_PASSWORD` в env, удаляет временный файл и не печатает значение. Режим не
перезапускает сервис.

После записи проверять только результат, не значение:

```bash
ssh node1 'cd "$HOME/webnestdev/src" && docker compose \
  -f docker-compose.yml -f docker-compose.override.yml config --quiet && echo compose-ok'
```

## 6. Деплой

- GitHub Actions деплоит `node-1` (`deploy/scripts/vm-deploy.sh`), затем шаг
  `Deploy to node-2 over SSH` запускает на `node-1` `deploy/scripts/node2-sync.sh`: образ
  передаётся на `node-2` по SSH (`docker save | ssh | docker load`, GHCR ей отвечает
  `unauthorized`), обновляются `docker-compose.yml`/`Caddyfile`/`preview-tls.caddy`,
  пересоздаются API и брокер с `--no-deps`, гасится legacy postgres, проверяются `/api/ready`
  и сборка. По умолчанию `SYNC_NODE2=1`: недоступная `node-2` — ошибка выкатки, а не зелёный
  статус; `SYNC_NODE2=0` — только осознанный одиночный режим.
- В той же выкатке HA-код из `deploy/ha/runtime-files.txt` устанавливается в
  `/opt/webnestdev-ha` на **обеих** нодах, SHA-256 сверяется после копирования, а
  failover-контроллеры перезапускаются только при изменении файлов/unit'ов или если сервис
  не active. Ошибка установки или несовпадение SHA — ошибка выкатки.
- Runner обновляется автоматически на обеих нодах (`deploy/scripts/update-runner.sh`): раньше
  он оставался на прежней сборке, пока сервис уже работал на новой. С 13.11.2026 скрипт
  также гарантирует локальный каталог кэша, bind-mount и переменные `WEBNESTDEV_PREVIEW_CACHE_*`
  и пересоздаёт runner, если образ тот же, а конфигурация кэша неполная.
- `MODE=image` больше не поднимает legacy `postgres` из базового compose: с production
  override `up` идёт с `--no-deps`, а запущенный контейнер останавливается после выкатки.
- Полный деплой на `node-2` вручную по-прежнему возможен (`vm-deploy.sh` на ней), но штатный
  путь — шаг workflow выше.
- `MODE=token` и `MODE=pg-password` только пишут env и не перезапускают сервис.
- `MODE=housekeeping` (и тот же шаг в конце image-выкатки на обеих нодах) ротирует логи
  хоста: journald ограничен `SystemMaxUse=200M`, для `/var/log/glusterfs` ставится
  `logrotate` (50 МБ × 2). Данные проектов и бэкапы не трогаются.
- Сервер раз в час убирает каталоги в `SANDBOX_DIR`, для которых нет проекта в базе
  (порог `SANDBOX_GC_HOURS`, по умолчанию 24 ч; `SANDBOX_GC_DRY_RUN=1` — только показать,
  `SANDBOX_GC_ENABLED=0` — выключить). Служебные каталоги и `.project-backup-*`
  (страховочная копия прежней папки при восстановлении) не удаляются никогда.
- `MODE=image` — полная выкатка образа; не использовать его только ради env-синхронизации.
- В image-режиме на `node-1` токен runner синхронизируется автоматически.
- Для `node-2` учитывать её отдельные env-файлы из раздела 3 (`runtime.env` + `node2.env`).
- **Image-deploy не обновляет HA-скрипты.** `/opt/webnestdev-ha` ставится отдельно через
  `deploy/ha/install-node1.sh` и `install-node2.sh`. Если на ВМ остался старый checkout,
  установка из него вернёт контроллер без `switchover.py`/`control.py`. После изменений в
  `deploy/ha` скопировать актуальный каталог на обе ВМ и перезапустить оба failover-юнита;
  проверка — раздел 11.

## 7. Что проверять после работ с `node-2`

1. MWS: фактическое `status.hardware.power`. На 12.11.2026 после обратного прогона — `OFF`.
   Включать только под конкретную работу и по явной просьбе; после выключения проверять
   `power=OFF`.
2. SSH к `10.0.0.5` (через `node-1`) и `node2-runner` отвечают, пока узел в строю.
3. `node-1`: `/api/ready` = `200`.
4. Токены `node-1` и `node-2` совпадают, если обе ВМ использовались.
5. `docker compose config --quiet` на `node-1` проходит.
6. Прод не смотрит на базу/storage только на `node-2`.

## 8. Чего не делать

- Не называть `node-2` тестовой машиной и не откладывать её production-настройку как
  «тестовую заготовку».
- Не выключать `node-2` в середине работы: сначала завершить задачу, потом выключить.
- Не создавать пустой `.env` на `node-2` и не копировать `.env.bak`.
- Не ставить заглушку в `NODE2_PG_PASSWORD`.
- Не читать и не печатать `.env`, пароли и токены.
- Не переводить прод на базу/storage, которые живут только на выключенной `node-2`.
- Не оставлять `node-2` включённой без production-решения, но и не выключать её до
  завершения текущей задачи.

## 9. Двухнодовый тест 10.11.2026

Проверено на реальных ВМ при включённой `node-2`, без выключения прод-базы:

- `node-2` обновлена до production-образа `ghcr.io/misha4323223/webnestdev:sha-af837ac1659f`
  (build `af837ac1659f32154c7936646dacc23ab7a6b4af`); API и `node2-runner` отвечают,
  PostgreSQL — streaming standby от `10.0.0.4`. Синхронизация `node-2` из workflow появилась
  после этого прогона, поэтому здесь она ещё выкатывалась вручную.
- NLB `webnestdev-nlb-main` видит оба бэкенда (`tcp:80`, `tcp:443`) в состоянии `OK`.
- При нагрузке на `node-2` новый проект A размещён на `node-1`; terminal на `node-1`
  выполнился (`node v26.13.0`).
- При нагрузке на `node-1` новый проект B размещён на `node-2`; terminal через runner
  `node-2` выполнился, preview-контейнер на `node-2` открывался через Caddy **обеих** ВМ.
- После снятия нагрузки с `node-1` (и при нагрузке на `node-2`) новый проект C снова
  размещён на `node-1`; terminal и preview на `node-1` работают. То есть освободившаяся ВМ
  снова принимает проекты, а не остаётся «выключенной из размещения».
- В `docker-compose.override.yml` на `node-1` добавлен
  `WEBNESTDEV_NODE_ADDRESS: 10.0.0.4:8790` (бэкап `.bak-20261110b`), чтобы API на `node-2`
  мог исполнять проекты, привязанные к `node-1`. Compose config проходит, API пересоздан,
  `/api/ready` = `200`, публичный `https://nestdev.ru/api/ready` = `200`.
- `deploy/ha/failover.py` исправлен: после перезагрузки поднимаются не только API, но и
  broker/Caddy с `restart=no` (`all_services_running`). 6 unit-тестов проходят; файл
  установлен на обе ВМ, сервисы active.
- 10.11.2026 на обе ВМ установлен полный актуальный `deploy/ha`, включая `switchover.py` и
  `control.py`; подробности, live switchover и холодный старт — в разделе 11.

Историческое ограничение preview при двух репликах (исправлено 10.11.2026, см. §10):
контейнерный preview, запущенный **локальным** API
на `node-1`, хранит прямой адрес Docker-моста (например, `172.21.0.4:3000`) и не открывает
relay runner'а. Через Caddy `node-1` он работает, через Caddy `node-2` — нет. Preview,
запущенный на `node-2` через runner, открывает relay и доступен с обеих ВМ. Static-preview
по-прежнему живёт в процессе API (слушатель на `127.0.0.1`) и намеренно не пишется в общий
реестр, поэтому вторая реплика о нём даже не знает. Это ограничение только preview; API,
PostgreSQL, terminal и размещение проектов работают на обеих ВМ.

Как это выглядит в жизни (10.11.2026, 09:34 UTC): пользователь запустил preview проекта
«Крот» (`3a6cb9b5-…`, pinned `node-1`) через API на `node-1`; terminal работал, а публичный
адрес то открывался, то отдавал «Предпросмотр недоступен» — NLB направлял iframe то на
дверь `node-1` (она видит контейнер), то на дверь `node-2` (до `172.21.0.4` из другой
Docker-сети не доходит). После выключения `node-2` в 09:36 весь трафик пошёл на `node-1`,
и preview сразу начал отображаться. Это не сбой приложения и не потеря данных: агент видел
приложение, потому что его проверки шли через узел-владелец/runner.

Реализованное 10.11.2026 направление: дверь-не-владелец проксирует запрос на приватную
дверь владельца, а owner-адрес хранится в общем реестре и для container, и для static.
Локальный runner-relay для этого не понадобился; подробности и проверка — в §10.

После теста временный пользователь, проекты A/B/C, preview-контейнеры, ballast и
`/var/lib/webnestdev/data/ha-test` удалены; в базе снова 18 проектов (`node-1` — 3,
`node-2` — 15). `node-2` выключена, MWS `power=OFF`.

## 10. Cross-replica preview: исправление 10.11.2026

Причина: публичная дверь (порт `8788`) каждой реплики получает запросы от NLB, но запись
preview хранила только адрес контейнера в Docker-сети (`172.21.0.4:3000`). Дверь `node-2`
не могла дойти до Docker-моста `node-1`, поэтому один и тот же публичный адрес то работал,
то отдавал «Предпросмотр недоступен». Static-preview вообще не сохранялся в общий реестр:
его слушатель живёт на `127.0.0.1` внутри конкретного процесса API.

Что изменено в коде (рабочее дерево, без коммита):

- `PreviewState`/`PreviewStatus` и общая таблица preview получили `owner_address`.
  Миграция `ensure_preview_table` добавляет колонку и разрешает `mode IN ('container','static')`.
- Для контейнера owner — приватная дверь узла контейнера (`10.0.0.4:8788` или
  `10.0.0.5:8788`); для static — дверь процесса, который держит слушатель.
- Дверь, не являющаяся владельцем, проксирует HTTP и WebSocket (включая HMR) на дверь
  владельца по приватной сети, сохраняя публичный `Host`, cookie и тело запроса
  (`server/src/preview/peer-door.ts`). Ticket/cookie проверяются на обеих дверях.
- Static теперь пишется в общий реестр с owner-адресом, поэтому вторая реплика о нём знает.
- `deploy/node1` и `deploy/node2` публикуют `8788` только на приватный IP ВМ:
  `10.0.0.4:8788:8788` и `10.0.0.5:8788:8788`.
- Обе ВМ получили `WEBNESTDEV_NODE_ADDRESS` (`10.0.0.4:8790` / `10.0.0.5:8790`), чтобы
  owner-адрес определялся и при локальном запуске.

Проверено в production 10.11.2026 (временный пользователь и проект удалены после теста):

- Контейнерный preview проекта на `node-1`: `host=172.21.0.4`, `ownerAddress=10.0.0.4:8788`;
  запрос через дверь `node-2` с публичным Host и ticket вернул HTML приложения и вставил
  pick-bridge. Это исходный сценарий бага — теперь он работает.
- Контейнерный preview проекта на `node-2`: `ownerAddress=10.0.0.5:8788`; запрос через
  дверь `node-1` вернул приложение.
- Static-preview на `node-2`: `host=127.0.0.1`, `ownerAddress=10.0.0.5:8788`; запрос через
  дверь `node-1` вернул статическую страницу. Static-строка при этом видна в общем реестре.
- Обе приватные двери доступны в обе стороны (`10.0.0.4:8788` ↔ `10.0.0.5:8788`).
- `/api/ready` на обеих ВМ и `https://nestdev.ru/api/ready` отвечают `200`.
- Реальные preview-строки, появившиеся во время выкатки, уже содержат `owner_address`
  (`node-1`, container и static); их не удаляли.

Известное ограничение, не относящееся к preview: при ручном переносе проекта между узлами
каталог общего sandbox может оказаться созданным от `root`, и API на другой ВМ не сможет
сделать `chmod` (`EPERM`). Это вопрос общего storage/владельца каталога, а не cross-replica
двери; для production-HA его нужно закрыть отдельно.

После проверки `node-2` выключена, MWS `power=OFF`; публичный прод продолжает работать
через `node-1`.

Важно до штатной пересборки: hotfix-образ существует только локально на обеих ВМ и не
запушен в GHCR. Перезагрузка ВМ безопасна — Docker поднимет уже созданный контейнер с этим
образом. Но `docker compose up` без `WEBNESTDEV_IMAGE=webnestdev:preview-owner-20261110`
вернёт старый `sha-30b7bf876c1e`, а на `node-2` compose нужно запускать с её env-файлами
`runtime.env` и `node2.env` (см. §3). После коммита и сборки в CI заменить образ штатным.

## 11. HA-код и live-проверка 10.11.2026

Проверено на рабочей паре; прод в это время обслуживался через NLB.

- На `node-1` и `node-2` установлен актуальный `deploy/ha` из рабочего дерева. Резервные
  копии прежних каталогов: `/opt/webnestdev-ha.bak-20261110112118` на `node-1` и
  `/opt/webnestdev-ha.bak-20261110112139` на `node-2`.
- На обеих ВМ есть `/opt/webnestdev-ha/switchover.py` и `control.py`, на каждой ВМ свой
  failover-юнит active, `HA_CONTROL_PATH=/var/lib/webnestdev/data/ha-switchover.json`,
  `HA_SWITCHOVER_TIMEOUT_SECONDS=180`.
- Плановый switchover `node-1 → node-2` 10.11.2026: `target_ready` в 11:24:12 UTC,
  `source_stopped` в 11:24:28, `promoted` в 11:24:32. `node-2` стала primary, API и Caddy
  ответили `200`, запись в PostgreSQL проверена временной таблицей; `node-1` продолжила
  отдавать API через primary `node-2`.
- Rejoin `node-1` выполнен в 11:26:25 UTC: `pg_is_in_recovery()=t`,
  `pg_stat_wal_receiver.status=streaming`, отставание `replay_lsn` нулевое.
- Обратный плановый switchover `node-2 → node-1` в 11:27:09–11:27:24 UTC вернул primary на
  `node-1`; `node-2` продолжила API через `node-1`.
- Rejoin `node-2` выполнен в 11:28:00 UTC: standby `t`, `streaming` от `10.0.0.4`;
  `pg_stat_replication` на `node-1` показывает `17/main|streaming|async`.
- Холодный старт `node-2` после rejoin проверен: MWS `power=ON` в 11:31 UTC, автоматически
  поднялись `postgresql@17-main` (standby), `webnestdev-failover-node2`, broker/API/Caddy и
  `node2-runner`; `/api/ready` и Caddy — `200`, `SANDBOX_RUNTIME=runsc`,
  `BROKER_RUNTIME=runsc`, Docker видит `runsc`.
- Публичный `https://nestdev.ru/api/ready` и `/` — `200`; `node-1` primary, `node-2`
  standby.
- После проверки `node-2` выключена; MWS подтвердил `power=OFF`.

**Повторный destructive-прогон 10.11.2026.** Выполнен на текущем `deploy/ha` с реальным
`power=OFF` в обе стороны, но с временным `cluster.quorum-type=none`: текущий код не
размораживает Gluster после потери peer. Это тестовый обход, а не штатное поведение.

- `node-1` → `node-2`: power-off начат 13:32:29 UTC, подтверждён 13:33:43; `suspect`
  13:34:07, fencing/promotion 13:35:06–07; API `200` 13:35:16, публичный сайт `200`
  13:35:21. RTO 1 мин 38 с от подтверждённого отказа.
- `node-2` → `node-1`: power-off начат 13:53:06, подтверждён 13:54:34; `suspect`
  13:54:53, fencing/promotion 13:55:39–40; API `200` 13:55:54 (один краткий `502`
  в 13:55:48). RTO 1 мин 20 с.
- После promotion: 18 проектов, 5 сайтов, запись временной таблицей проходит; сайты
  `my-furniture.host.nestdev.ru` и `my-sayt.host.nestdev.ru` — `200`. Rejoin обоих узлов
  дал streaming standby с нулевым лагом.
- Финальное состояние: `node-1` primary, `node-2` standby; при обоих включённых узлах
  `quorum-type=auto`, после выключения `node-2` — `none` (единственный узел), публичный
  `ready=200`; MWS `power=OFF`.

**Эти блокеры закрыты 10.11.2026 (см. §12).** Внешний management-IP `node-2` остаётся
динамическим — это свойство NAT MWS, а не дефект: адрес нужно читать из API
(`status.network.networkInterfaces[].addresses[].oneToOneNat.external.ipAddress`), в одном
прогоне он менялся `111.88.128.219` → `111.88.131.185`. Штатный путь остаётся прежним:
`10.0.0.5` через ProxyCommand на `node-1`; прямой SSH по текущему NAT — только для
диагностики, пока `node-1` жив.

Порядок production-запуска — в [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md),
разделы 4.5–6 и 12.

## 12. Полный production-like прогон 10.11.2026

Что исправлено в коде (`deploy/ha`, рабочее дерево):

1. **Storage-quorum на переходе standby → primary.** `storage_quorum.desired()` больше не
   возвращает `None` для standby: если peer недоступен и MWS подтвердил `power=OFF`, quorum
   переводится в `none` до promotion. Если peer включён или MWS недоступен — остаётся `auto`
   (защита от split-brain при сетевой изоляции).
2. **Мёртвый FUSE-моунт.** `control.read()` превращает `Transport endpoint is not connected`
   в `RuntimeError`, поэтому failover приостанавливается, а не идёт в fencing вслепую.
   `failover.storage_ready()` проверяет не только `ismount`, но и тип `fuse.glusterfs` и
   реальное чтение каталога. `ensure_local_services()` не поднимает API на непроверенном
   storage.
3. **Automount/самовосстановление Gluster.** `deploy/ha/storage-ensure.sh` +
   `webnestdev-storage.service`/`.timer` (каждые 30 с): монтирует через systemd-юниты
   (а не `mount(8)`, иначе systemd снимает чужой FUSE-процесс), проверяет чтение, а при
   мёртвом моунте останавливает держащие его контейнеры, перемонтирует и поднимает их
   обратно. При загрузке юнит идёт `Before=docker.service`; в fstab добавлен `nofail`.
4. **Rejoin и replication slot.** `standby.sh` проверяет слот, создаёт его и падает с
   понятной ошибкой, если создать не удалось. Попутно исправлен `.pgpass`: база `*` вместо
   `replication` — иначе проверка слота в базе `postgres` шла без пароля
   (`no password supplied`).
5. **Права каталогов проектов.** runner создаёт workspace от uid 1000, API повторяет
   `chmod` при `EPERM`; до выхода образа владельца нормализует
   `webnestdev-sandbox-ownership.timer` (новый проект на «чужой» ВМ иначе оставался
   `root:root`, и терминал падал с `Permission denied`). С 10.11.2026 таймер чинит дерево
   **рекурсивно**, включая `node_modules`: в проекте «3D-игра» остались root-owned каталоги
   от старых запусков, и `npm install` падал с `EACCES: permission denied, unlink
   '.../node_modules/@types/.three-QehKYDIT/...'`. Исправлено на живой базе (58 вложенных
   элементов), unlink от uid 1000 проверен. Кроме таймера есть ручная ручка
   `POST /api/admin/projects/:id/permissions` (код готов, в проде — со следующей сборкой образа);
   на ВМ без нового образа ремонт запускается как `sudo systemctl start
   webnestdev-sandbox-ownership.service`.
   **17.11.2026, 17:19 UTC:** таймер обходил только `SANDBOX_DIR`
   (`/var/lib/webnestdev/sandboxes`), а проекты в `local`-режиме лежат в
   `/var/lib/webnestdev/workspaces`. Поэтому `root:root` в `node_modules` там не исправлялся,
   и API писал `[sandbox] ... EPERM chmod .../node_modules`. Скрипт теперь обходит оба корня с
   дедупликацией; затронутые деревья нормализованы на `node-1` и `node-2`.

Результаты прогона (реальные `power=OFF`, без ручного обхода quorum):

- **node-1 → node-2.** После `power=OFF` `node-1` (14:54:52) выжившая `node-2` сама
  перевела quorum в `none`, дождалась storage и повысилась: PG primary 15:00:43, API `200`
  15:00:53. Публичный `ready=200` восстановился в 15:01:3x. Это первый прогон, где
  понадобилось ручное вмешательство только из-за мёртвых моунтов — после установки
  storage-guard они восстанавливаются автоматически (проверено в обратном прогоне).
- **RPO.** Непрерывная запись `ha_rpo_probe` с fsync ~3.5 строк/с. Последняя подтверждённая
  запись перед падением — `seq 289` в `14:55:10.185Z`; на новом primary максимум `289`.
  Потерь нет (RPO = 0 строк).
- **node-2 → node-1 (реверс).** `power=OFF` `node-2` в 15:06:33; публичный `502` с 15:06:49,
  `200` с 15:08:08 — **RTO 79 с** (было ~6 мин из-за мёртвого моунта). Последняя
  подтверждённая запись `seq 358` в 15:06:33, на новом primary `392` — все подтверждённые
  записи выжили (RPO = 0).
- **Rejoin.** Оба узла вернулись как streaming standby с нулевым лагом; слоты `node1` и
  `node2` созданы `standby.sh` автоматически, вручную ничего не создавалось.
- **NLB.** Оба бэкенда принимают публичный трафик одновременно (в одном окне 5 мин:
  `node-1` — 286 запросов, `node-2` — 5). Публичный адрес не меняется.
- **Приложение на каждом узле.** Проект, созданный на `node-2`, прошёл терминал
  (`node v26.13.0`, запись файла), preview поднялся в container-режиме
  (`ownerAddress=10.0.0.5:8788`), билет обменивался на cookie (`204`) и страница приложения
  отдавалась (`200`, HTML приложения + pick-bridge). После падения `node-1` проект,
  привязанный к мёртвой `node-2`, автоматически переехал, и терминал выполнился на `node-1`.
- **Backup/restore drill.** Свежий `pg_dump -Fc` восстановлен в отдельную БД: счётчики
  совпали с живой базой (18 проектов, 18 пользователей, 7692 сообщения); дампы и
  `SHA256SUMS` лежат в `/var/backups/webnestdev-merge/`.
- **Данные не разъезжаются.** Причина расхождения 10.11.2026 — API на `node-1` был
  подключён к старому Docker-Postgres `src-postgres-1`, а `node-2` — к system PostgreSQL.
  Базы слиты по `message_id` (348 сообщений из старой базы, конфликтов ID нет), API
  переведён на system PG через `docker-compose.override.yml`, legacy-контейнер остановлен
  (`restart=no`), дампы обеих баз сохранены. Сейчас оба узла читают одну базу.

Остаточные риски (не блокируют текущий запуск):

- Replica 2 без witness: при сетевой изоляции (MWS говорит `power=ON`) запись замораживается
  через `auto`, но автоматического арбитража нет. Нужна третья witness-ВМ.
- `node-2` 2 vCPU / 4 ГБ хватает текущей нагрузке; preview/sandbox-ёмкость и диск под
  storage — отдельная задача перед production-масштабом.

## 13. Проверки 10.11.2026: общие лимиты, egress, отказ провайдера

### Общие лимиты входа (4.1) — закрыто

Проверено на живой паре, а не на локальном стенде:

- каждая нода — своя реплика API (`127.0.0.1:8787`), база одна (`node-1:5433`);
- 5 попыток `POST /api/admin/login` с одним адресом на `node-1` + 5 на `node-2` — все 10 прошли
  проверку лимита (лимит по аккаунту `adminLogin` = 10); 11-я с `node-1` — `429` и
  `Retry-After: 898`, 12-я с `node-2` — тоже `429`;
- после `docker restart src-webnestdev-server-1` на `node-2` счётчик остался `13`, ответ — `429`:
  рестарт окна не обнуляет;
- тестовые ключи `subject:adminLogin:accept41*` удалены из `webnestdev_rate_limits`; чужие окна
  не тронуты; `/api/ready` 200 локально и на `https://nestdev.ru`.

### Egress-фильтр (5.1) — включён в проде 10.11.2026

- В `deploy/node1/docker-compose.override.yml` и `deploy/node2/docker-compose.override.yml`:
  `EGRESS_MODE: allowlist`, `EGRESS_ENFORCE: "1"`.
- На обеих нодах `webnestdev-egress.service` `active` и `enabled` (на `node-2` установлен
  впервые), в `DOCKER-USER` — 6 правил с комментарием `webnestdev-egress`.
- Проверка `MODE=egress` на каждой ноде: прокси жив (`mode=allowlist`, 33 домена), сервер ходит
  наружу сам (200), через прокси npm registry 200, `example.com` → 403, контейнер проекта
  ставит пакеты через прокси 200, прямой сокет из контейнера не открывается. Вручную:
  `github.com` через прокси 200, `example.com` 403.
- API на обеих нодах 200, публичный `https://nestdev.ru/api/ready` 200.
- Аварийный выключатель: `EGRESS_MODE: private-only` (публичное разрешено, обход закрыт),
  затем `EGRESS_ENFORCE: "0"` (полный откат). После изменения — пересоздать контейнер сервера.
- **Ловушка на `node-2`:** там нет `.env`, compose читает `runtime.env` и `node2.env`; ручной
  `MODE=egress` без `COMPOSE_ENV_FILES=runtime.env,node2.env` даёт ложное «прокси не отвечает»
  и снимает правила.

### Отказ провайдера модели (7.3)

- Сетевой трафик контейнера API (`172.30.0.4`) на `:443` отклонялся правилом в `DOCKER-USER`
  примерно 45 секунд; правило снято в `trap`, остатков нет.
- Вызов `https://polza.ai/api/v1/models` из контейнера: `200` → `000` (обрыв) → `200` после
  снятия правила; `/api/ready` и `https://nestdev.ru/` всё время отвечали `200`; контейнер не
  перезапускался (`StartedAt` тот же, `RestartCount=0`).
- Ограничение: полноценный запуск агента в окне отказа не выполнялся — проверены изоляция и
  живучесть API, а не текст ошибки в чате. Обработка кодов провайдера покрыта
  `provider-errors`/`provider-retry` тестами.
- Отдельная находка: у запроса к модели (OpenAI-совместимый провайдер) нет собственного
  таймаута — он полагается на `AbortSignal` запуска. При «чёрной дыре» (соединение без ответа)
  шаг может ждать, пока запуск не прервёт пользователь. Это кандидат на отдельную правку с
  тестом, не входившую в сегодняшний блок.

### Переполнение диска (7.3) — не имитировалось

Том реплицируется на `node-2` (19 ГБ), заполнение до 75 % задело бы и прод, и кворум Gluster.
Логика давления (пороги 75/68, остановка на цели, защита активных проектов) покрыта
`server/src/storage/archive-scheduler.test.ts`, archive/wake принят в проде в 1.3. Для честного
учения нужен отдельный том (loop-устройство) или тестовая нода.

## 14. PITR: WAL-архив и восстановление на момент времени (10.11.2026)

Пункт 4.4 в части PITR. Скрипт `deploy/scripts/pg-pitr.sh`, установлен как
`/usr/local/sbin/webnestdev-pg-pitr`; эксплуатация и drill — `POSTGRES_BACKUP.md` §5.

Что сделано на проде:

- `archive_mode=on`, `archive_command` кладёт WAL в `/var/lib/postgresql/wal-archive`
  (локальный диск: каталог под `/var/lib/webnestdev` каждую минуту переводит на uid 1000
  `webnestdev-sandbox-ownership.timer`, WAL там жить не может);
- таймеры `webnestdev-pg-basebackup.timer` (вс 04:30 UTC, хранится 2 копии) и
  `webnestdev-pg-wal-prune.timer` (05:00 UTC, WAL старше 21 суток);
- base backup 88 МБ снимается за ~4 с; WAL-сегмент 16 МБ.

Учение (10.11.2026):

- две метки в рабочей базе с разницей 3 с; restore через `pg-pitr.sh restore` на момент между
  ними — в восстановленной базе `rows=1:before`, второй метки нет, `webnestdev_projects=18`;
- восстановление заняло 1–3 с, остановка ровно перед коммитом следующей транзакции
  (`recovery stopping before commit of transaction ...`) — это и есть PITR, а не «последний дамп»;
- учебный кластер поднимается на порту 5544 и удаляется `pg-pitr.sh stop`; тестовые таблицы
  `webnestdev_pitr_probe*` удалены из рабочих баз.

Три ловушки, найденные по ходу (все исправлены в скрипте):

1. `archive_command` с `test ! -f` не идемпотентен: если файл уже в архиве, PostgreSQL считает
   сегмент неархивированным и повторяет вечно (наблюдали `failed_count=24` и стоящую
   архивацию). Теперь `cp` во временный файл + `mv`.
2. Без `recovery.signal` PostgreSQL завершает recovery на конце base backup и игнорирует
   `recovery_target_time` — выглядит как «восстановление прошло, а метки нет».
3. Учебный кластер при `promote` с включённым `archive_mode` писал свои timeline-файлы в общий
   архив, и следующий restore падал на «requested timeline N is not a child of this server's
   history». Теперь у drill `archive_mode=off`.

**Вывоз в S3 (10.11.2026).** Написан `deploy/scripts/pg-pitr-s3.sh` и таймер
`webnestdev-pg-pitr-s3.timer` (каждые 5 минут, установлены через `pg-pitr.sh setup`):

- каждый новый сегмент — `<prefix>/pitr/wal/<сегмент>`, рядом `index.txt` (вместо ListObjects);
- base backup упаковывается в `<ts>.tar.gz` и уходит в `<prefix>/pitr/basebackup/`, рядом
  `latest.txt` с номером последней копии;
- в образ добавлены CLI-команды `put-object`, `get-object`, `head-object` с проверкой, что ключ
  лежит под `<prefix>/pitr/` и без `..`; хост стримит файл в контейнер, своих ключей у него нет;
- восстановление из бакета — `sudo env RESTORE_TIME='…' /usr/local/sbin/webnestdev-pg-pitr
  restore-s3` (или `S3_TS=<ts>` для конкретной копии).

**Включено 11.11.2026.** Образ `sha-343ee73fc0c4` содержит CLI `put-object`/`get-object`/
`head-object`; таймер `webnestdev-pg-pitr-s3.timer` выгрузил 18 WAL-сегментов, `index.txt`, base
backup `20261110T223005Z.tar.gz` (17 МБ) и `latest.txt`, оба объекта подтверждены
`head-object`. При первом запуске найден и исправлен баг `local dir="$1" tar="$dir.tar.gz"`
(`dir: unbound variable` под `set -u`) — из-за него после WAL не выгружался base backup;
исправленный `pg-pitr-s3.sh` стоит на обеих нодах. Вывоз и `restore-s3` работают.

Осталось по 4.4: вынос primary на отдельный от API инстанс. TLS на участке
HAProxy ↔ PostgreSQL выкачен 15.11.2026, 17:07 UTC в сборке `4556b09`
(`deploy/ha/pg_tls.sh`,
`db_proxy.py`, `standby.sh`), но ещё не включён: сертификат не создан, HAProxy ходит в
peer `5433` по plaintext. Порядок включения — в
[`HA_TWO_NODE_REMAINING.md`](HA_TWO_NODE_REMAINING.md).
Выкатка пока не ставит `pg-pitr.sh` автоматически — установка выполнена через `MODE=setup`;
перенос установки в `vm-deploy.sh` — следующий шаг.

## 15. Primary PostgreSQL перенесён на node-2 (10.11.2026)

> Историческая запись. После обратного прогона 12.11.2026 primary снова на `node-1`;
> актуальное состояние — раздел 19, а не откат, описанный ниже.

Пункт 4.4 в части «Postgres отдельно от API». `node-2` остаётся включённой постоянно
(решение пользователя: production-контур на двух узлах), поэтому отдельная ВМ под базу не
покупалась.

Как выполнено:

- planned switchover через штатный mailbox `data/ha-switchover.json`: `requested → target_ready
  → source_stopped → promoted` за ~12 с; `node-2` стал primary, `node-1` остановил локальную
  базу и продолжил отдавать API через HAProxy на peer;
- `node-1` возвращён standby'ом (`standby.sh 10.0.0.5 5432 node1`), слот `node1` создан
  автоматически, лаг 0;
- приложение не меняло `DATABASE_URL`: оба API ходят в локальный HAProxy `:5432`, цель которого
  переключает `db_proxy.py`;
- PITR перенесён на новую primary: `pg-pitr.sh setup` на `node-2`, `archive_mode=on`,
  `pg_switch_wal` → сегмент в архиве, base backup 88 МБ, drill на момент времени — только
  `before`-метка, 18 проектов;
- в `pg-pitr.sh`/`pg-pitr-s3.sh` добавлена защита: таймеры basebackup/prune/выгрузки
  отрабатывают только на primary (`pg_is_in_recovery() = f`), иначе после switchover обе ноды
  писали бы в один бакет.

Проверка после переезда: `node-2` — `pg_is_in_recovery()=f`, 18 проектов, API 200;
`node-1` — `in_recovery=t`, лаг 0, API 200; публичный `https://nestdev.ru/api/ready` — 200.

### Откат 10.11.2026 и простой (важно)

Пользователь решил выключить `node-2` примерно на две недели, поэтому в тот же день primary
возвращён на `node-1` (плановый switchover `node-2 → node-1`, rejoin `node-2`, слот `node2`,
лаг 0, оба API 200). Перед production-запуском базу нужно снова перенести на `node-2` —
порядок в [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md).

Во время обратного переезда прод кратковременно лёг (несколько минут). Причины, чтобы не
повторить:

1. **Битый TLS-конфиг на `node-2`.** В `postgresql.auto.conf` были прописаны
   `ssl_cert_file`/`ssl_key_file`/`ssl_ca_file` на `/var/lib/postgresql/tls/*.crt`, а сами
   файлы — 0 байт. После рестарта PostgreSQL не стартовал (`could not load server certificate
   file ... no start line`), API остались без базы. Лечение: `ssl = off` (TLS ещё не включён),
   пустые файлы остались как напоминание — не включать TLS без валидного сертификата.
2. **Старый worker HAProxy на `node-1`.** После рестарта базы peer'а он держал мёртвые
   соединения, `/api/ready` висел; `sudo systemctl reload haproxy` вернул 200. Это теперь
   штатный шаг после рестарта PostgreSQL на соседней ноде.
3. **`archive_mode` слетает при rejoin.** `standby.sh` перезаписывает `postgresql.auto.conf`
   (новая `primary_conninfo`/слот), и `archive_mode`/`archive_command` исчезают. После
   каждого rejoin новой primary: `webnestdev-pg-pitr setup` + `show archive_mode` = `on`.
   Также исправлен `pg-pitr.sh`: `setup` больше не падает на `install` в самого себя
   («are the same file»), из-за чего `ALTER SYSTEM archive_mode` раньше не выполнялся.

### Выключение `node-2` 10.11.2026

- Перед выключением: `node-1` — primary, `node-2` — standby, лаг 0, публичный `/api/ready` 200.
- **`sudo systemctl poweroff` на `node-2` не сработал** (завис на `cloud-init-hotplugd` и закончился
  перезагрузкой в 22:43). Поэтому: остановлены `postgresql@17-main` и `glusterd`, затем питание
  снято через MWS (`POST` с `metadata.etag` и `spec.hardware.power=OFF`, `gracefulShutdownTimeout
  90s`). MWS: `power=OFF`, `ready.state=OK`.
- После выключения: `ping 10.0.0.5` не проходит, `node-1` — primary, 18 проектов, API 200,
  `https://nestdev.ru/api/ready` 200; `sandboxes` и `data` читаются, в `gluster volume status`
  остались только brick'и `10.0.0.4`; контейнеры на `node-1` живы.
- Ограничения режима: нет failover (потеря `node-1` — ручное восстановление), Gluster — одна
  реплика, риск split-brain при неаккуратном включении. Включать `node-2` только когда `node-1`
  жив и является primary.

## 16. NLB и CDN для хостинга (11.11.2026)

### `node-2` включена для проверки (на момент проверки)

- MWS: `power=ON`, `ready.state=OK`; SSH через `node-1` работает. После тестов 4 preview
  машина снова выключена: `power=OFF`.
- `postgresql@17-main` — standby (`pg_is_in_recovery()=t`), API 200, `glusterd` и Docker активны.
- `node-1` — primary, `pg_stat_replication`: 1 реплика, лаг 0; публичный `/api/ready` 200.
- `gluster volume status`: по 2 brick'а на каждый из трёх томов (`data`, `sandboxes`, `sites`).

### NLB действительно балансирует

Проверка на живом сайте `https://my-furniture.host.nestdev.ru/` (страница ~24 КБ), 40 запросов
через NLB, счётчики сети контейнера `src-caddy-1` на каждой ноде:

| Нода | Принято (rx) | Отдано (tx) | Доля tx |
| --- | --- | --- | --- |
| `node-1` | +57 750 Б | +600 892 Б | 49,7% |
| `node-2` | +62 738 Б | +607 615 Б | 50,3% |

Вывод: NLB распределяет TCP-соединения между обеими нодами практически поровну; обе отдают
сайт из общего Gluster. Счётчики хоста для такой проверки не годятся — в них попадает
репликация Gluster.

### CDN-пилот (удалён 11.11.2026)

- Ресурс: `hosting-pilot` в `project-pimashin2015`, API `cdn.mwsapis.ru`
  (`POST /cdn/v1/projects/{project}/cdnResources/{name}`).
- Origin: `https://my-furniture.host.nestdev.ru`, Host header — тот же домен, HTTPS-редирект,
  кеширование «как у origin» с TTL 1 ч.
- Сгенерированный адрес: `https://top873590456.mwscdn.ru`, статус `Active` (раскатка по edge
  заняла ~10 минут, до этого часть edge отвечала 502/SSL-ошибкой — это нормально для
  `PROCESSING`).
- Проверки: HTML совпадает с origin побайтно (sha256), отдаётся с `x-edge-cache-status: MISS`
  всегда, потому что Caddy ставит `Cache-Control: no-cache`; CSS первый раз `MISS`, дальше `HIT`.
- Purge: `POST /cdn/v1/projects/{project}/cacheTasks/{name}` с
  `spec.action.purge.paths=["/styles.css"]`; задача дошла до `OK`, после неё CSS снова `MISS`,
  затем `HIT`.
- Цена: 0,8418 ₽/ГБ с НДС, без платы за запросы; квота 25 CDN-ресурсов по умолчанию.
- После проверки общей схемы пилот удалён (`DELETE .../cdnResources/hosting-pilot?ifExist=true`, 204).
  Превью не подключались.

### Общий wildcard-CDN для всех сайтов (включён 11.11.2026)

Цель — один CDN-ресурс на `*.host.nestdev.ru`, чтобы новые и существующие сайты попадали в
CDN без отдельных ресурсов.

| Объект | Значение |
| --- | --- |
| Сертификат Certificate Manager | `host-wildcard`, домены `*.host.nestdev.ru`, DNS-01, **`valid=true`** |
| CNAME для делегирования | `_acme-challenge.host.nestdev.ru` → `402a2f9f91e84d2eabe877c343f4c978.certmanager.mwsusercontent.ru.` |
| CDN-ресурс | `hosting`, FQDN `top3561259317.mwscdn.ru`, **включён**, статус `OK` |
| CNAME всех сайтов (после сертификата) | `*.host.nestdev.ru` → `top3561259317.mwscdn.ru.` |
| Origin | `https://178.236.27.102` (NLB), Host и SNI — по имени сайта |
| Origin TLS | wildcard `*.host.nestdev.ru` из Certificate Manager на обеих нодах (до 09.02.2027) |

Порядок:

1. ✅ CNAME `_acme-challenge.host.nestdev.ru` добавлен, сертификат стал `valid=true`.
2. ✅ CDN-ресурс `hosting` включён; проверен через `--resolve` на IP edge без изменения DNS:
   `my-furniture` — 200, содержимое совпадает с origin; `my-sayt` — 200; кеш по Host
   раздельный (`my-furniture/styles.css` и `my-sayt/styles.css` не смешиваются); после первого
   промаха CSS отдаётся `HIT`. Несуществующий и неопубликованный сайты дают 502 — это ожидаемо.
3. ✅ В REG.RU удалена A `*.host` → `178.236.27.102` и добавлена CNAME-запись
   `*.host` → `top3561259317.mwscdn.ru.`; авторитетный `ns1.reg.ru` отдаёт CNAME, локальные
   кеши могут держать старый A до истечения TTL (до ~48 мин, без простоя — NLB ещё работает).
4. ✅ Проверены `my-furniture` и `my-sayt` уже через CNAME/CDN: 200, содержимое совпадает с
   origin побайтно, кеш ассетов `HIT`, панель и `api/ready` — 200. Сайт в статусе draft и
   несуществующий slug дают 502 от origin — ожидаемо.
5. ✅ **11.11.2026 — TLS на origin для новых сайтов.** До этого новый slug получал 504: CDN
   ходит на origin по HTTPS, а Caddy пытался выпустить сертификат на каждое имя через ACME,
   который после переключения DNS приходит на CDN. Исправление: забрали уже выпущенный
   managed-сертификат `host-wildcard` через
   `GET /certmanager/v1/projects/project-pimashin2015/certificates/host-wildcard:download`,
   положили `fullchain.pem`/`key.pem` в `certs/host` на **обеих** нодах и переключили
   `host-tls.caddy` с `on_demand` на статический сертификат. Проверка: новый slug через CDN —
   `200` с содержимым, NLB 10/10 — `200`, `my-furniture` — `200`, сертификат `*.host` действует
   до 09.02.2027.

**Важно при обновлении:** поля ответа `certificate`/`chainedCert` приходят без завершающего
перевода строки; склеивать их `cat` подряд нельзя — получится
`-----END CERTIFICATE----------BEGIN CERTIFICATE-----`, и Caddy отвергнет ключ. Между PEM-блоками
нужен `\n`.

**Продление.** Workflow `deploy` перед выкаткой запускает
`deploy/scripts/host-cert.mjs`: он забирает текущий сертификат из Certificate Manager и
`deploy/scripts/install-host-cert.sh` раскладывает его в `certs/host` на node-1 и node-2,
перечитывая Caddy. Шаг выполняется и в ежедневном режиме `cert`, поэтому после продления MWS
копии на origin обновляются без ручных действий; ошибка обновления не блокирует выкатку кода.
Сертификат Let's Encrypt действует 90 дней, MWS продлевает его 09.01.2027.

**Полный тест автоматизации 11.11.2026.** На обе ноды положили заведомо чужой self-signed
сертификат (только файлы, без reload Caddy), затем запустили `host-cert.mjs` и
`install-host-cert.sh` так же, как workflow. Скрипт скачал managed-сертификат, заменил файлы на
обеих нодах и перечитал Caddy: на дисках и в TLS обеих нод снова serial
`0624FC8D1A56A367ACB2FBA401271ABC1B8D`, fingerprint `69:FC:…:B6:5A`, тестовый сайт — `200`.
Само продление MWS (`renewalAt` 09.01.2027) не форсировалось, чтобы не расходовать лимит
Let's Encrypt; проверен полный путь «скачать → установить → reload» после порчи локальной копии.

Purge при публикации автоматизирован (см. ниже); HTML не кешируется (`no-cache`), ассеты
живут до TTL 1 ч. Черновики и удалённые сайты отдают 404/502 по состоянию сайта, а не из-за
отсутствия сертификата.

**Авто-purge (выкачен 11.11.2026, build `2a9a58986ced`):**

- `server/src/hosting/cdn-purge.ts` — best-effort вызов `POST /cdn/v1/projects/{project}/cacheTasks/{name}`
  с `paths: ["/*"]` после успешной публикации; ошибка только логируется и не переводит сайт в failed.
- Включается переменными `HOSTING_CDN_PURGE=1`, `HOSTING_CDN_RESOURCE=hosting`,
  `HOSTING_CDN_PROJECT=project-pimashin2015` (добавлены в `deploy/node{1,2}/docker-compose.override.yml`).
- Workflow `deploy` собрал образ `ghcr.io/misha4323223/webnestdev:sha-2a9a58986ced` и выкатил его
  на обе ноды; `/api/health` на node-1 и node-2 отдаёт `2a9a58986ced1c89deba952ad14f09e58155514c`,
  все три `HOSTING_CDN_*` видны в контейнерах. `my-furniture` через CDN — 200. **End-to-end
  11.11.2026:** CSS v1 после прогрева отдавался с `x-edge-cache-status: HIT`; после публикации v2
  задача `purge-fulltest-172315-mwce9iw6` создалась автоматически и дошла до `OK`; CDN отдал
  `fulltest-css-v2` через ~6 с (`MISS`), HTML v2 — сразу (`no-cache`). Тестовый сайт и аккаунт
  удалены.
- Ресурс общий, поэтому purge чистит кеш **всех** сайтов. Это принятый компромисс: отдельный
  ресурс на сайт не нужен, а лишний промах кеша дешевле залипшего старого ассета.
- Проверено: тест `cdn-purge.test.ts` (7/7), `tsc -p server/tsconfig.json --noEmit`; реальная
  задача `purge-my-furniture-mwbwhmxc` дошла до `OK`.

Все сайты, старые и новые, уже попадают в CDN автоматически за счёт wildcard-CNAME и одного
ресурса `hosting`; отдельный ресурс на сайт не создаётся.

TLS на участке HAProxy ↔ PostgreSQL выкачен 15.11.2026, 17:07 UTC в сборке `4556b09`:
`deploy/ha/pg_tls.sh` создаёт сертификат и CA, `db_proxy.py` ходит в peer напрямую на `5433`
с `ssl verify required`, `standby.sh` — с `sslmode=verify-full`. TLS ещё не включён: сертификат
не создан, текущий peer-трафик plaintext. Порядок и критерии — в
[`HA_TWO_NODE_REMAINING.md`](HA_TWO_NODE_REMAINING.md).

**15.11.2026, 17:15 UTC проверены конкурентный DDL и `restore-s3`:** два процесса одновременно
вызвали `initializeStorage()` на живой primary, один ждал advisory-lock, оба завершились
успешно; `restore-s3` из base backup `20261115T043406Z` на `2026-11-15 12:00:00+00`
поднял drill на `5544`, 18 проектов, последнее обновление `2026-11-15T11:08:55.318Z`.
Перед drill штатно вызван `pg_switch_wal`, чтобы открытый сегмент попал в S3; drill
остановлен и удалён. Осталось включить TLS.

## 17. 12.11.2026: hybrid preview pilot и синхронизация node-2

- `node-2` включена, MWS: `power=ON`, `ready.state=OK`; API на обеих нодах отдаёт
  `cf0a57accbdf…`.
- Выкатка `43264347020` синхронизировала образ, `docker-compose.yml`, Caddy, сертификаты,
  runner и egress-правила на `node-2`; `node2-sync.sh` завершился с `node-2 готова`.
- PostgreSQL до аварийного прогона: `node-1` — primary (`pg_is_in_recovery=f`, read-only off),
  `node-2` — streaming standby (`pg_is_in_recovery=t`, лаг 0); после прогона роли обратные;
  после обратного прогона primary снова `node-1`, см. раздел 19. Gluster: по два brick'а на
  `data`, `sandboxes`, `sites`; storage/ownership timers активны.
- Hybrid-пилот: временный проект на `node-2`, listener в API на `node-1`; статика, `/api`,
  POST с телом, WebSocket и ошибка backend проверены через публичный preview. Подробности и
  замеры — в [`HYBRID_PREVIEW.md`](HYBRID_PREVIEW.md), раздел «Реальный пилот 12.11.2026».
- Временный проект, preview-контейнер, sandbox и тестовый аккаунт удалены; `previews.runtime=0`.
- Реальный failover с остановкой `node-1` **выполнен** 12.11.2026 после hybrid-пилота:
  `node-2` стала primary, `node-1` возвращена standby; затем обратный прогон вернул primary
  на `node-1`; сценарии и ограничения — в разделах 18–19.

## 18. 12.11.2026: аварийный failover node-1 → node-2

Проведён контролируемый отказ primary по runbook [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md),
этапы A–C. Использовался временный аккаунт и три временных проекта; после проверки они,
их файлы, сессии и preview удалены.

### Подготовка

- Прямой SSH на `node-2` через её текущий внешний NAT (`171.22.73.93`) проверен до отказа:
  управление не зависело от `node-1`.
- Backup перед прогоном: `webnestdev/backups/postgres/webnestdev/2026/11/12/webnestdev-20261112T172954Z.dump`,
  4 738 867 байт; `MODE=check` — успешно.
- Preflight: оба контроллера active, `node-1` primary, `node-2` standby, оба API 200,
  `ALLOW_PRIMARY` нет, слот `node2` активен, лаг 0, Gluster — по два brick'а.
- Тестовый маркер `HA-E2E-A 20261112T173053Z` создан до отказа; проект `HA-E2E-A`
  (id `171202ea…`, `node-2`) и его preview были доступны через `node-1` до выключения.

### Отказ и takeover

| Событие | UTC |
| --- | --- |
| MWS power-off `node-1` | 17:31:28 |
| `node-2`: `pg_is_in_recovery()=f` | 17:32:56 |
| `node-2`: `/api/ready` = 200 | 17:33:06 |
| публичный `https://nestdev.ru/api/ready` = 200 | 17:33:27 |

RTO от команды power-off до публичного API — **119 с** (до локального API `node-2` — 98 с,
до PostgreSQL primary — 88 с). Контроллер `webnestdev-failover-node2.service` активен,
Caddy/API/runner/broker на `node-2` поднялись; MWS `node-1 power=OFF`.

RPO: маркер и проект, созданные за 35 с до отказа, сохранились; расхождений нет. NLB после
отказа продолжал отдавать публичный API через `node-2`; прямые target-статусы MWS — оба `OK`.

### Пользовательский путь

- `HA-E2E-A`: файл `.ha-e2e-marker` прочитан после takeover; старый preview был привязан к
  выключенному API `node-1` и завис, после `preview/start` на `node-2` открылся с маркером
  (`page 200`). Это ожидаемое восстановление после смены owner, а не потеря данных.
- `HA-E2E-B` создан уже на `node-2` (id `8088e1c8…`); проект, файл, терминал и preview
  работают; preview стартовал за 63 мс.
- `HA-E2E-C` создан на вернувшейся `node-1` (id `36c27e58…`), пока её локальный PostgreSQL
  был остановлен guard'ом; API `node-1` работал через HAProxy на `node-2`, preview стартовал
  за 43 мс. После рестарта API preview пришлось запустить заново — это штатное следствие
  рестарта процесса API, файлы и данные сохранились.
- Терминал проекта выполнен на обоих узлах: `pwd` = `/workspace`, код 0, файл
  `.ha-e2e-terminal*` записан и прочитан через API.

### Возврат node-1 и rejoin

- `node-1` включена в 17:35:57. Start-guard не пустил старый primary:
  `СТАРТ ЗАПРЕЩЁН: peer уже primary; локальный primary создал бы split-brain`.
- Контроллер `node-1` поднял API через HAProxy на `10.0.0.5:5432`; API `200` с 17:37:34.
- Rejoin выполнен в 17:38:16–17:38:24 (`standby.sh 10.0.0.5 5432 node1`), слот `node1`
  создан; `pg_is_in_recovery()=t`, `pg_stat_wal_receiver.status=streaming`, лаг 0 байт.
- После rejoin `archive_mode` снова оказался `off` (известное следствие `standby.sh`).
  Выполнен `webnestdev-pg-pitr setup` и рестарт PostgreSQL на `node-2`; `archive_mode=on`,
  WAL успешно заархивирован (`archived=1`, `failed=0`, `last=0000000D0000000000000047`).

### NLB и сеть

- MWS NLB `webnestdev-nlb-main`: оба target `OK` для TCP 80 и TCP 443; публичные
  `https://nestdev.ru` и `/api/ready` — 200.
- Прямая проверка Caddy с соседней ВМ (`node-2 → 10.0.0.4:443`) не работает: облачная
  защита разрешает 443 только от NLB, но не peer-to-peer. Это не признак unhealthy target;
  для приёмки использовались статусы target'ов MWS, а не прямой peer-запрос.

### Исправленные дефекты

1. `pg-pitr.sh`: установленная копия `setup` падала на `install` в саму себя; после
   обновления скрипта добавлен fallback на соседний `webnestdev-pg-pitr-s3`, чтобы S3-таймер
   включался и при запуске из `/usr/local/sbin`.
2. `pg-backup.sh`: на `node-2` не было `.env`, поэтому `docker compose` не подставлял
   обязательные переменные и backup/check падали. Добавлены `COMPOSE_ENV_FILES` и
   автоопределение `runtime.env` + `node2.env`; финальный backup и `check` прошли.
3. После rejoin потребовался PITR setup (см. выше); без него primary работал бы без
   WAL-архива.

### Финальное состояние этапов A–C (историческое)

- После прямого отказа `node-2` была primary (`pg_is_in_recovery()=f`, HAProxy →
  `127.0.0.1:5433`), `node-1` — standby (`t`, HAProxy → `10.0.0.5:5432`), оба API 200,
  оба `power=ON`. Это состояние относилось только к этапам A–C.
- Backup после очистки тестовых данных того прогона:
  `webnestdev/backups/postgres/webnestdev/2026/11/12/webnestdev-20261112T174719Z.dump`,
  4 738 836 байт; `MODE=check` — успешно, в том числе с `node-1` (проверка переносимости
  скрипта). Restore drill на `node-2` восстановил **58 таблиц**, после проверки учебная база
  удалена. PITR-таймеры active, `archive_mode=on`.
- Пользовательские данные вне временных проектов не затрагивались; тестовый аккаунт,
  проекты, sandbox-каталоги, сессии и preview удалены.

## 19. 12.11.2026: обратный отказ node-2 → node-1, storage split и выключение node-2

После этапов A–C выполнен полный обратный прогон по этапам D/E и отдельная проверка
storage-quorum. Тестовый аккаунт, проекты `REV-E2E-BASE`, `REV-E2E-D`, `REV-E2E-E`, их
sandbox-каталоги, сессии и preview после фиксации evidence удалены.

### Этап D: отказ node-2 и takeover node-1

| Событие | UTC |
| --- | --- |
| команда MWS power-off `node-2` | 17:58:33 |
| MWS подтвердил `node-2 power=OFF` | 17:59:28 |
| `node-1`: `pg_is_in_recovery()=f` | 17:59:42 |
| `node-1`: локальный API `200` | 17:59:51 |
| публичный `https://nestdev.ru/api/ready` = 200 | 17:59:51 |

RTO от начала команды power-off — **78 с**; от подтверждения `power=OFF` — **23 с**. RPO 0:
маркер `REV-E2E-BASE` и проект, созданные до отказа, сохранились; в `node-1` осталась одна
Gluster-реплика, `quorum-type` автоматически стал `none`, запись в `data`/`sandboxes`
прошла. NLB: `node-2 FAILED`, `node-1 OK`; второй primary не появился.

- `REV-E2E-BASE` (id `04774d11…`) после рестарта API открылся, preview отдал маркер.
- `REV-E2E-D` создан на `node-1`, терминал выполнился, preview открылся; проект привязан
  к `node-1`, а не только публичный health-check.
- `node-1` оставался primary и при одном brick'е; storage-guard выставил `none` без ручного
  вмешательства.

### Этап E: возврат node-2, работа через node-1 и rejoin

- MWS power-on `node-2` — 18:00:42, `power=ON` — 18:01:39. Start-guard не пустил её старый
  primary: PostgreSQL не стартовал как второй primary.
- API `node-2` поднялся через HAProxy на primary `node-1` — 200 в 18:02:22.
- `REV-E2E-E` создан на `node-2`, терминал и preview прошли; публичный трафик в это время
  шёл через NLB.
- Rejoin `node-2` выполнен 18:02:58–18:03:05: `pg_is_in_recovery()=t`,
  `pg_stat_wal_receiver.status=streaming`, лаг 0; NLB снова показывал оба target `OK`.
  После rejoin на `node-1` включён `archive_mode=on` через `webnestdev-pg-pitr setup`
  (известное следствие `standby.sh`).
- Отдельно проверен ingress через единственную `node-2`: Caddy на `node-1` кратковременно
  остановлен, публичный `/api/ready` остался `200`; затем Caddy возвращён. MWS target
  `node-2` в этом коротком окне ещё показывал `OK` из-за задержки health-статуса, поэтому
  вывод об ingress сделан по публичному ответу, а не только по статусу target'а.

### Storage-quorum при сетевом разделении

Проверена изоляция Gluster-портов между нодами (TCP 24007 и 49152–65535) в обе стороны;
SSH и PostgreSQL 5432 не блокировались. Это storage-network split, а не полная изоляция ВМ.

| Момент | Результат |
| --- | --- |
| обе стороны заблокированы, 18:17:51 | Gluster CLI: `Connection failed`; `quorum-type` остался `auto` |
| запись probe на primary | `probe_exit=124` — запись заморожена, split-brain нет |
| PostgreSQL | `node-1` — `f`, `node-2` — `t`; promotion не произошёл |
| публичный API | `200` через `node-1`; API `node-2` во время split был недоступен |
| обе стороны разблокированы, 18:18:44 | запись probe `exit=0`; оба API `200` |
| после восстановления | `quorum-type=auto` на всех трёх томах, данные читаются, split-правил нет |

Это ожидаемое поведение replica 2 без witness: при потере кворума запись блокируется, а не
уходит в split-brain. Полная сетевая изоляция всех портов не имитировалась; ограничение
«нет автоматического promotion без подтверждённого fencing» остаётся в силе.

### Peer-to-peer 443

Прямой `node-1 → 10.0.0.5:443` и `node-2 → 10.0.0.4:443` не проходят; порт 5432 при этом
открыт, а оба NLB target имеют `OK`. Это ограничение облачной защиты/NLB, а не признак
unhealthy target. Для проверки было создано явное private-правило `webnestdev-allow-peer-web`
(TCP 80/443, `10.0.0.0/24` → `10.0.0.0/24`, priority 1000): MWS показал `ready=OK`, но прямой
peer-запрос всё равно не открылся. Правило удалено (`204`), в финале остались только шесть
исходных firewall-правил. Код и NLB из-за этого не менялись.

### Финальное состояние

- `node-1` — primary: `pg_is_in_recovery()=f`, `archive_mode=on`, API `200`.
- `node-2` — перед выключением standby (`t`, `streaming`, лаг 0), затем MWS `power=OFF`;
  сейчас недоступна. NLB: `node-2 FAILED`, `node-1 OK` для TCP 80/443.
- Gluster на `node-1`: `data`/`sandboxes`/`sites` — `quorum-type=none` (единственный brick),
  все три mount'а читаются, probe-запись прошла. Это принятое ограничение режима одной ВМ.
- Публичный `https://nestdev.ru` и `/api/ready` — `200`; split-правил iptables нет.
- Тестовые данные удалены. Финальный backup:
  `webnestdev/backups/postgres/webnestdev/2026/11/12/webnestdev-20261112T182338Z.dump`,
  4 738 838 байт; `MODE=check` — успешно, возраст 0 ч.
- **Не включено в текущий режим:** failover при падении `node-1`, вторая Gluster-реплика,
  второй API-target. Для production-запуска сначала включить `node-2`, проверить standby и
  перевести primary на неё по runbook; только после этого выключать её нельзя.

## 20. 13.11.2026: локальный кэш зависимостей preview на обеих нодах

Состояние на 13.11.2026 после выкатки `c1d2d1a`: `node-1` — primary PostgreSQL, `node-2` —
streaming standby; обе ВМ включены, API/runner/брокер работают на одной сборке.
`node-2` остаётся включённой до отдельной команды пользователя.

### Где лежит кэш

- Путь на каждой ноде: `/var/lib/webnestdev/preview-cache`.
- Каталог локальный, не на Gluster; исходники проекта и `dist` по-прежнему лежат в общем
  storage. `node_modules` монтируется в контейнер как `/workspace/node_modules`.
- Владелец — uid/gid `1000:1000`, права `0775`, чтобы установка внутри контейнера не
  получала `EACCES` и Docker не создавал root-owned источник mount'а.
- Очистка: кэши без обращений дольше `WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS` (по умолчанию 30
  дней) удаляются при старте и каждые 6 часов. Выключатель — `WEBNESTDEV_PREVIEW_CACHE=0`.

### Что должно быть у API, брокера и runner

| Компонент | Переменные | Mount |
| --- | --- | --- |
| API (`src-webnestdev-server-1`) | `WEBNESTDEV_PREVIEW_CACHE_DIR`, `WEBNESTDEV_PREVIEW_CACHE_HOST_DIR`, `WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS` | `/var/lib/webnestdev/preview-cache` → тот же путь |
| Docker-брокер | `BROKER_PREVIEW_CACHE_ROOT` | `/var/lib/webnestdev/preview-cache` → тот же путь, read-only |
| `node1-runner` / `node2-runner` | те же три `WEBNESTDEV_PREVIEW_CACHE_*` | `/var/lib/webnestdev/preview-cache` → тот же путь, read-write |

Runner — контейнер вне compose, поэтому одного обновления образа недостаточно.
`deploy/scripts/update-runner.sh` с 13.11.2026 сам создаёт каталог (при необходимости через
`sudo -n`), добавляет bind-mount и недостающие переменные и пересоздаёт runner, даже если образ
уже совпадает. Это закрывает случай, когда API уже видел кэш, а runner создавал его внутри
своего контейнера.

### Порядок применения

1. Убедиться, что `node-1` жив и является primary PostgreSQL.
2. Включить `node-2`, дождаться SSH, standby и `node2-runner`.
3. Обновить runner сначала на `node-1`, затем на `node-2`:

```bash
# node-1
ssh node1 "IMAGE_REF='ghcr.io/misha4323223/webnestdev:sha-c1d2d1a19ccc' bash -s" \
  < deploy/scripts/update-runner.sh

# node-2 (через ProxyCommand на node-1)
ssh node2 "IMAGE_REF='ghcr.io/misha4323223/webnestdev:sha-c1d2d1a19ccc' bash -s" \
  < deploy/scripts/update-runner.sh
```

4. После runner обновить API и брокер штатным compose (на `node-2` — с её двумя env-файлами):

```bash
# node-1
cd ~/webnestdev/src && docker compose \
  -f docker-compose.yml -f docker-compose.override.yml \
  up -d --no-build --no-deps webnestdev-server docker-broker

# node-2
cd /home/ubuntu/webnestdev/src && docker compose \
  --env-file runtime.env --env-file node2.env \
  -f docker-compose.yml -f docker-compose.override.yml \
  up -d --no-build --no-deps webnestdev-server docker-broker
```

5. Проверить на каждой ноде `/api/ready` и что сборка совпадает с выкаченной.

### Проверка без вывода секретов

```bash
# bind-mount есть и указывает на локальный каталог
docker inspect node1-runner \
  --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' | grep preview-cache

# имена переменных (значения не печатаем)
docker inspect node1-runner \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -o '^[A-Z_]*' | grep PREVIEW_CACHE

# каталог доступен на запись внутри runner
docker exec node1-runner sh -lc 'test -w "$WEBNESTDEV_PREVIEW_CACHE_DIR" && echo cache-writable'
```

Те же команды выполнить с `node2-runner` на `node-2`. Для API и брокера проверяются их
mount'ы `preview-cache` и ключи `WEBNESTDEV_PREVIEW_CACHE_*` / `BROKER_PREVIEW_CACHE_ROOT`.

Фактическая проверка 13.11.2026: на обеих нодах runner пересоздан с bind-mount, все три
переменные присутствуют, `cache-writable` подтверждён; API и брокер имеют mount, `/api/ready`
на обеих нодах — `200`, build `c1d2d1a19cccafac3ed4d6c710a580a75f77fa67`.

## 21. 14.11.2026: DNS target custom domains и включение node-2

Пользователь исправил DNS и попросил обновить документацию, включить вторую ноду и выкатить
обновление через GitHub Actions. Состояние после выкатки `43638367364`:

- `custom.nestdev.ru` → `178.236.27.102` (A, TTL 3600), DNS-only; проверено через reg.ru и
  публичные резолверы. Это target для пользовательских доменов, отдельного сайта на нём нет.
- `node-2` включена через MWS (`power=ON`), SSH и Docker доступны. Start-guard не допустил
  второй primary: `node-1` — primary (`pg_is_in_recovery()=f`), `node-2` — standby (`t`).
- `/api/ready` на обеих нодах — `200`; Gluster `data`, `sandboxes`, `sites` — по два online-brick'а.
- Выкатка `43638367364` — success; обе ноды работают на `1bb7e8b`, `/api/ready` — `200`.
  `node2-sync.sh` доставил актуальные compose/Caddy, пересоздал Caddy и runner, установил
  `webnestdev-caddy-reload.timer` (active); хэши compose/Caddyfile на нодах совпадают.
- `CUSTOM_DOMAINS_ENABLED` включён (`1`) на обеих нодах выкаткой `43637265749`; карточка
  «Свой домен» видна. На момент этой выкатки тестовый домен ещё не был подключён; он добавлен
  позже в тот же день — см. раздел 22.
- HA-переключение (падение `node-1` и возврат её standby) ещё не выполнялось; это следующий
  отдельный шаг после тестового домена.
- 14.11.2026 исправлена ошибка терминала `Некорректное описание монтирования`: runner policy
  теперь разбирает `extraMounts` как пары `-v <mount>`; build `1bb7e8b`, run `43638367364`.

## 22. 14.11.2026: тестовый custom domain `nestdevtest.ru`

- Домен зарегистрирован 14.11.2026 в 21:21 UTC в reg.ru, NS `ns1/ns2.reg.ru`; whois —
  `REGISTERED, DELEGATED, UNVERIFIED`. `UNVERIFIED` — нормальный статус нового домена и
  делегирование не блокирует.
- В панели проекта добавлена пара `nestdevtest.ru` + `www`; в БД две строки `pending_dns`
  с `last_error = TXT-запись не найдена`.
- На NS reg.ru: `A @` → `178.236.27.102`, `CNAME www` → `custom.nestdev.ru`,
  `TXT _nestdev-verify` и `TXT _nestdev-verify.www` с одним токеном.
- Первая попытка настройки: TXT добавлены полным именем, reg.ru дописал зону и получились
  `_nestdev-verify.nestdevtest.ru.nestdevtest.ru` и `...www...nestdevtest.ru.nestdevtest.ru`.
  Записи исправлены на относительные имена. В UI имена теперь тоже показываются без зоны,
  полное имя — в подсказке (коммит `3bb0714`, deploy run `43644567616`, обе ноды на
  `sha-3bb071483fad`).
- Публичные резолверы (`1.1.1.1`, `8.8.8.8`, `dns.google`) и контейнер API на обеих нодах
  получают `NXDOMAIN` на весь домен: зона `.ru` ещё не опубликовала делегирование, serial
  `4071096` не менялся. Проверять TXT до появления NS в публичном DNS бессмысленно.
- Когда зона обновится: «Проверить DNS» в карточке. Если домен уже делегирован, а API всё ещё
  пишет «TXT-запись не найдена», сбросить отрицательный кэш `systemd-resolved`:
  `sudo resolvectl flush-caches` на обеих нодах, затем повторить.
- Дальше: 404/SPA, `caddy-data` на обеих нодах и HA-тест падением `node-1`; HTTPS и 301
  для apex/`www` проверены 15.11.2026 (раздел 23).

## 23. 15.11.2026: холодный старт проекта и HTTPS `nestdevtest.ru`

Разбор утреннего инцидента по логам API/Caddy и БД. Время ниже — UTC; в Москве +3 часа.

### 23.1. Проект из S3: что произошло на самом деле

- В **06:01:06** API начал восстановление проекта `3a6cb9b5-c178-4927-9c72-8d93573aa91f`
  из S3: `2 336 377` байт. Восстановление завершилось за **1 секунду**, задание — `done`
  в `06:01:07.620`. Ошибок restore в логах и в `webnestdev_jobs` нет.
- В очереди была строка `project.restore` с `run_after = 06:16:06` (через 15 минут после
  старта), но она завершилась в **06:01:07.620** — restore не ждал эти 15 минут. Это не
  «отложенный на 15 минут импорт».
- В **06:01:06** параллельный запрос `GET /api/projects/<id>/changes` получил **409**
  `PROJECT_RESTORING`, потому что попал в окно распаковки. Это ожидаемый ответ
  «проект просыпается», а не удаление архива.
- В просмотренных логах нет ни `Архив проекта удалён — восстанавливать нечего`, ни
  `восстановление не удалось`; по проекту есть только «восстановление начато»,
  «восстановлен из архива (2336377 байт, 1 с)», «задание восстановления завершено».
- Панель могла запомнить 409 от `/changes` как ошибку панели, а `useProjectWake` к моменту
  своего первого опроса уже видел проект восстановленным и не показывал карточку
  «Подготовка рабочего пространства». Поэтому до перезагрузки страницы оставался текст
  ошибки, хотя файлы уже были на диске. «15 минут» — это время до следующего открытия/
  перезагрузки, а не время скачивания из S3.

**Вывод:** S3 и распаковка не были медленными и ничего не удаляли. Проблема в гонке
параллельных запросов рабочей области: один запрос запускает restore и получает 409,
другой кэширует 409 как ошибку, а общего retry после готовности архива нет.

### 23.2. HTTPS после проверки DNS

- В **06:29:28** проверка DNS прошла: TXT, трафик и CAA подтверждены, домен перешёл в
  `configuring`. Caddy перезагрузил конфигурацию и выполнял HTTP-01 challenge: apex —
  **06:29:36–06:29:37**, `www` — **06:29:44**.
- Сертификаты при этом уже существовали: оба выпущены в **05:31 UTC** (Let's Encrypt,
  `CN=nestdevtest.ru` и `CN=www.nestdevtest.ru`). Значит, проблема была не в отсутствии
  сертификата, а в окне активации/перезагрузки Caddy после проверки DNS.
- HTTPS-активация — отдельный асинхронный процесс: `activateCustomDomains` раз в 60 секунд
  делает TLS-пробу на NLB с SNI домена. Пока после reload маршрут/сертификат не подхвачен
  на всех нодах, проба может вернуть ошибку (например, несовпадение имени); она
  записывается в `certificate_error`, и панель показывает её как ошибку HTTPS.
- В **06:31:09** обе строки (`nestdevtest.ru` и `www.nestdevtest.ru`) стали `active`,
  `certificate_status = active`, `certificate_error` очищен. Точная строка промежуточной
  ошибки не сохранилась: успешная активация её перезаписывает.
- После перезагрузки страница прочитала уже `active` — поэтому «всё заработало само».

**Вывод:** это не сломанный HTTPS и не ошибка DNS. Панель показывала промежуточный отказ
TLS-пробы как окончательную ошибку, хотя сертификат уже существовал, а Caddy завершал
активацию маршрута после reload. Нужно отделять `issuing_certificate` («активируем, до
2 минут») от реальной ошибки и не сбрасывать этот статус обратно в `configuring` при каждой
8-секундной проверке DNS.

### 23.3. Проверено сейчас

- `https://nestdevtest.ru` — **200**, сертификат Let's Encrypt `CN=nestdevtest.ru`,
  `notBefore=15.11.2026 05:31 UTC`, `notAfter=13.02.2027`.
- `https://www.nestdevtest.ru` — **301** на `https://nestdevtest.ru/`.
- `http://nestdevtest.ru` — **308** на HTTPS.
- DNS: `nestdevtest.ru` и `www.nestdevtest.ru` → `178.236.27.102`.
- `https://nestdevtest.ru/no-such-page` — **200**: это штатный SPA-fallback Caddy для путей
  без расширения. Отсутствующие файлы с расширением дают **404** (`/no-such-page.js`,
  `/assets/missing.js`, `/missing.png`). Для SPA это правильно; для статического сайта с
  отдельными страницами нужен другой режим.

### 23.4. Что исправлено 15.11.2026 (выкачено 43731449753)

1. **Холодный старт:** `apiJson` централизованно ловит `409 PROJECT_RESTORING`, ждёт
   `Retry-After` (или exponential backoff) и повторяет запрос; окно ожидания — 2 минуты.
   Общий ответ вынесен в `sendProjectRestoreError`: сервер отдаёт `Retry-After: 2` и
   `retryAfter` в теле. `WorkspaceShell` по-прежнему не монтирует панели, пока идёт wake.
2. **HTTPS:** `verifyDomainGroup` больше не сбрасывает `issuing_certificate` в `configuring`
   на каждом 8-секундном опросе и очищает старую `certificateError` после успешной DNS-проверки.
   Активация запускается сразу после проверки, а не ждёт минутного тика. Добавлено поле
   `certificate_started_at`: панель показывает промежуточную ошибку не раньше чем через
   120 секунд, до этого — «сертификат выпускается». Ошибка TLS-пробы сохраняется, но не
   переводит домен в окончательный `error` и не ломает `/api/tls-ask`.
3. **Тесты:** добавлены гонка «restore + два параллельных `/changes`» с проверкой `409` и
   `Retry-After`, сохранение `issuing_certificate` при повторной DNS-проверке и переход
   `configuring → issuing_certificate → active`; web-тест проверяет retry API-клиента.
4. **Наблюдаемость:** каждый отказ TLS-пробы пишется в лог с `hostname` и номером попытки;
   после 120 секунд в строке появляется длительность серии.

Проверки рабочего дерева: сервер 1909 тестов (1899 passed, 10 skipped, 0 failed), web 8/8,
broker 30/30, оба `tsc` — 0. Для выкатки нужна миграция
`site_domains.certificate_started_at`; DDL добавляет колонку через
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

### 23.5. Что осталось

- e2e с повторной загрузкой страницы во время restore/выпуска (локально нет Docker/Postgres).
- Проверка custom domains при падении `node-1` и переходе на `node-2` — нужен двухнодовый
  прогон после выкатки.
- SEO-этапы из [`SEO_PLATFORM_PLAN.md`](SEO_PLATFORM_PLAN.md) (этап 5) не начаты.

## 24. 15.11.2026: выкатка AI-стека и UI custom domains

- `d14676f` (run `43704849397`) — AI-стек: карта репозитория, тесты, память, milestone-план
  и reviewer. Deploy успешен на обеих нодах; `[agent] экспериментальные возможности
  выключены (все AGENT_* флаги = 0)`.
- `1886858` (run `43706263691`) — UI/диагностика custom domains и preview: DNS-имена
  относительно зоны, подсказка о задержке DNS, `publicUrl` в ответе `preview/start`,
  `settled` для static, клиентские тексты без имён env-переменных. Deploy успешен на обеих
  нодах; `node-1` и `node-2` отдают `build=18868585d5da...` на `/api/health` и `/api/ready`.
- Публичный `https://nestdev.ru/api/health` и `/api/ready` — `200`; таймеры хранения и
  владельцев песочниц active на обеих нодах; в логах контейнеров нет error/fatal.
- `AGENT_*` флаги после выкатки остаются выключены. Пункты 23.4 (холодный старт, промежуточный
  HTTPS-статус) реализованы в рабочем дереве и входят в раздел 25; на момент run `43706263691`
  они ещё не были выкачены. SEO-этапы из [`SEO_PLATFORM_PLAN.md`](SEO_PLATFORM_PLAN.md) не
  начаты.

## 25. 15.11.2026: HA deploy invariants, owner-aware preview и последние исправления

Эта секция фиксирует изменения, которые были в рабочем дереве до выкатки. Выкатка
[`43731449753`](https://github.com/misha4323223/WebNestdev/actions/runs/43731449753)
завершилась успешно на обеих нодах.

### 25.1. HA: PITR, общий storage и выкатка

- **PITR.** `deploy/ha/pitr.py` перед promotion готовит WAL-архив на standby через уже
  установленный `webnestdev-pg-pitr setup` и при необходимости один раз перезапускает
  `postgresql@17-main` через systemd. На primary архив только проверяется: автоматического
  рестарта работающей primary нет. Если `archive_mode` всё ещё `off`, в журнал пишется явная
  ошибка, а состояние `archive_ready` сохраняется в HA-state.
- **Storage.** `storage_ready()` проверяет все тома `HA_STORAGE_PATHS` — `data`, `sandboxes`,
  `sites`, а не один `/var/lib/webnestdev/sandboxes`. `storage_quorum.ensure()` возвращает
  результат, проверяет `cluster.quorum-type` после `set` и кеширует неудачную попытку;
  promotion повторно проверяет storage уже после fencing peer'а. `standby.sh` запускает
  PostgreSQL через `systemctl`, чтобы сработал start-guard, а не обходил его.
- **Выкатка.** `deploy/ha/runtime-files.txt` — единый список runtime-файлов для
  `install-node1.sh`, `install-node2.sh` и `deploy/scripts/node2-sync.sh`. Синхронизация
  копирует файлы и unit'ы на обе ноды, сверяет SHA-256 и перезапускает контроллер при
  изменении. `SYNC_NODE2` по умолчанию равен `1`; ошибки обновления runner'а и HA-кода теперь
  завершают выкатку ошибкой. В CI добавлены `bash -n` для HA-скриптов и тест манифеста.
- **Фактическое состояние на 15.11.2026, 20:45 UTC после выкатки:** `node-1` — primary, `node-2` —
  streaming standby, обе включены (`node-2 power=ON`), все три Gluster-тома смонтированы на
  обеих нодах, `cluster.quorum-type=auto`. На обеих нодах `archive_mode=on`; на `node-2`
  контроллер сам выполнил `pg-pitr setup` и один перезапуск standby, на `node-1` архив уже
  работал. Таймеры basebackup, WAL-prune и PITR-S3 active на обеих нодах.

### 25.2. Hosting и custom domains

- Холодный старт проекта: `apiJson` повторяет запрос при `409 PROJECT_RESTORING`, учитывает
  `Retry-After`/`retryAfter` и ограничивает ожидание двумя минутами. Серверный ответ вынесен
  в `sendProjectRestoreError`: `Retry-After: 2` и прогресс возвращаются одинаково из общего
  error handler и из тестового приложения.
- HTTPS: `issuing_certificate` больше не сбрасывается в `configuring` при каждой 8-секундной
  DNS-проверке; успешная проверка очищает старую `certificateError` и сразу запускает
  активацию. Добавлено `certificate_started_at`; первые 120 секунд панель показывает
  «сертификат выпускается», а не окончательную ошибку.
- Миграция `site_domains.certificate_started_at` выполняется автоматически через
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; старые JSON-файлы dev-режима получают `null`.

### 25.3. Preview на двух нодах

- `previewAccessFor()` выбирает локальный адрес, если preview принадлежит этой реплике, и
  публичный owner-aware адрес с билетом, если владелец — другая нода. Это убирает ложные
  проверки `127.0.0.1:<port>` на чужой реплике; абсолютные URL в путь проверки не
  пропускаются.
- `previewOwnerReachable()` делает короткую TCP-проверку двери владельца с TTL и объединением
  одновременных запросов. Если владелец недоступен, статус получает `ownerUnavailable`, а
  панель не показывает живой preview и не пытается запускать его на чужой ноде.
- Логи static/hybrid на другой реплике читаются через внутренний маршрут двери
  (`/__internal/preview/logs` → `/api/internal/preview/logs`) с Bearer-токеном двери;
  `touch:false` не продлевает жизнь контейнеру. Для отката остаётся
  `PREVIEW_OWNER_AWARE=0`.
- `browser.*`, `browser.runtime`, `browser.perf`, screenshot и verification используют тот же
  owner-aware доступ и ставят билет до первой навигации; проверка через прокси панели больше
  не превращает успешный owner-aware результат в ложный провал.

### 25.4. Инструменты агента

- `npm.install` выбирает `npm`/`pnpm`/`yarn`/`bun` по `packageManager` и lock-файлу;
  для npm с lock используется `npm ci`, для остальных — frozen-режим. В ответ добавлены
  `packageManager` и `installCommand`.
- `project.test` в режиме `sandbox:true` берёт изменённые файлы из `git status`, запускает
  только affected-тесты с `--maxWorkers=1`/`--test-concurrency=1` и честно возвращает
  `not_run`, если безопасно сузить запуск нельзя. Полный suite вслепую не запускается.
- `terminal.exec` при таймауте возвращает готовый `terminal.start` с тем же command/cwd, а не
  голую ошибку; команда не повторяется автоматически, потому что могла уже изменить проект.

### 25.5. Проверки

- server: **1939** тестов, 1929 passed, 10 skipped, 0 failed;
- web: 8/8; broker: 30/30; HA: 58/58;
- `tsc -b --noEmit` и `tsc -p server/tsconfig.json --noEmit` — 0 ошибок;
- `bash -n` для HA-скриптов, dry-run `node2-sync` и `git diff --check` — успешно.

**Выкатка 43731449753:** обе ноды отдают `build=faf5e2b40f5de58a9d431da77a68facce9babc45`
на `/api/ready`; HA-код установлен на обе ноды с подтверждённым SHA; `node-2` переведена на
тот же образ; egress-проверки прошли; публичный `https://nestdev.ru/api/ready` — 200.

Остаётся проверить реальный failover и owner-aware preview с другой реплики; Caddy/egress-политика
в этот этап не входила.

## 26. 17.11.2026: локальный кэш релизов и выкатка

Проверено **17.11.2026, 16:52 UTC** после первой выкатки `6e3cffc` (workflow
`44128872359`), затем после docs-выкатки `5caacee` (workflow `44130766967`):

- `node-1` и `node-2` отдают `build=5caacee1e00b769a2e5edb9652efce246f4009d1`;
- на обеих нодах `HOSTING_LOCAL_RELEASES=1`, `HOSTING_KEEP_RELEASES=3`,
  `HOSTING_S3_ENABLED=auto`, `HOSTING_SHARED_STORAGE=1`;
- локальных каталогов релизов на общем `sites` — **4** (по одному активному на сайт),
  `du` — **17 МиБ**, свободно **7,0 ГиБ**;
- `reconcile` на обеих нодах: `sites=3`, `orphans=4/5`, `errors=0`; старые версии остаются
  в бакете, с диска вытеснены;
- публичный API `https://nestdev.ru/api/ready` — 200, `my-furniture.host.nestdev.ru` — 200.

Ограничение: `HOSTING_MIN_FREE_BYTES=5G` пока не менялся. При активном кэше 50 сайтов
займут ~3,5 ГиБ raw, после чего свободного места останется меньше резерва. Для 50 активных
сайтов нужно отдельное решение: добавить диск или снизить резерв; история сайтов теперь
диск не занимает.

Профильные тесты хостинга — 80/80, `cache.test.ts` — 3/3, сборка сервера и оба typecheck —
0 ошибок. Полный серверный suite в этой сессии не завершился из-за 180-секундного лимита
терминала (более 2000 тестов без падений до остановки).

## 27. 18.11.2026: API-хост `api.nestdev.ru` выкачен и проверен

Проверено **18.11.2026, 07:20–07:25 UTC** после того, как reg.ru опубликовал относительную
запись `A api -> 178.236.27.102` (SOA сменился на `1794957778`).

- DNS: публичный резолвер отдаёт `api.nestdev.ru -> 178.236.27.102`; TLS — Let's Encrypt,
  `subject=CN api.nestdev.ru`, срок до 16.02.2027, `ssl_verify_result=0`.
- Внешний `GET https://api.nestdev.ru/bmg/api/products?limit=1` — 200, JSON каталога.
- Внешний preflight `OPTIONS /bmg/api/orders` — 204, `access-control-allow-origin: *`,
  разрешены `POST` и `content-type`.
- Внешний `POST /bmg/api/orders` — 201. Присланная цена `1` проигнорирована: сервер
  пересчитал `8900 + 390 = 9290`, создан тестовый заказ `BM-1811-4606`.
- `bmg` перепубликован на `node-2` (release `670169f8-942e-4c76-9337-8ba31e7a5414`,
  `static-functions`, 4 функции, 4333044 байта архива). Сайт `live`, active release
  переключён; HTML через CDN — 200 и содержит `/_webnestdev/api-bridge.js`; мост ведёт на
  `https://api.nestdev.ru/bmg`; CSS через CDN — 200.
- Обе ноды на `775d2979d656`; локальный `/api/ready` на `node-1` и `node-2` и публичный
  `https://nestdev.ru/api/ready` — 200.

Тестовые заказы, созданные при проверке: `BM-1711-9017` (внутренняя проверка 17.11.2026),
`BM-1811-4606` (внешняя проверка 18.11.2026) и `BM-1811-3215` (проверка после включения
лимита). Их нужно удалить или оставить осознанно; автоматической очистки нет.

## 28. 18.11.2026: per-IP лимит на API-двери функций

Причина: `api.nestdev.ru` идёт напрямую в NLB, мимо CDN, поэтому WAF, bot protection и edge
rate limit на POST не действуют. Конкурентный `functionLimiter` ограничивал только
одновременные контейнеры, но не частоту запросов с одного источника.

Что сделано:

- `server/src/functions/api-rate-limit.ts` — отдельный модуль; ключ
  `functions:api:<siteId>:<ip>`, окно 60 секунд, по умолчанию 120 запросов;
- счётчик использует существующий `storage/rate-limit-store.ts` (PostgreSQL в production,
  файл локально), поэтому окно общее для обеих нод и не обнуляется рестартом;
- лимит применяется только к API-хосту, после проверки сайта и до чтения манифеста/запуска
  контейнера; `OPTIONS` обслуживается раньше и окно не расходует;
- при превышении — `429`, `Retry-After` и JSON `{code:"RATE_LIMITED"}`; CORS-заголовки
  остаются, чтобы браузер мог прочитать ошибку;
- префикс доверенного прокси уже настроен (`WEBNESTDEV_TRUSTED_PROXIES`), в двери функций
  включён `trustProxy`, поэтому считается реальный IP, а не адрес Caddy;
- настройка `FUNCTIONS_API_RATE_LIMIT_PER_MINUTE` (по умолчанию 120) добавлена в
  `docker-compose.yml`;
- ошибка хранилища трактуется как fail-open: недоступная база не блокирует заказы, причина
  пишется в лог.

Проверки:

- профильные тесты — 18/18, `tsc -p server/tsconfig.json --noEmit` — 0 ошибок;
- выкатка `db534474f381` (run `44259985492`) на обе ноды, обе отдают этот build;
- `GET https://api.nestdev.ru/bmg/api/products?limit=1` — 200;
- `OPTIONS /bmg/api/orders` — 204, CORS `*`, `content-type` разрешён;
- `POST /bmg/api/orders` — 201, цена `1` пересчитана в 8900, доставка 390, итого 9290,
  заказ `BM-1811-3215`;
- серия 125 быстрых запросов на несуществующий путь того же сайта: 120 ответов 404,
  затем 5 ответов 429; первый `429` — на 121-м запросе, `Retry-After: 38`;
- у `429` есть `access-control-allow-origin: *` и `retry-after`;
- после окна `GET` снова 200.

Ограничение: лимит считается по IP, поэтому распределённый поток с многих адресов он не
остановит; для этого нужен WAF/anti-DDoS на NLB или включение POST в CDN. Лимит также не
заменяет антиспам на форме заказа.

## 29. 18.11.2026, 15:25 UTC: клиентская база платформы на двух нодах

Отдельный кластер для баз клиентов поднят на обеих нодах и проверен живым failover.
Платформенный `17/main` на `:5433` не тронут.

- `17/client` на порту **5434**, данные на локальном диске ноды (не Gluster),
  `/var/lib/postgresql/17/client`; потоковая репликация, слот `client_standby`.
- `node-1` — **primary**, `node-2` — **standby**, `streaming`, лаг в норме. Обе машины
  включены.
- PgBouncer 1.26.1 на приватных адресах: `10.0.0.4:6432` и `10.0.0.5:6432`,
  transaction pooling, `auth_query` + `auth_file=/etc/pgbouncer/userlist.txt`.
- Пароли (репликация и `pgbouncer_auth`) — только в `/etc/webnestdev/client-db.env`
  (root:root, 600) на каждой ноде; в репозитории и документации их нет.
- Юниты: `webnestdev-client-db.service`, `webnestdev-client-db-failover.timer` (каждые 20 с,
  promote после 2 подтверждений), `...-quota.timer` (03:15 UTC), `...-backup.timer`
  (02:30 UTC). Скрипты: `/usr/local/sbin/webnestdev-client-db-{failover,backup}`,
  установка — `deploy/ha/client-db/install.sh primary|standby|pgbouncer`.
- Учения 18.11.2026: остановка кластера `node-1` → `node-2` стала primary за ~30 с,
  запись через её PgBouncer прошла; rejoin `node-1` — standby, данные на месте (2 строки).
  Обратно: остановка `node-2` → `node-1` primary за ~50 с; rejoin `node-2` — standby.
  Итог — исходная топология, `node-1` primary / `node-2` standby.
- Бэкап проверен: дамп схемы `pg_dump -Fc` создаётся, `backup.sh list` его видит.
  Тестовая схема, роль и дамп после проверки удалены.
- Найдено и исправлено по ходу: `pg_hba` без адреса соседа; PgBouncer без `auth_file`;
  отсутствие слота на новом primary после promotion; ошибка кавычек в `ALTER ROLE`.
  Главное: старая логика считала ошибку авторизации за «соседа нет» и поднимала второй
  primary — теперь `unknown` не даёт promotion, только сетевая недоступность.

Ограничения на эту дату: серверный код с `database.client` и `CLIENT_DB_*` **не выкачен**,
фича в API выключена; таймер квот `webnestdev-client-db-quota.timer` **выключен** на обеих
нодах до выкатки (в текущем образе нет `dist/scripts/client-db-quota.js` и `CLIENT_DB_ADMIN_URL`),
включать вместе с выкаткой; PITR для клиентских схем не включён; автоматического rejoin нет —
вернувшуюся ноду готовят `install.sh standby`; загрузка дампов в S3 — только через хук
`CLIENT_DB_BACKUP_UPLOAD`. Диск `node-2` — 19 ГБ (свободно ~6,3 ГБ), под реальных клиентов
его нужно увеличивать по плану.

Связанные документы:

- [`CLIENT_DATABASE_PLAN.md`](CLIENT_DATABASE_PLAN.md) — план и реализация клиентской базы;
- [`HOSTING_CACHE_PLAN.md`](HOSTING_CACHE_PLAN.md) — план разделения S3-истории и локального кэша;
- [`HA_TWO_NODE_REMAINING.md`](HA_TWO_NODE_REMAINING.md) — незакрытые шаги двухнодового HA;
- [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md) — порядок production-запуска и проверки;
- [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md) — целевая HA-схема;
- [`HA_BIDIRECTIONAL_PLAN.md`](HA_BIDIRECTIONAL_PLAN.md) — результаты failover;
- [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) — выкатка и Docker.
