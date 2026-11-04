# Статический хостинг: журнал внедрения

Документ ведётся по этапам `docs/STATIC_HOSTING_PLAN.md`. Здесь только факты: что сделано,
что не сделано, что реально проверено и что пока не проверялось. «Код написан» не означает
«работает на ВМ».

## Итог на 2026-11-04

Реализован вертикальный срез для пилота: сайт = запись в БД + каталог релизов, публикация
из статической сборки/instant-site, атомарный `current`, API, вкладка «Хостинг», Caddy-блок,
лимиты, скан артефакта и `__Host-` cookie панели. PostgreSQL-DDL написан, но **не применялся**
к живой базе в этом окружении; Docker и DNS здесь недоступны. После последних правок
`reconcile`/`pruneOldReleases`, health-срез и переход из мастера развёртывания повторно
пройдены typecheck сервера и фронтенда, 32 профильных теста и полный серверный suite
**1418/1418**; подробности — в этапе 7.

## Этапы

### Этап 0. Решения и замеры

| Пункт | Статус | Проверка |
|---|---|---|
| Сайт — запись + каталог релизов, не процесс | сделано | архитектура в `server/src/hosting` |
| Лимиты 50 МБ / 25 МБ файл / 5 000 файлов / 3 релиза | сделано | `server/src/hosting/config.ts`, значения настраиваются env |
| Домен из трёх меток, Caddy `labels.3` | сделано | `HOSTING_PUBLIC_DOMAIN` требует ровно 3 метки; `caddy validate` + `caddy adapt` прошли |
| TLS для пилота — on-demand | выбрано | Caddyfile; **не проверено** получение сертификата |
| Wildcard TLS / DNS-01 | **не сделано** | нужен кастомный Caddy/ACME; отдельный этап |
| Замеры 10 реальных сборок | **не сделано** | нет рабочего Docker в окружении |

### Этап 1. Модель и хранилище

| Пункт | Статус | Проверка |
|---|---|---|
| `sites`, `site_releases`, `hosting_slug_history` в PostgreSQL | код DDL есть | `server/src/storage/pg.ts`; **DDL не выполнен на живой БД** |
| JSON fallback для dev/test | сделано | `server/src/hosting/site-store.ts` |
| Один сайт на проект | сделано | unit: повторное создание возвращает тот же сайт |
| `SITES_DIR`, проверка отделения от `DATA_DIR` | сделано | `config.ts`, `paths.ts`; unit путей |
| Slug/releaseId | сделано | стартовый 12 hex или пользовательская DNS-метка 3–63; releaseId UUID-подобный; unit путей |
| Store: begin/finish/fail/unpublish/suspend/restore/delete | сделано | 7 unit-тестов JSON-режима |
| PostgreSQL-блокировки `FOR UPDATE` + partial unique `building` | код есть | **не проверено** без PostgreSQL |
| Unit-тесты | сделано | `node --import tsx --test "server/src/hosting/*.test.ts"` — 30/30 (store, пути, артефакты, slug, public env, health-срез) |
| Откат на готовый релиз | сделано | `activateRelease` в store; JSON-тест переключает active и сохраняет историю |

Не сделано: миграция существующих данных (их нет), проверка DDL на реальном PostgreSQL,
восстановление после падения процесса между записью БД и файловой системой (есть reconcile,
но он не проверялся на стенде).

### Этап 2. Публикация

| Пункт | Статус | Проверка |
|---|---|---|
| Определение `instant-site` / `static-build` | переиспользовано | `preview/project-kind.ts` |
| Сборка в песочнице | сделано | `hosting/publisher.ts`; **Docker здесь отсутствует, живьём не запускалось** |
| Публичные env без секретов | сделано | `public-env.ts`, маски `.env*`, allowlist префиксов; unit: приватное имя не попадает, заглушка `.env.local` удаляется после сборки |
| Проверка артефакта (symlink, `.env`, `.git`, source map, hardlink, FIFO, лимиты) | сделано | `artifact.ts`; 7 unit-тестов, включая symlink, hardlink/FIFO и секрет |
| staging → rename → `current` | сделано | `artifact.ts`, `paths.ts`; unit атомарного current |
| Неудачная сборка не меняет активный релиз | код есть | store unit; **end-to-end сборки не проверялся** |
| Очистка каталога/манифеста неудачного релиза | сделано | `publisher.ts`: удаляет target, если `current` не указывает на него; иначе пишет warning |
| Лог сборки с redaction | сделано | `security.ts`, `site-store.failPublish` |
| Fixture Vite / instant-site | **не сделано** | нужен Docker/полный sandbox-стенд |

### Этап 3. Caddy и edge

| Пункт | Статус | Проверка |
|---|---|---|
| Блок `*.host` | сделано | `deploy/Caddyfile`; `caddy validate` — «Valid configuration» |
| Общий `/api/tls-ask` для preview + hosting | сделано | `routes/hosting.ts` |
| Compose: общий `SITES_DIR`, Caddy read-only | сделано | `docker-compose.yml`; YAML разобран PyYAML, **`docker compose config` не запускался** (Docker нет) |
| Entrypoint: владелец `SITES_DIR` | сделано | `sh -n server/entrypoint.sh`; на реальном томе не проверялось |
| `make-env-vm.sh` создаёт `HOSTING_SITES_DIR` и переносит `HOSTING_*` | сделано | `bash -n`; **на ВМ не запускался** |
| DNS `*.host` | **не сделано** | требуется запись у DNS-провайдера |
| Получение TLS, HTTPS smoke | **не сделано** | нет DNS/ВМ в этом окружении |
| 404 неизвестного поддомена | код Caddy есть | проверено только адаптацией конфига, не запросом |
| Проверка отсутствия `.env`/`.git` и SPA-fallback | код Caddy есть | не проверено HTTP-запросами |

### Этап 4. API

| Пункт | Статус | Проверка |
|---|---|---|
| Статус, создание, публикация, unpublish, delete | сделано | `routes/hosting.ts` |
| Читаемый адрес сайта | сделано | `POST /hosting` принимает `slug`, `PATCH /hosting/slug`; история старых адресов в `hosting_slug_history`; route-тест |
| История и лог релиза | сделано | `GET /releases/:id/log` |
| Ownership | сделано | `requireProject` |
| Коды ошибок и лимиты | сделано | `HostingError` |
| Suspend/restore для администратора | сделано | `/api/admin/hosting/...` |
| Reconcile | сделано | `reconcile.ts`, запуск после инициализации БД |
| Route-тесты / curl-сценарий | частично | 4 route-теста (ownership, create/get/unpublish/delete, rollback с файлами, пользовательский адрес); реальный curl на ВМ — ещё нет |
| Откат на конкретный релиз | сделано | `POST .../releases/:releaseId/rollback`, `activateRelease`, переключение `current` и откат ссылки при ошибке БД; route-тест с файлами |

### Этап 5. UI

| Пункт | Статус | Проверка |
|---|---|---|
| Вкладка «Хостинг» | сделано | `WorkspaceNav`, `WorkspaceContent` |
| Создание/публикация/снятие/удаление | сделано | `src/features/hosting/HostingPanel.tsx` |
| Выбор и смена адреса | сделано | поле названия при создании и кнопка «Изменить» у адреса; **визуально не проверялось** |
| Polling статуса, ошибки, лог | сделано | 2,5 с, пока есть `building` |
| Мобильная версия и стили | сделано | CSS `hosting-*`; **визуально не проверялось** |
| Откат на прежний релиз | сделано | кнопка «Вернуть» у готового неактивного релиза |
| Ссылка из `DeploymentWizard` для статики | сделано | для `static` карточка NestDev Cloud ведёт во вкладку «Хостинг»; для серверных проектов остаётся «Скоро». Typecheck пройден, **визуально не проверялось** |

### Этап 6. Защита и лимиты

| Пункт | Статус | Проверка |
|---|---|---|
| Cookie isolation | сделано | `__Host-` сессия на HTTPS; unit `session-cookie` |
| Секреты не попадают в публичную сборку | сделано | маски + публичный allowlist; точные значения не монтируются |
| Скан секретов в артефакте | сделано | unit: известный ключ и точное значение |
| Служебные файлы агента не публикуются | сделано | `TASKS.md`, `AGENTS.md`, `CLAUDE.md` в `FORBIDDEN_NAMES`; применяется к `instant-site` |
| Запрет symlink/hardlink/FIFO/dotfiles | сделано | unit symlink, hardlink и FIFO; dotfiles проверяются сканером артефакта |
| Квоты аккаунта | сделано | `hosting/usage.ts` включён в `storage-quota` |
| Диск/глобальный лимит | код есть | `limits.ts`; на реальном диске не проверялся |
| Admin suspend/restore | сделано | API + audit |
| Abuse/жалобы/rate limit публикаций | **не сделано** | suspend только вручную администратором |
| Очистка старых релизов | сделано | `pruneOldReleases`, `reconcile`; `markReleaseDeleted` сначала атомарно «занимает» строку и не трогает активный релиз, только потом удаляет файлы |
| Health-метрики хостинга | сделано | внутренний `/api/health` → `hosting`: enabled/domain/nodeId/sharedStorage, sites/live/releases/bytes, diskFreeBytes, lastPublishAt, failures24h; публичный ответ поле не получает. JSON-ветка `hostingHealth()` проверена unit-тестом; PostgreSQL-агрегат **не проверялся** без живой БД |

Текущая граница: **изоляция сборки — главная защита**. Скан секретов ловит известные форматы
и точные значения, но не может гарантировать отсутствие произвольного секрета в коде.
Публичная сборка не получает приватных переменных, но если секрет захардкожен в исходнике,
он останется в файле. Это ограничение нужно писать в UI/документации, а не считать скан
полной защитой.

### Этап 7. Тесты, выкатка, пилот

- typecheck сервера и фронтенда пройден, в том числе повторно после последних правок
  `reconcile.ts` и `markReleaseDeleted`/`pruneOldReleases`;
- unit хостинга/путей/артефактов/slug/public env/сессии пройдены;
- 3 route-теста API пройдены (ownership, create/get/unpublish/delete, rollback с файлами);
- профильный прогон (`hosting/*.test.ts` + `routes/hosting.test.ts` + `routes/health.test.ts`
  + `session-cookie.test.ts`) — **32/32**;
- полный серверный test suite пройден повторно: **1418/1418** (`npm test --workspace=server`);
- deploy на ВМ, DNS, HTTPS, smoke, архив/удаление проекта — **не проверялись**;
- визуальная проверка вкладки «Хостинг» — **не выполнялась**;
- Docker publish, PostgreSQL DDL и TLS — **не проверялись**;
- пилот 5–10 проектов — **не начат**.

### Этап 8. Бакет

Сделано:

- `server/src/hosting/release-store.ts` — `S3ReleaseStore` поверх существующего
  `PLATFORM_S3_*` (второй бакет не заводится);
- один релиз — два объекта: `hosting/<userId>/<siteId>/releases/<releaseId>.tar.gz` и
  `.../<releaseId>.json`; префикс задаётся `HOSTING_S3_PREFIX` (по умолчанию `hosting`);
- архив загружается **до** переключения `current` и фиксации в БД; при ошибке S3 публикация
  падает, старый сайт продолжает работать, объекты неудачного релиза удаляются;
- в `site_releases` теперь реальные `storage_key`, `manifest_key`, `stored_bytes` (размер
  `tar.gz`, а не распакованного каталога);
- откат и `reconcile` восстанавливают активный релиз из бакета, если локального каталога нет;
  содержимое сверяется с БД по `sha256` и числу файлов, а не принимается на слово;
- `pruneOldReleases` и удаление сайта/проекта убирают объекты из бакета;
- режим `HOSTING_S3_ENABLED=auto|0|1`: `auto` включает бакет при настроенных `PLATFORM_S3_*`,
  `0` принудительно оставляет релизы на диске, `1` требует бакет и падает с явной ошибкой,
  если он не настроен;
- профильные тесты `release-store.test.ts` — 4/4 (архив с картинками/видео, восстановление,
  подмена/отсутствие архива, удаление обоих объектов, явная ошибка при `HOSTING_S3_ENABLED=1`
  без `PLATFORM_S3_*`); typecheck сервера пройден.

Не проверено: реальная загрузка/скачивание в S3-совместимом бакете, поведение при обрыве сети,
публикация релиза на 50 МБ, PostgreSQL-ветка и боевая выкатка. Медиа, которое посетители
загружают во время работы сайта, этим этапом не покрывается: для него нужен серверный
рантайм/CDN (этап 9). Картинки и видео, входящие в опубликованную статическую сборку, лежат
в релизном `tar.gz` в бакете; рабочая копия проекта остаётся на ВМ, потому что агенту и
dev-серверу нужен обычный POSIX-доступ, а Caddy отдаёт локальный горячий кэш.

## Несколько ВМ: что уже учтено и чего ещё нет

Уже учтено:

- `sites.node_id` и `site_releases.node_id` пишутся с первого дня; при создании сайта
  API проверяет, что проект не закреплён за другим узлом без общего `SITES_DIR`;
- блокировка публикации — PostgreSQL, а не in-memory: `SELECT ... FOR UPDATE` + partial unique
  индекс на `building` (у JSON-режима — процессный lock, только для dev);
- `HOSTING_SHARED_STORAGE=1` означает, что все узлы видят один `SITES_DIR`; без него сайт,
  созданный на узле A, нельзя публиковать с узла B — API отвечает `503 PROJECT_REMOTE`;
- `reconcile` не трогает каталоги сайтов, закреплённых за другим узлом, если нет общего тома;
- Caddy на каждом узле читает локальный (или общий) `SITES_DIR` read-only.

Чего ещё нет:

- **маршрутизации edge → узел сайта**. Сейчас при разных `SITES_DIR` запрос должен попадать
  на узел, где создан сайт; балансировщик/edge этого не знает;
- общего `SITES_DIR` (NFS/общий volume) в инфраструктуре; флаг только проверяет согласие
  оператора, а не создаёт том;
- координации объектного хранилища между узлами: релиз восстанавливается из бакета, но
  активный `current` и горячий кэш по-прежнему привязаны к узлу;
- согласованной очистки старых релизов между узлами (если один узел удаляет каталог, второй
  ещё может отдавать `current`; нужен общий том или координация);
- sticky-сессий публикации: частично закрыто БД-локом, но фоновый build, начатый на убитом
  узле, останется `building` до `markStaleBuilds`;
- квоты на узел, а не на аккаунт: `HOSTING_GLOBAL_BYTES` сейчас общий для всех сайтов, но
  без учёта свободного места других узлов.

Рекомендуемый следующий шаг для нескольких ВМ: один общий `SITES_DIR` (или edge-узел с
копированием релизов) + Caddy на edge, читающий общий том. Пока это не сделано, вертикальный
срез рассчитан на одну ВМ (или на общий том, который оператор настроил сам).

## Исправлено после первого прохода

- `unpublished` больше не показывает рабочий URL: адрес зарезервирован, но `current` снят;
- создание сайта на узле, где нет файлов проекта, отклоняется (`PROJECT_REMOTE`) вместо
  создания непубликуемой записи; при общем `SITES_DIR` используется узел проекта;
- placeholder `.env.local`, созданный для публичного mount, удаляется после сборки;
- entrypoint отдельно отвергает совпадение `SITES_DIR` с `DATA_DIR`/`SANDBOX_DIR`, а не только
  вложенность;
- добавлены проверки hardlink/FIFO и route-тесты API;
- `reconcile` читает активный релиз отдельно от последних 100 строк истории: после отката на
  старый релиз он больше не снимает работающий `current`;
- `reconcile` удаляет каталоги `failed`/`deleted` релизов и осиротевшие manifests, но не трогает
  `building` живого процесса;
- каталог сайта со статусом `deleted` убирается на его узле (или на любом при общем `SITES_DIR`);
- `markReleaseDeleted` возвращает `boolean` и защищает активный релиз; `pruneOldReleases`
  удаляет файлы только после успешного claim строки;
- `TASKS.md`, `AGENTS.md`, `CLAUDE.md` исключены из публикуемого артефакта;
- health получил отдельный агрегат `hostingHealth()` без N+1 по сайтам; для loopback-запроса
  добавлен блок `hosting`, публичный ответ его не содержит;
- в мастере развёртывания статический проект ведёт из карточки NestDev Cloud прямо во вкладку
  «Хостинг».

## Переменные

```text
HOSTING_ENABLED=0|1
HOSTING_PUBLIC_DOMAIN=host.example.ru        # ровно 3 метки
HOSTING_TLS_MODE=on_demand|wildcard          # wildcard пока не реализован в Caddyfile
HOSTING_SITES_DIR=/var/lib/webnestdev/sites  # хост, монтируется в /srv/sites
WEBNESTDEV_SITES_DIR=/srv/sites              # внутри контейнера
HOSTING_SHARED_STORAGE=0|1
HOSTING_MAX_RELEASE_BYTES, HOSTING_MAX_FILE_BYTES, HOSTING_MAX_FILES
HOSTING_KEEP_RELEASES, HOSTING_BUILD_TIMEOUT_MS, HOSTING_MAX_RELEASE_SECONDS
HOSTING_BUILD_CONCURRENCY, HOSTING_GLOBAL_BYTES, HOSTING_MIN_FREE_BYTES
HOSTING_MAX_SITES
```

## Что запускать для проверки

```bash
npx tsc -p server/tsconfig.json --noEmit
npx tsc -b --noEmit
node --import tsx --test "server/src/hosting/*.test.ts" server/src/routes/hosting.test.ts server/src/auth/session-cookie.test.ts
sh -n server/entrypoint.sh
/tmp/caddy-check/caddy validate --config deploy/Caddyfile --adapter caddyfile
```

На ВМ дополнительно: `docker compose config`, `docker compose up -d`, проверить
`/api/hosting/tls-ask`, HTTPS тестового сайта, 404 неизвестного поддомена, 404
`/.env`, `/assets/missing.js`, сохранность `SITES_DIR` после выкатки и после удаления проекта.

## Откат

- выключить `HOSTING_ENABLED=0` (новые публикации и изменения из панели; уже выданные сайты
  Caddy продолжает отдавать);
- при откате образа на версию без `/api/tls-ask` откатить и Caddyfile: иначе новые сертификаты
  перестанут выдаваться;
- не удалять `SITES_DIR` при откате: это состояние, как `DATA_DIR`;
- для аварийного снятия конкретного сайта — admin suspend (снимает `current`) или
  `POST .../hosting/unpublish`.
