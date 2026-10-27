# Админ-приложение: состояние работ

Дата записи: **2026-10-25, ~19:40 UTC**. Это точка остановки, к которой можно вернуться
в новой сессии: что уже работает, что осталось и где лежат доступы.

## Точка остановки 2026-10-27: картинка видна в чате и в проекте

Состояние: код готов локально, ещё не отправлен. Генерация изображений уже работала, но человек
не мог посмотреть результат: в панели «Файлы» картинка была «двоичным файлом», а в чате её не было.

Что добавлено:

- `image.generate` принимает `show: true` — так модель отмечает просьбу **показать** картинку. В этом
  случае результат несёт `shownInChat: true` и `url`, и панель рисует картинку в переписке под
  ответом; нарисованное для самого проекта идёт без этого флага и в чате не появляется;
- `GET /api/projects/:id/asset?path=…` отдаёт картинку проекта браузеру (только PNG, JPEG, WebP,
  GIF, AVIF, BMP, ICO; SVG исключён), а `GET /file` для картинок больше не упирается в предел
  текстового файла;
- панель «Файлы» показывает картинку целиком и даёт открыть её в новой вкладке; в доке действий
  `image.generate` тоже есть миниатюра;
- правило в системном промпте: рисовать для пользователя — с `show: true`, для проекта — без него.

Проверка после выкатки: в чате попросить «нарисуй кота» — карточка с картинкой должна появиться в
переписке; открыть `public/images/<имя>.png` во вкладке «Файлы» — видно изображение, а не заглушку.
Если карточки нет, а файл создан — смотреть, пришёл ли в результате инструмента `shownInChat`.

## Точка остановки 2026-10-27: выкатка с генерацией изображений прошла

Состояние: изменения отправлены в `main` (`bc0ac53` + `aa13a50`, push `f4ed448..aa13a50`),
прогоны `CI` `40455671576`, `production-ci` `40455671625` и `deploy` `40455671633` — все
`success`. Выкатка сама прогнала 991 тест сервера перед сборкой образа.

Подтверждено логами прогона `40455671633` (именно эти строки есть только в новой версии кода):

```
[deploy] Генерация изображений: адрес=есть, модель=@cf/black-forest-labs/flux-1-schnell, ключ=есть
[container] webnestdev-server-1 | [image] генерация изображений: Cloudflare Workers AI (@cf/black-forest-labs/flux-1-schnell), ключей 1
[container] webnestdev-server-1 | [agent] бесплатный тариф: Agnes AI (agnes-3.0-flash), ключей 3, резерв — Yandex Cloud AI Studio
```

То есть переменные из GitHub Actions доехали на ВМ, а бесплатная модель тарифа не изменилась.

**Что осталось проверить (живой запрос):** доступность Cloudflare с ВМ. Инструмент проверяется в
чате любого проекта: «нарисуй фотографию кота для главной» — агент вызовет `image.generate`,
и в логе сервера появится строка `[image] @cf/black-forest-labs/flux-1-schnell -> 200 bytes=…`
(прочитать: `Actions → deploy → Run workflow → mode=logs`, при необходимости `tail=400`).
Если вместо этого `ok:false` с отказом — смотреть текст ошибки в чате и строку `[image] … -> <код>`
в логе; самый частый случай — адрес в `PLATFORM_IMAGE_BASE_URL` оканчивается на `/ai/v1` вместо
`/ai/run` (тогда будет 404). Ключ `PLATFORM_IMAGE_KEY_1` читается **только из Secrets**: если он попал
в Variables, строка выкатки сказала бы «ключ=нет». Проверить списки сам не могу: у ключа Freebuff нет
прав на чтение (`gh variable list` → HTTP 403).

## Обновление 2026-10-27: генерация изображений для агента (инструмент `image.generate`)

**Второй модели нет — решено окончательно.** Cloudflare в проекте нужен не как ещё один
chat-провайдер, а как **инструмент**: агент по просьбе пользователя рисует картинку и кладёт файл
в проект (обложка, фон, карточка товара, аватар), а код потом ссылается на этот ассет. Поэтому
ранее добавленный второй бесплатный провайдер (`PLATFORM_AI_FREE_CF_*`) **откатан**: бесплатная
цепочка прежняя — Agnes AI (`agnes-3.0-flash`), три ключа, резерв — Yandex Cloud AI Studio.

Новые имена переменных — **`PLATFORM_IMAGE_*`**: отдельный набор, он не пересекается ни с
`PLATFORM_AI_*`, ни с `PLATFORM_AI_FREE_*`, поэтому «A repository variable with this name already
exists» на них не появится.

| Имя | Где заводить в GitHub | Значение |
|---|---|---|
| `PLATFORM_IMAGE_BASE_URL` | Variables или Secrets | `https://api.cloudflare.com/client/v4/accounts/<Account ID>/ai/run` |
| `PLATFORM_IMAGE_MODEL` | Variables или Secrets | `@cf/black-forest-labs/flux-1-schnell` (или `@cf/stabilityai/stable-diffusion-xl-base-1.0`) |
| `PLATFORM_IMAGE_PROVIDER` | Variables или Secrets | `Cloudflare Workers AI` (необязательно) |
| `PLATFORM_IMAGE_KEY_1..3` | **только Secrets** | API-токены Cloudflare с правом `Workers AI: Read` |

Те же шесть имён есть в панели «Ключи сервера» (группа «AI»): там вводить проще, значение из панели
важнее окружения и переживает выкатку — но тогда строка выкатки скажет «нет», и это не ошибка.

Где правки: `server/src/provider/image-generation.ts` (адрес, тело запроса, разбор ответа, перебор
ключей), `server/src/tools/image-tools.ts` (инструмент `image.generate`), тесты
`image-generation.test.ts` и `image-tools.test.ts`, `server/src/index.ts` (регистрация и строка
`[image] …` при старте), `server/src/agent-runtime.ts` (в планировщике инструмент запрещён),
`server/src/agent/tool-executor.ts` (учёт места проекта), `server/src/platform/platform-env.ts`
(каталог панели), `docker-compose.yml`, `.github/workflows/deploy.yml` (обе ветки выкатки плюс
строка `[deploy] Генерация изображений: …`), `docs/PLATFORM_AI.md` (раздел «Генерация изображений
для проектов»).

Проверка после выкатки — в логе сервера (`Actions → deploy → mode=logs`):

```
[image] генерация изображений: Cloudflare Workers AI (@cf/black-forest-labs/flux-1-schnell), ключей 1
```

Нет строки или написано «PLATFORM_IMAGE_* не заданы» — значения не доехали: смотрите
`[deploy] Генерация изображений` и панель «Ключи сервера». Сам инструмент проверяется запросом в
чате: «нарисуй фотографию кота для главной» — агент вызовет `image.generate`, а в проекте появится
файл `public/images/…`. Ключ Cloudflare нужно положить самому: в репозитории и в этом файле его нет
и быть не должно.

## Если понадобится: заменить бесплатную модель (Agnes остаётся по умолчанию)

У бесплатной модели тарифа «Старт» остаётся Agnes AI, а имя провайдера в логах и подписях задаётся
`PLATFORM_AI_FREE_PROVIDER` (по умолчанию `Agnes AI`). Если бесплатную модель когда-нибудь придётся сменить на другую OpenAI-совместимую, ей нужны вызов
инструментов и контекст не меньше `AGENT_CONTEXT_TOKENS` (по умолчанию 120 000): значения
`PLATFORM_AI_FREE_BASE_URL`, `PLATFORM_AI_FREE_MODEL` и ключи `PLATFORM_AI_FREE_KEY_1..3` в этом
случае просто перезаписываются — отдельных имён не заводится. Шаги, лимиты и цены —
`docs/PLATFORM_AI.md`, разделы «Бесплатный тариф» и «Подключение Cloudflare Workers AI».

## Обновление 2026-10-26: второй бесплатный провайдер (Cloudflare) — откатан

**Итог: второй провайдер из кода убран.** Cloudflare вошёл в проект инструментом генерации
изображений (`PLATFORM_IMAGE_*`, см. выше), а второй набор для разговора (`PLATFORM_AI_FREE_CF_*`)
удалён из `free-model.ts`, каталога панели, `docker-compose.yml` и выкатки: бесплатная цепочка
снова одна — `PLATFORM_AI_FREE_*` (Agnes) с резервом на модель платформы. Если в `.env` на ВМ
остались значения `PLATFORM_AI_FREE_CF_*`, они просто не используются — стирать их не обязательно.

## Обновление 2026-10-26: обращения с карточкой пользователя

Админка теперь получает не только текст обращения, но и подробности об авторе:

- при отправке в тикет кладётся снимок аккаунта — имя и почта для связи, телефон, способы входа,
  тариф, дата регистрации, число проектов и последняя активность;
- `GET /api/support/tickets` отдаёт этот снимок в каждом тикете и дополняет старые обращения, у
  которых снимка ещё не было;
- `GET /api/support/tickets/<id>` отдаёт сам тикет, **живую** карточку автора (подписка, последние
  проекты, дневной расход, месячный пул токенов) и до 20 прошлых обращений;
- письмо поддержки теперь тоже содержит имя, телефон, тариф и активность: при настроенной почте
  платформы (`MAIL_*`, Postbox) письма уходят от подтверждённого домена, личный `SUPPORT_SMTP_*`
  остаётся запасным путём;
- в тикете сохраняется IP отправителя.

Код: `server/src/support/support-user.ts`, `server/src/routes/support.ts`,
`server/src/support/support-store.ts`. Тесты: `support-user.test.ts`, `support-store.test.ts`,
`support-mail.test.ts`, `routes/support-detail.test.ts`, `routes/support.test.ts`,
`routes/support-admin.test.ts` — все проходят. Контракт и пример ответа — `docs/ADMIN_API.md`,
раздел 8.

**Что осталось на стороне приложения:** нарисовать в Expo/Electron экран «Поддержка»: список
(`GET /api/support/tickets`), карточка (`GET /api/support/tickets/<id>`) со скриншотом через
`Image` с заголовком `Authorization`, и блок «прошлые обращения». Отдельный ключ не нужен —
подойдёт та же админ-сессия.

## Обновление 2026-10-26: журнал безопасности (аудит P1 #11)

Закрыт пункт бэклога безопасности «нет аудита изменений ключей платформы, удаления проектов,
неудачных входов».

- Новый журнал `server/src/security/audit-journal.ts`: отдельный от `secret-audit` (тот — про
  секреты проекта, этот — про вход и платформу). Записи не меняются задним числом, лучший
  вариант — JSONL `security-audit.jsonl` в `DATA_DIR`, в Postgres — таблица `security_audit`
  с индексами по времени и действию.
- Пишутся 13 событий: входы администратора (по паролю, успех, отказ, лимит попыток, код
  восстановления) и второй фактор, перевыпуск кодов, «выйти везде», изменение ключей платформы,
  удаление проекта, регистрация и неудачные входы пользователей, отзыв их сессий. Значений
  ключей, паролей, TOTP-секретов и кодов восстановления в журнале нет по построению — только
  имена, счётчики и причины; IP хранится хешем.
- Чтение для админки: `GET /api/admin/audit?limit=&action=&actorId=&days=` — события, каталог
  действий для фильтра и диапазон. Опечатка в имени действия даёт `400`, а не пустой список.
  Контракт и таблицы — `docs/ADMIN_API.md`, раздел 9.
- Код: `server/src/security/audit-journal.ts`, `server/src/routes/admin-audit.ts`,
  запись — в `routes/admin.ts`, `auth.ts`, `platform.ts`, `projects.ts`. Тесты:
  `security/audit-journal.test.ts`, `routes/admin-audit.test.ts` — проходят.

**Что осталось на стороне приложения:** экран «Безопасность» — список событий с фильтром по
действию из каталога `actions` ответа, без нового ключа: подойдёт админ-сессия.

## Обновление 2026-10-26: расходы и экономика подписки

Добавлена денежная статистика — то, чего не хватало, чтобы выбирать цену подписки по
себестоимости, а не на глаз.

- `GET /api/admin/stats/costs` — расход по моделям, дням, пользователям, проектам и тарифам.
  `totals.complete` и `warnings` честно говорят, если у модели нет цены и сумма неполная.
- `GET /api/admin/stats/economics` — оплаты за период, MRR, расход, маржа, экономика каждого
  тарифа, себестоимость подписчика и рекомендуемая цена под заданную маржу (`margin`, по
  умолчанию 0,7).
- Цены моделей — `PLATFORM_AI_MODEL_PRICES` (JSON за 1M токенов, ключ ищется как часть имени
  модели); общая ставка `PLATFORM_AI_PRICE_*` осталась запасным вариантом. `free-model`
  считается нулём. Постоянные расходы — `PLATFORM_INFRA_COST_PER_MONTH`.
- Контракт и формулы — `docs/ADMIN_API.md`, разделы 7.2–7.4. Код —
  `server/src/routes/admin-economics.ts`, `server/src/account/model-pricing.ts`.
- Тесты: `server/src/account/model-pricing.test.ts` (6) и
  `server/src/routes/admin-economics.test.ts` (7); всего 13. Сборка сервера проходит.

### Что добавить в GitHub перед проверкой

В **Settings → Secrets and variables → Actions → Variables** (это не секреты):

| Переменная | Значение |
|---|---|
| `PLATFORM_AI_PRICE_CURRENCY` | `RUB` — иначе расходы не сравнятся с выручкой |
| `PLATFORM_AI_MODEL_PRICES` | JSON из `docs/ADMIN_API.md`, раздел 7.3, **одной строкой** |
| `PLATFORM_INFRA_COST_PER_MONTH` | постоянные расходы в месяц (ВМ, диск, бакет, SMS, домен), необязательно |
| `PLATFORM_AI_PRICE_INPUT_PER_MILLION` / `..._OUTPUT...` | необязательно; общая ставка, если таблицы нет |

Выкатка теперь прокидывает все пять переменных в `.env` на ВМ, а `docker-compose.yml` передаёт их
в контейнер (раньше `PLATFORM_AI_PRICE_*` вообще не доезжали). После выкатки в логе будет строка
`[deploy] Цены расхода: …` — по ней видно, что значения дошли, не раскрывая сами цены.

### Что проверить и что осталось

1. После выкатки открыть `GET /api/admin/stats/costs?days=30`: `pricing.configured` и
   `totals.complete` должны быть `true`, `warnings` — пустым, `totals.modelCost` — ненулевым.
2. Открыть `GET /api/admin/stats/economics?days=30`: `currencies.comparable: true`, при наличии
   подписок — `revenue.mrr` и `priceGuidance`. Если `priceGuidance` пуст, проверить валюту и цены
   моделей.
3. Сверить цены за 1M токенов с консолью Yandex Cloud: заниженная цена даст заниженную
   себестоимость и слишком низкую рекомендацию.
4. Нарисовать в Expo/Electron два экрана: «Расходы» (карточки итогов, график по дням, таблица
   моделей, топ пользователей и проектов) и «Экономика» (выручка/расход/маржа, таблица тарифов,
   `priceGuidance` с подписью «цена под маржу»).
5. SQL новых маршрутов на живом Postgres ещё не выполнялся: в песочнице его нет. Это первая
   проверка после выкатки, как и у прежней статистики.

Точная стоимость запусков, ушедших на платный резерв бесплатного тарифа, пока неизвестна: в
`model_usage` они записаны как `free-model`. Для этого нужно писать фактический адрес модели, а не
`free-model`, — отдельная задача; сейчас админка предупреждает об этой границе.

## Обновление 2026-10-26: имена в GitHub — ничего переименовывать не нужно

Короткий ответ на «надо поменять переменные, чтобы не повторялись»: **нет**. Имя переменной — это
адрес, по которому выкатка её читает; переименование в настройках репозитория означает, что
значение молча перестанет доезжать до ВМ (пустое значение выкатка просто пропускает и ничего не
стирает).

Что означают сообщения в окне **Settings → Secrets and variables → Actions**:

- «Variable names may only contain alphanumeric characters … cannot start with GITHUB_ prefix» — это
  постоянная подсказка окна про правила имени, а не жалоба на конкретное имя. `PLATFORM_AI_FREE_BASE_URL`,
  например, полностью подходит: латинские буквы, цифры и `_`.
- «A repository variable with this name already exists» — имя **уже заведено в этой же вкладке**.
  Пересоздавать нечего: значение правится кнопкой на существующей строке. Имена сравниваются без
  учёта регистра, поэтому `platform_ai_free_base_url` — то же самое имя.
- В поле **Name** идёт только имя. Значение (`https://…`, JSON, текст) кладётся в поле **Value**:
  `=`, `:`, `/`, точка, дефис, пробел и кириллица в имени запрещены.

**Variables и Secrets — два разных списка, и одно и то же имя может лежать в обоих.** Выкатка почти
всюду читает `secrets.X || vars.X`, то есть значение берётся из Secrets, а если его там нет — из
Variables. Поэтому «повтор» между вкладками — не ошибка и не повод что-то менять. Единственное
место, где имя в настройках GitHub вынужденно другое: `GITHUB_` зарезервирован, поэтому OAuth панели
заводится как `GH_OAUTH_CLIENT_ID` / `GH_OAUTH_CLIENT_SECRET`, а в `.env` на ВМ попадает под
обычными именами `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

Где что заводить (по `.github/workflows/deploy.yml`):

| Где | Имена |
|---|---|
| **Только Secrets** — из Variables не доедут | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `YANDEX_SA_KEY_JSON`, `YANDEX_CLOUD_ID`, `YANDEX_FOLDER_ID`, `PLATFORM_AI_API_KEY`, `PLATFORM_AI_FREE_KEY_1..3`, `PLATFORM_IMAGE_KEY_1..3`, `PLATFORM_S3_ACCESS_KEY_ID`, `PLATFORM_S3_SECRET_ACCESS_KEY`, `WEBNESTDEV_ADMIN_EMAILS`, `WEBNESTDEV_ADMIN_USER_IDS`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `SUPPORT_SMTP_PASSWORD`, `MAIL_SMTP_PASSWORD`, `POSTBOX_IAM_TOKEN`, `POSTBOX_SECRET`, `POSTBOX_SA_KEY` |
| **Только Variables** | `DEPLOY_RUNNER`, `DEPLOY_APP_DIR`, `GH_CALLBACK_URL`, `GH_FRONTEND_URL`, `GITLAB_BASE_URL`, `GITLAB_CALLBACK_URL`, `GITLAB_FRONTEND_URL`, `YANDEX_CALLBACK_URL`, `YANDEX_FRONTEND_URL`, `YANDEX_OAUTH_SCOPE` |
| **Любая из двух вкладок** (`secrets.X \|\| vars.X`) | `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`, `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `GITVERSE_CLIENT_ID`, `GITVERSE_CLIENT_SECRET`, `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`, `WEB_SEARCH_PROVIDER`, `YANDEX_SEARCH_API_KEY`, `YANDEX_SEARCH_FOLDER_ID`, `TAVILY_API_KEY`, `PLATFORM_AI_BASE_URL`, `PLATFORM_AI_MODEL`, `PLATFORM_AI_PROVIDER`, `PLATFORM_AI_FREE_BASE_URL`, `PLATFORM_AI_FREE_MODEL`, `PLATFORM_AI_FREE_PROVIDER`, `PLATFORM_IMAGE_BASE_URL`, `PLATFORM_IMAGE_MODEL`, `PLATFORM_IMAGE_PROVIDER`, `PLATFORM_AI_PRICE_INPUT_PER_MILLION`, `PLATFORM_AI_PRICE_OUTPUT_PER_MILLION`, `PLATFORM_AI_PRICE_CURRENCY`, `PLATFORM_AI_MODEL_PRICES`, `PLATFORM_INFRA_COST_PER_MONTH`, `PLATFORM_S3_ENDPOINT`, `PLATFORM_S3_BUCKET`, `PLATFORM_S3_REGION`, `PLATFORM_S3_PREFIX`, `PROJECT_ARCHIVE_ENABLED`, `PROJECT_ARCHIVE_IDLE_MINUTES`, `SUPPORT_API_KEY`, `SUPPORT_EMAIL_TO`, `SUPPORT_EMAIL_FROM`, `SUPPORT_SMTP_HOST`, `SUPPORT_SMTP_PORT`, `SUPPORT_SMTP_USER`, `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_FROM`, `MAIL_FROM_NAME`, `BILLING_NOTICE_DAYS`, `POSTBOX_SENDER`, `POSTBOX_FROM_NAME`, `PLATFORM_URL`, `POSTBOX_ENDPOINT`, `POSTBOX_KEY_ID`, `POSTBOX_SA_KEY_FILE`, `POSTBOX_DAILY_LIMIT`, `POSTBOX_RATE_PER_SECOND`, `POSTBOX_DKIM_SELECTORS`, `POSTBOX_PRICE_PER_1000` |

Пароль администратора — значение секрета `ADMIN_BOOTSTRAP_PASSWORD` (Secret, не Variable);
администратор `pimashin2015@gmail.com` уже создан и перезаписи не подлежит.

Что было заведено, а чего не было на момент последней выкатки: лог запуска `40371284915` (коммит
`f4ed448`) показывает OAuth GitHub/GitLab/GitVerse/Яндекс — «есть», веб-поиск — «есть», холодный
ярус — «есть» (бакет `webnest`, включён), а цены расхода — «таблица моделей=нет, общая ставка=нет,
инфраструктура=нет, валюта=USD» и поддержка — «ключ API=нет, почта=—, SMTP=нет». То есть
`PLATFORM_AI_MODEL_PRICES`, `PLATFORM_AI_PRICE_CURRENCY=RUB`, `PLATFORM_INFRA_COST_PER_MONTH`
(и `SUPPORT_*`, если нужны письма поддержки) — то, что добавляется после; `PLATFORM_AI_PRICE_*`
необязательны. Почта платформы (`MAIL_*`, Postbox) появилась позже — её ключи берутся в кабинете
Yandex Cloud и заводятся по таблице выше (пошагово — docs/MAIL.md).

Как проверить, что значения доехали: переменные передаются на ВМ только выкаткой, поэтому после
правок нужно запустить Actions → **deploy** → *Run workflow* (правки кода для этого не нужны) и
посмотреть строки `[deploy] Цены расхода: …`, `[deploy] Поддержка: …`,
`[deploy] Почта платформы: сервер=…, отправитель=…, пароль=…` и `[deploy] Рассылка: отправитель=…,
ключ=…, DKIM-селекторы=…, предел=…/сутки` — в них только «есть/нет», без самих значений.
Строка `[deploy] Холодный ярус: …` уже показывает бакет и включённость.

Рассылке (в отличие от писем об оплате) нужен не только ключ, но и подтверждённый домен:
`GET /api/admin/mail/overview` отдаёт `configured` и `domain.verified`, а `domain.hint`
перечисляет недостающие DNS-записи. Что где заводить — docs/MAIL.md, раздел 4.

## Где мы остановились

- Последняя выкатка: коммит `f4ed448`, запуск деплоя `40371284915` — зелёный (2026-10-26).
- Перед ней: `5a920a0` / `40278805041` (статистика), `66eecca` / `40226033125` (вход с TOTP).
- **Администратор создан** из окружения: `pimashin2015@gmail.com` (строка в логе сервера
  `admin account created from environment`).
- **TOTP ещё не подключён.** Первый вход в приложении вернёт `stage: "enroll"` — это ожидаемо.
- Пароль администратора — значение секрета `ADMIN_BOOTSTRAP_PASSWORD` в GitHub. В репозитории и в
  этом файле его нет.
- **Бесплатная модель тарифа «Старт» — Agnes AI (три ключа) с резервом на Yandex; провайдера
  решено не менять** (подробности и запасной вариант — в разделе про Cloudflare выше).

## Что готово в коде

Отдельная дверь для админки, не связанная с пользователями панели и её cookie:

| Метод и путь | Назначение |
|---|---|
| `POST /api/admin/login` | пароль → `challenge` + стадия `enroll`/`verify` |
| `POST /api/admin/2fa/setup` | секрет TOTP и `otpauth`-ссылка |
| `POST /api/admin/2fa/enable` | подтвердить фактор, получить токен и 10 recovery-кодов |
| `POST /api/admin/2fa/verify` | код TOTP или recovery → токен |
| `POST /api/admin/2fa/recovery` | перевыпустить recovery-коды |
| `GET /api/admin/me` | кто вошёл и до какого времени |
| `POST /api/admin/logout`, `/logout-all` | закрыть вход / все входы |
| `GET /api/admin/stats/*`, `/api/admin/users`, `/api/admin/projects` | статистика для экранов админки (только чтение) |
| `GET /api/admin/audit` | журнал безопасности для экрана «Безопасность» (только чтение) |
| `GET /api/admin/infra` | снимок хоста: диск, Docker, песочницы, бакет и база (только чтение) |
| `GET /api/admin/sandboxes` | песочницы списком: `state=cold|running|never|all`, `limit` 1…200 |
| `GET /api/admin/infra/prune` | что освободит безопасная очистка Docker и что останется (только чтение) |
| `POST /api/admin/infra/prune` | безопасная очистка: только кэш сборки и висячие образы, тело `{confirm: true}` |
| `GET /api/admin/users/:id/restriction` | заблокирован ли аккаунт и кем (только чтение) |
| `POST /api/admin/users/:id/sessions/revoke` | завершить все сеансы аккаунта, тело `{confirm: true}` |
| `POST /api/admin/users/:id/block` | блокировка входа и отзыв сеансов, тело `{confirm: true, reason?}` |
| `POST /api/admin/users/:id/unblock` | снять блокировку, тело `{confirm: true}` |
| `POST /api/admin/users/:id/plan` | тариф без оплаты, тело `{confirm: true, plan, months?}` |
| `POST /api/admin/users/:id/tokens` | надбавка к пулу текущего месяца, тело `{confirm: true, tokens}` |
| `GET /api/admin/billing?days=&limit=` | платежи, подписки, истекающие, калибровка пула |
| `GET /api/admin/projects/:id` | карточка проекта: репозиторий, превью, переменные, выкатка |
| `PATCH /api/support/tickets/:id/status` | статус обращения; `GET /api/admin/support/stats` — очередь и важность |

Детали, потоки и curl — `docs/ADMIN_API.md`. Статистика и её контракт — раздел 7 там же
(`server/src/routes/admin-analytics.ts`); инфраструктура — раздел 7.5
(`server/src/routes/admin-infra.ts`); безопасная очистка Docker — раздел 7.6
(`server/src/routes/admin-prune.ts`); действия над аккаунтом — 7.7 (`server/src/routes/admin-users.ts`);
реестр платежей и калибровка пула — 7.8 (`server/src/routes/admin-billing.ts`); карточка проекта — 7.9
(`server/src/routes/admin-projects.ts`).

- Аккаунты отдельные (`server/src/admin/*`), пароль — scrypt, TOTP-секрет зашифрован
  `WEBNESTDEV_ENCRYPTION_KEY`, recovery-коды — sha256, сессии — sha256 токена.
- Сессия: 8 часов всего, 30 минут бездействия (`ADMIN_SESSION_TTL_MS`, `ADMIN_SESSION_IDLE_TTL_MS`).
- Лимиты попыток: те же счётчики, что у входа пользователей (`adminLogin`, `adminTotp`).
- Первый админ без терминала: `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`
  (передаются из GitHub Secrets в `.env` на ВМ, сервер создаёт запись при старте и не перезаписывает
  существующую).
- CLI на сервере: `create`, `password`, `reset-2fa`, `list`
  (`node server/dist/scripts/admin-cli.js …` внутри контейнера `webnestdev-server`).

Тесты: `server/src/admin/totp.test.ts` (векторы RFC 6238), `server/src/admin/bootstrap.test.ts`,
`server/src/routes/admin.test.ts`, `server/src/routes/admin-prune.test.ts`,
`server/src/routes/admin-users.test.ts`, `server/src/routes/admin-billing.test.ts`,
`server/src/routes/admin-projects.test.ts`, `server/src/routes/support-status.test.ts`.
Последний полный прогон — **1081 тест, все проходят**.

## Следующие шаги

1. **Войти в админ-приложении** адресом и паролем из секретов. Пройти подключение TOTP, сохранить
   10 кодов восстановления (показываются один раз).
2. **После входа заменить `ADMIN_BOOTSTRAP_PASSWORD`** на длинную случайную строку (буквы и цифры)
   и выкатить снова. Пока администратор существует, значение не действует, но лежит открытым
   текстом в `.env` на ВМ; удалить секрет недостаточно — пустые значения выкатка пропускает.
3. **Клиенты.** Expo: токен в `expo-secure-store`, QR из `otpauth` через `react-native-qrcode-svg`,
   только HTTPS. Electron: запросы из main-процесса, токен через `safeStorage`; `file://` в
   `WEBNESTDEV_ADMIN_ORIGINS` не работает — нужен `app://…` или main-процесс.
4. **Следующая задача по приложению:** экраны под новые маршруты — «Действия» в карточке
   пользователя (раздел 7.7), «Деньги» с реестром платежей и шкалой пула (7.8), карточка проекта
   (7.9), статус и сводка обращений (8.4–8.5). Бэкенд готов, контракты и curl — в
   `docs/ADMIN_API.md`. Ключи платформы (`/api/platform/keys`) по-прежнему требуют
   пользовательскую сессию и `WEBNESTDEV_ADMIN_EMAILS`: если админка должна ими управлять,
   их надо перевести на админ-сессию.

   Ещё нет на сервере: `GET /api/admin/deployments` — списка выкаток не существует ни в одном
   хранилище (план лежит в `deploy_project.md` внутри песочницы, а история выкаток не пишется),
   поэтому маршрут потребовал бы новой таблицы и записи в пайплайне, а не только чтения.
5. **Из бэклога безопасности** (`docs/SECURITY.md`): Docker-брокер вместо `docker.sock` (P1 #5),
   аудит действий администратора (P1 #11) — сделан журналом `security_audit`; дальше политика
   паролей (#12), подтверждение email (#13) и лимит чтения ключа поддержки (#10).

## Как проверить, что всё ещё так

```bash
gh run list --workflow=deploy.yml --limit 3      # последние выкатки
gh run view <id> --job <deploy-job-id> --log     # лог выкатки
```

На ВМ (веб-консоль MTS или SSH):

```bash
cd ~/webnestdev/src
docker compose exec webnestdev-server node server/dist/scripts/admin-cli.js list
```

`list` покажет, подключён ли TOTP и сколько осталось кодов восстановления. `password` выдаёт новый
пароль (TOTP сохраняется), `reset-2fa` сбрасывает фактор и отзывает все входы.

## Что осталось непроверенным

- Вход из самого приложения и подключение TOTP на телефоне — на стороне приложения.
- Реальная отправка SMS и поведение на боевом трафике — вне этой задачи.
- Postgres-ветка админ-хранилища проверена типами и боевым созданием админа; отдельного теста на
  живом Postgres нет (тесты идут на JSON-хранилище).
- Запросы статистики проверены типами и тестами на арифметику периода, но не выполнены на живом
  Postgres: в песочнице его нет. После выкатки открыть любой экран статистики в админке — это и есть
  первая настоящая проверка SQL.
- Очистка Docker проверена с подставным Docker (настоящие `docker builder prune` в тестах не
  запускаются — они убирали бы кэш машины, где идут тесты): на живой ВМ нужен один прогон
  `GET /api/admin/infra/prune` и проверка, что число остановленных контейнеров до и после
  `POST` совпадает (раздел 7.6 в `docs/ADMIN_API.md`).
