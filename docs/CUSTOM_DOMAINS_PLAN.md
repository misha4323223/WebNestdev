# Custom domains: production plan and live status

Дата создания: **13.11.2026**  
Статус: **этапы 1–3 реализованы; Caddy 2.11.8, общий caddy-data и reload-таймер выкачены на node-1 и проверены; end-to-end custom domain и HA ещё не проверены; feature flag выключен**
Основание: решения пользователя от 13.11.2026.

Этот документ — не просто описание. По нему ведётся реализация, и он обновляется после каждого
проверенного этапа. Нельзя отмечать пункт выполненным без теста, проверки на production-подобной
схеме и записи в журнале ниже.

## 0. Как обновлять этот документ

После каждого этапа:

1. Изменить строку в таблице «Живой статус».
2. Записать, что именно проверено, какой командой и с каким результатом.
3. Добавить ссылку на файлы/PR/коммит, если они есть.
4. Если проверка провалилась — оставить статус `заблокировано` или `в работе`, описать причину и
   не искать обходной путь, который не подходит для production.
5. Не записывать сюда секреты, содержимое `.env`, приватные ключи и токены.

## 1. Решения, которые считаются принятыми

| Вопрос | Решение |
|---|---|
| Тарифы | Custom domain входит в «Плюс» и «Премиум». На «Старте» — недоступно. |
| Количество | Один custom domain + `www`-алиас на сайт. |
| Основной адрес | Выбирает пользователь: apex или `www`; второй адрес — 301 на основной. |
| TLS | Caddy/Let’s Encrypt для обычного домена; MWS Certificate Manager — для CDN-варианта. |
| CDN | Только «Премиум», отдельный этап. Для CDN основной адрес — `www`, apex — 301. |
| Apex | Поддерживаем A-запись на NLB. Если DNS клиента умеет ALIAS/ANAME, можно использовать CNAME на наш target. |
| SEO | Один canonical-хост, 301 с остальных вариантов, HTTPS, корректные 404, без soft-404. |
| Подход | Только production-путь. Если проверка инфраструктуры не проходит — остановиться и разобраться, а не упрощать схему в ущерб надёжности. |

## 2. Живой статус

| Этап | Статус | Обновлено | Что проверено / что дальше |
|---|---|---|---|
| Анализ и решения | готово | 13.11.2026 | Архитектура, ограничения MWS, UI-схема, SEO и план ниже. |
| 0. Проверка предпосылок | частично; остаются NLB API и HA | 14.11.2026 | SSH восстановлен. DNS `nestdev.ru`/`host.nestdev.ru`/`custom.nestdev.ru` на NLB подтверждён; NLB TCP 80/443 доступен; Caddy 2.11.8 работает на node-1; `node-2` включена и standby. Статичность IP через MWS API не подтверждена. |
| 1. Данные и верификация | DDL и API готовы; PG-таблица создана, live-домен не проверен | 13.11.2026 | `public.webnestdev_site_domains` создана на живой БД, столбцы/индексы проверены; нормализация, TXT/A/CNAME/CAA, API, лимит, аудит, transfer, cascade; 28 тестов. |
| 2. Caddy, TLS и HA | инфраструктура выкачена; end-to-end не проверен | 14.11.2026 | Caddy 2.11.8, общий `caddy-data` с перенесёнными сертификатами, `custom-domains.caddy`, reload-таймер active; validate/reload проверены, включая автоматический reload. `node-2` включена и standby; HA и custom TLS ждут тестового домена. |
| 3. UI | реализовано и выкачено; feature flag выключен | 13.11.2026 | Мастер домена, тарифный gate, DNS-записи и копирование, автопроверка, статусы, canonical и удаление. В production скрыт за `CUSTOM_DOMAINS_ENABLED`. |
| 4. SEO и приёмка | не начато | — | 301, HTTPS, 404, apex/www, IDN. |
| 5. CDN для «Премиума» | не начато | — | MWS CDN, CM, purge, canonical `www`. |
| 6. Пилот и выкатка | не начато | — | 3–5 реальных доменов, HA, runbook. |

## 3. Цели и границы

### Входит

- один custom domain и его `www`-алиас на сайт;
- подтверждение владения через DNS TXT;
- apex через A-запись, `www` через CNAME;
- автоматический выпуск, продление и проверка TLS;
- 301 на выбранный основной адрес;
- статусы и понятные ошибки в панели;
- лимиты тарифов, аудит, админское приостановление;
- корректная работа на двух нодах;
- CDN для «Премиума» отдельным этапом.

### Не входит в первую версию

- произвольные wildcard-домены (`*.example.com`);
- несколько независимых custom domains на один сайт;
- автоматическое создание DNS-записей через API регистратора;
- собственный DNS-сервер;
- CDN для «Плюса»;
- перенос почтовых записей и управление MX;
- кастомные сертификаты, загруженные клиентом.

## 4. Текущее состояние и инварианты

### Факты

- Сайт: `<slug>.host.nestdev.ru`.
- Caddy отдаёт `/srv/sites/<slug>/current`.
- `*.host.nestdev.ru` идёт через MWS CDN; origin — NLB `178.236.27.102`.
- NLB работает на TCP 80/443 и не терминирует TLS.
- `node-1` — primary, `node-2` — streaming standby и включена; целевой production — обе ноды.
- На живой `node-1` работает `caddy:2.11.8-alpine` (`src-caddy-1`) с digest из compose.
- Живой `caddy-data` перенесён из локального `src_caddy-data` в общий
  `CADDY_DATA_HOST_DIR` (`/var/lib/webnestdev/data/caddy-data`); старые сертификаты на месте,
  публичный `https://nestdev.ru` отвечает `200`. Резервная копия старого тома сделана перед
  выкаткой.
- `custom-domains.caddy` генерируется API в `/var/lib/webnestdev/data/caddy-custom`;
  Caddy читает каталог `/etc/caddy/custom` только на чтение. Пустой файл уже проверен
  `caddy validate`; реальные блоки появятся после подключения домена.
- `webnestdev-caddy-reload.timer` активен и включён в автозапуск; автоматический reload после
  изменения общего файла проверен на `node-1`.
- `/api/tls-ask` разрешает preview, `host`-сайты и custom domains в состояниях
  `configuring`, `issuing_certificate`, `active`; ответ custom domain кешируется на 15/5 секунд,
  а смена статуса инвалидирует кеш. Реальный выпуск на живом домене ещё не проверен.
- В PostgreSQL создана таблица `public.webnestdev_site_domains` (префикс `getTable`);
  столбцы, check-ограничения и уникальные индексы проверены. Строк пока нет: feature flag
  выключен, реальные домены не подключались.
- `custom.nestdev.ru` → `178.236.27.102` (A, TTL 3600); target для CNAME-инструкции готов.
- `host.nestdev.ru` — bare CNAME-target без собственного site-блока. TLS-ошибка на нём
  ожидаема: wildcard `*.host.nestdev.ru` не покрывает само имя; это не custom domain.

### Что уже реализовано (этап 1)

- `server/src/hosting/domain-name.ts` — нормализация, punycode/PSL, запрет IP, URL, wildcard,
  локальных и платформенных имён; пара apex + `www` создаётся только для обычного домена.
- `server/src/hosting/domain-types.ts` — типы домена, группы, статусов и DNS-инструкций.
- `server/src/hosting/domain-config.ts` — feature flag и проверяемые настройки:
  `CUSTOM_DOMAINS_ENABLED` (по умолчанию **выключен**), `CUSTOM_DOMAIN_TARGET`
  (по умолчанию `custom.nestdev.ru`), `CUSTOM_DOMAIN_IP` (только IPv4,
  по умолчанию `178.236.27.102`), `CUSTOM_DOMAIN_DNS_SERVERS`.
- `server/src/hosting/domain-dns.ts` — injectable resolver; отдельные проверки TXT, A/CNAME и CAA.
  TXT проверяется для каждого hostname, apex не подтверждает `www`. CAA учитывает `issue`, а не
  `issuewild`; при отсутствии `issue` выпуск не блокируется.
- `server/src/hosting/domain-store-json.ts` и `domain-store-pg.ts` — общее API хранилища.
  PostgreSQL: группа создаётся в транзакции, сайт блокируется `FOR UPDATE`, поэтому два
  одновременных запроса не превышают лимит; `UNIQUE(hostname)` и один canonical на сайт.
  JSON-ветка имеет process-local lock и используется для разработки и тестов.
- `server/src/hosting/domain-service.ts` — тарифный gate, создание, DNS-инструкции, проверка,
  canonical, истечение неподтверждённой заявки (7 дней, лениво при чтении/создании), удаление.
- `server/src/storage/custom-domain-table.ts` — DDL `site_domains`; вызывается из `storage/pg.ts`.
- `server/src/routes/custom-domains.ts` — add/list/check/canonical/remove; audit-события
  `hosting.domain.*`.
- `GET /api/projects/:id/hosting` возвращает `domains` и DNS-инструкции; `DELETE` сайта
  каскадно удаляет custom domains; transfer проекта переносит владельца доменов.
- Тарифный лимит: `Старт` — 0, `Плюс`/`Премиум` — 1 группа (apex + `www`) на сайт.

**Граница этапа:** `verified` означает только подтверждённое владение. После успешной проверки
TXT + трафика + CAA домен переходит в `configuring` — это состояние уже можно отдавать в
`/api/tls-ask` для первого выпуска. `issuing_certificate`/`active` и Caddy-маршрут — этап 2,
который уже выкачен; реальный сертификат не выпускается только потому, что нет DNS/домена и
feature flag выключен.

### Инварианты

1. Каждый домен должен быть подтверждён до выпуска сертификата.
2. Нельзя выпускать сертификат по произвольному Host.
3. Нельзя использовать Host из запроса как путь к файлам.
4. Caddy не проксирует custom domain в панель/API; отдаётся только статика.
5. Нельзя отдавать чужой сайт по неизвестному Host — только 404.
6. Один hostname принадлежит только одному сайту.
7. Публикация нового релиза не должна менять DNS и не должна ломать домен.
8. Падение одной ноды не должно ломать TLS и выдачу сайта.
9. Ошибка Caddy reload не должна оставлять сервер без рабочего конфига.
10. Секреты и приватные ключи не попадают в UI, логи и git.

## 5. Архитектура

```text
Клиент
  │  A @ → NLB, CNAME www → custom.nestdev.ru
  ▼
NLB 178.236.27.102  (TCP 80/443, без TLS termination)
  │
  ├── Caddy node-1 ──┐
  └── Caddy node-2 ──┤   общий caddy-data (сертификаты)
                     │
                     ├── /srv/sites/<slug>/current (Gluster)
                     │
                     └── /api/tls-ask → PostgreSQL site_domains
```

### Почему не MWS CDN на каждый домен сразу

- базовая квота CDN — 25 ресурсов;
- создание ресурса занимает около 10–15 минут;
- на ресурс действует один активный LE-сертификат;
- для apex обычно нужен CNAME/ALIAS, а не A;
- self-serve подключение становится медленным и упирается в квоту.

Поэтому база — NLB + Caddy. CDN — отдельная premium-опция с честными ограничениями.

### Caddy

- Генерируются точные site-блоки на каждый подтверждённый hostname.
- Root — только `<slug>` из базы, никогда `{host}`.
- Для каждого домена `tls { on_demand }`, глобальный `ask` — `/api/tls-ask`.
- `caddy-data` переносится на общий Gluster-том.
- Общий сгенерированный файл конфига лежит вне `SITES_DIR`; Caddy читает его read-only.
- На каждой ноде таймер сравнивает hash, делает `caddy validate`, затем `caddy reload`.
- Caddy обновляется до исправленной версии **2.11.8+**, пинится по digest.
- Текущий Caddy 2.8 не использовать для новой схемы.

Ссылки для проверки:
- [Caddy on-demand TLS](https://caddyserver.com/docs/automatic-https#on-demand-tls)
- [Caddy cluster/storage](https://caddyserver.com/docs/automatic-https#storage)
- [Caddy advisory GHSA-r766-rf9f-588h](https://github.com/caddyserver/caddy/security/advisories/GHSA-r766-rf9f-588h)

## 6. DNS и подтверждение владения

### Записи

Для `example.ru`:

| Тип | Имя | Значение | Назначение |
|---|---|---|---|
| TXT | `_nestdev-verify` | `nestdev-verify=<token>` | подтверждение apex |
| TXT | `_nestdev-verify.www` | `nestdev-verify=<token>` | подтверждение www |
| A | `@` | `178.236.27.102` | apex-трафик |
| CNAME | `www` | `custom.nestdev.ru.` | www-трафик |

Для поддомена `shop.example.ru` TXT размещается в
`_nestdev-verify.shop.example.ru`, трафик — CNAME на `custom.nestdev.ru`.

Если пользователь вводит `www.example.ru`, нормализуем до пары `example.ru` + `www.example.ru`.
Каждое имя проверяется отдельной TXT-записью. Нельзя подтверждать `www` только по apex: `www`
может быть делегирован другому DNS-провайдеру, и тогда контроль над apex не означает контроль
над `www`. Токен может быть одинаковым для пары, но проверка идёт по конкретному hostname.

### Проверка

- TXT ищется через несколько публичных резолверов, с повторами.
- Трафик проверяется отдельно: A содержит IP NLB или CNAME ведёт на наш target.
- CAA проверяется до выпуска сертификата.
- Не делать HTTP-запрос на произвольный пользовательский URL: только TLS-проба на NLB IP с SNI.
- Ошибки DNS не считать окончательными сразу: показывать «проверим ещё», но не спамить запросами.
- Для неподтверждённых заявок — истечение (например, 7 дней), чтобы не занимать домены.

### Статусы

```text
pending_dns → verified → configuring → issuing_certificate → active
                                                   ↘ error
```

`certificate_status` хранится отдельно: `none | issuing | active | error`.

`verified` в этой схеме — владение (TXT), `configuring` — все DNS-проверки пройдены и можно
выпускать сертификат. Это разделение обязательно: если `tls-ask` разрешит только `active`,
первый сертификат никогда не выпустится.

## 7. Данные и API

### Таблица `site_domains`

```text
id
group_id         → одна заявка apex + www
site_id          → sites(id) on delete cascade
user_id
hostname         → punycode, unique
display_hostname
kind             → apex | www | subdomain
status
verification_token
verification_host
verified_at
last_checked_at
last_error
certificate_status
certificate_error
is_canonical
expires_at       → только для неподтверждённой заявки
created_at
updated_at
```

Дополнительно:

- `UNIQUE(hostname)`;
- `UNIQUE(site_id) WHERE is_canonical`;
- индексы по `site_id`, `group_id`, `status`;
- перенос владельца при transfer проекта;
- очистка при удалении сайта (каскад в той же транзакции);
- поддержка JSON-хранилища для локальной разработки.
- `expires_at`: 7 дней; просроченная неподтверждённая группа освобождает hostname. Отдельного
  фонового таймера на этапе 1 нет — очистка ленивая, при чтении/создании.

### API

- `GET /api/projects/:id/hosting` — добавить `domains` и DNS-инструкции;
- `POST /api/projects/:id/hosting/domains`;
- `POST /api/projects/:id/hosting/domains/:domainId/check`;
- `PATCH /api/projects/:id/hosting/domains/:domainId` — canonical;
- `DELETE /api/projects/:id/hosting/domains/:domainId`;
- `GET /api/tls-ask?domain=...` — расширить для custom domains;
- admin suspend/remove для abuse.

Фактические ошибки этапа 1: `CUSTOM_DOMAINS_DISABLED`, `DOMAIN_INVALID`, `DOMAIN_TAKEN`,
`DOMAIN_LIMIT`, `DOMAIN_PLAN_REQUIRED`, `DOMAIN_NOT_FOUND`, `DOMAIN_NOT_READY` (зарезервирована
для этапа 2). DNS-причины проверки возвращаются в `checks` и `lastError`, а не отдельными
кодами `DNS_NOT_READY`/`CERTIFICATE_FAILED`.

## 8. Интерфейс

Визуально — продолжение существующей карточки «Хостинг», без нового дизайн-языка.
Использовать существующие `panel`, `hosting-*`, `primary-button`, `ghost-button`, `hosting-badge`.

### 8.1. Вход в сценарий

После карточки адреса сайта — блок «Свой домен».

Для «Старта»:

```text
┌ Свой домен ─────────────────────────────┐
│ 🔒 Доступно на «Плюсе» и «Премиуме»      │
│ Подключите свой домен к опубликованному  │
│ сайту.                                  │
│ [ Перейти на «Плюс» ]                    │
└─────────────────────────────────────────┘
```

Для «Плюса»/«Премиума», домен ещё не добавлен:

```text
┌ Свой домен ─────────────────── Плюс ────┐
│ Домен, который уже принадлежит вам       │
│ [ example.ru                         ]   │
│ [ Подключить домен ]                     │
│ Подключим также www.example.ru.           │
│ DNS и HTTPS настроим по шагам.            │
└─────────────────────────────────────────┘
```

Правила ввода:

- принимаем `example.ru`, `www.example.ru`, `shop.example.ru`;
- `www` автоматически превращается в пару apex + www;
- показываем punycode, если ввели кириллицу;
- не даём вводить URL, порт, путь, IP, `*.example.ru`, `localhost`, наши домены;
- если домен уже занят — нейтральная ошибка без раскрытия чужого аккаунта.

### 8.2. Мастер из трёх шагов

После нажатия «Подключить домен» на месте пустого блока появляется мастер. Он не модальный:
инструкции можно спокойно копировать, закрыть панель и вернуться.

```text
Подключение example.ru                    Шаг 1 из 3
● Подтверждение   ○ Трафик   ○ HTTPS

1. Подтвердите, что домен ваш
Добавьте TXT-записи в DNS. Это не меняет
работу сайта и не трогает почту.

TXT  _nestdev-verify.example.ru
     nestdev-verify=AbC123...                [Копировать]
TXT  _nestdev-verify.www.example.ru
     nestdev-verify=AbC123...                [Копировать]

[ Я добавил — проверить ]
Проверяем автоматически. Обычно 5–15 минут.
```

Важное предупреждение:

> Не удаляйте существующие MX, SPF, DKIM и другие записи. Добавьте только запись выше.

Если пользователь подключает только `www`, в шаге 1 показывается только TXT для `www`.
Если только apex — только TXT для apex. Для пары — две строки, чтобы не было ложного
подтверждения чужого делегированного поддомена.

После подтверждения:

```text
Шаг 2 из 3. Направьте домен на нас

A      @    → 178.236.27.102
CNAME  www  → custom.nestdev.ru.

[ Я переключил — проверить ]

Если домен уже работает на другом хостинге,
доступ может прерваться на время обновления DNS.
Сначала можно подтвердить владение, не меняя трафик.
```

После проверки трафика:

```text
Шаг 3 из 3. Включаем HTTPS
Выпускаем сертификат для example.ru и www.example.ru.
Обычно это занимает меньше двух минут.
[проверяем TLS и редиректы]
```

Успех:

```text
✓ example.ru работает
  HTTPS включён, www перенаправляется на основной адрес.

Основной адрес:
(•) example.ru      ( ) www.example.ru

[ Открыть сайт ]  [ Скопировать ]  [ Отключить ]
```

### 8.3. Ошибки

Показывать причину и одно действие, а не сырой ответ DNS/Caddy:

- TXT не найден → «DNS ещё обновляется. Проверьте запись и попробуйте снова».
- Трафик не к нам → показать нужную A/CNAME-запись.
- CAA запрещает LE → предложить `0 issue "letsencrypt.org"`.
- Домен занят → «Этот домен уже подключён. Если это ваш домен, напишите в поддержку».
- Сертификат не выпустился → «Проверьте CAA и DNS; повторим позже», с кнопкой повтора.
- Сайт не опубликован → «Домен подтверждён. Опубликуйте сайт, чтобы включить его».

### 8.4. SEO в интерфейсе

В активном состоянии явно показать:

- какой адрес основной;
- что второй отдаёт **301**;
- что HTTP перенаправляется на HTTPS;
- что неизвестные файлы дают 404, а не index.html.

Не добавлять HSTS по умолчанию: для доменов, которые клиент может захотеть перенести, это опаснее,
чем польза. Решение по HSTS — отдельно, после пилота.

### 8.5. CDN для «Премиума»

В карточке домена, только для «Премиума»:

```text
CDN                              Премиум
Ускорить сайт в регионах.
Основной адрес станет www.example.ru,
example.ru будет перенаправлять на него.
[ Включить CDN ]
```

До реализации этапа 5 кнопка не показывается или disabled с пояснением «скоро». Нельзя обещать
CDN раньше, чем он реально работает.

### 8.6. Мобильная версия

- Поле и кнопка — на всю ширину.
- DNS-записи — вертикальные карточки с кнопкой копирования.
- Не делать горизонтальный скролл для таблицы.
- Статус и следующий шаг всегда видны без раскрытия технических деталей.

## 9. SEO и корректность отдачи

Обязательная матрица для каждого активного домена:

| Проверка | Ожидание |
|---|---|
| `http://apex` | 301 на `https://canonical` |
| `http://www` | 301 на `https://canonical` |
| `https://non-canonical` | 301 на `https://canonical`, путь и query сохраняются |
| `https://canonical` | 200 |
| отсутствующий файл с расширением | 404, не index.html |
| путь без расширения | SPA-fallback, если так устроен сайт |
| `/assets/*` с хешем | долгий immutable-кеш |
| HTML | `no-cache`, как у обычного сайта |
| HTTP-метод POST на статику | 405/404, без записи |
| Host вне списка | 404, без панели и чужих сайтов |
| IDN | punycode в TLS/DNS, Unicode в интерфейсе |
| редирект | без цепочек и циклов; минимум один хоп |

Дополнительно:

- Не добавлять платформенный `<link rel="canonical">` в чужой HTML.
- `robots.txt` и `sitemap.xml` остаются файлами клиента.
- Не включать directory listing.
- Не отдавать `.git`, `.env`, скрытые файлы и symlink за пределы релиза.
- Проверять, что CDN не кеширует HTML надолго.

## 10. CDN для «Премиума» — отдельный production-этап

### Ограничения, которые нельзя скрывать

- MWS CDN: базовая квота 25 ресурсов, создание около 10–15 минут.
- На ресурс — один активный LE-сертификат.
- Пользовательские DNS-имена в CDN — CNAME; apex не подходит без ALIAS.
- Сертификат для CDN требует DNS-01 и делегирования `_acme-challenge`.

### Схема

- CDN только для «Премиума» и только по желанию.
- Основной адрес — `www.example.ru`; `example.ru` — A на NLB и 301 на www.
- `www` — CNAME на CDN-ресурс.
- Сертификат `www` — через MWS Certificate Manager с DNS-01.
- Origin — NLB `178.236.27.102`, Host/SNI — `www.example.ru`.
- После публикации — purge путей релиза.
- При исчерпании квоты — очередь/ожидание, без тихого переключения на другой домен.
- Если клиент не может использовать CNAME на `www` или требует apex canonical — CDN не включаем,
  объясняем ограничение. Не ломаем SEO и не делаем фиктивный CDN.

### UI CDN

- до включения: объяснить, что canonical станет `www`, apex будет 301;
- после включения: показать статус `Настраиваем CDN`, `Активен`, `Ошибка`;
- отдельно показать, что DNS нужно поменять на CNAME CDN;
- при отключении — вернуть DNS на NLB и canonical; не удалять сайт.

## 11. Безопасность и abuse

- TXT-токен 128 бит, уникальный; не считать его секретом, но не логировать лишний раз.
- TXT проверяется для каждого hostname отдельно; apex не подтверждает `www`.
- Уникальность hostname в БД, а не только в UI.
- Проверка public suffix, запрет IP, localhost, `.local`, наших доменов.
- Нормализация и punycode; защита от homograph-ошибок в UI.
- Не делать open proxy: Caddy отдаёт только файлы конкретного релиза.
- Не разрешать wildcard custom domains в первой версии.
- Rate limit на add/check; cooldown после ошибок TLS.
- Админский suspend домена; audit `hosting.domain.*`.
- Мониторинг фишинга и жалоб; возможность быстро снять домен.
- Проверка, что `custom.nestdev.ru` не пересекается с `*.host`.
- Проверка, что Caddy не принимает Host с `..`, `/`, `\` и портом.
- Приватные ключи CDN/CM не попадают в клиентский UI и логи.

## 12. HA и эксплуатация

- `caddy-data` на общем Gluster; проверить запись, права, lock, восстановление.
- Одинаковый сгенерированный конфиг на обеих нодах.
- Таймер reload на каждой ноде; hash, `validate`, затем `reload`.
- NLB health check — TCP 80/443; проверить, что Caddy down действительно убирает target.
- При падении node-1 домен и TLS должны работать на node-2.
- После возврата node-2 конфиг и сертификаты подхватываются без ручных действий.
- При недоступном Gluster Caddy не должен молча отдавать чужие/старые файлы.
- Бэкап `caddy-data` не обязателен, но полезен, чтобы не перевыпускать все сертификаты.
- Логи Caddy и API не должны содержать приватные ключи.

## 13. Этапы реализации

### Этап 0. Проверки до кода

- [x] DNS-проверка: `nestdev.ru` и `host.nestdev.ru` возвращают `178.236.27.102`.
- [ ] Подтвердить через MWS API, что IP статический и привязан к NLB. Попытки
  `/nlb/v1/loadBalancers`, `/nlb/v1/projects/project-pimashin2015/loadBalancers` и
  `/vpc/v1/loadBalancers` вернули 404 — точный путь API не найден. Документация говорит, что IP
  статический, но это не живая проверка.
- [x] Подтвердить TCP 80/443 и отсутствие TLS termination на NLB: снаружи открыты оба порта,
  `http://nestdev.ru` отвечает 308, `https://nestdev.ru` — 200 с сертификатом Caddy.
- [x] Проверить `custom.nestdev.ru` в DNS: 14.11.2026 запись `A custom → 178.236.27.102`
  (TTL 3600) подтверждена через авторитативные `ns1/ns2.reg.ru` и публичные резолверы.
  `custom.nestdev.ru.nestdev.ru` больше не существует. Это target для клиентских CNAME/apex,
  а не отдельный сайт.
- [x] Обновить Caddy до 2.11.8+ и запинить digest в рабочем дереве:
  `caddy:2.11.8-alpine@sha256:f6228111e5fafa1a5238258d0858e103f10599b8d1659a146e7726681a002bb9`.
  Выкачено 13.11.2026: живой `src-caddy-1` работает на 2.11.8.
- [x] Проверить `caddy validate` с импортом пустого custom-файла: на `node-1` во временном
  контейнере Caddy 2.11.8 — `Valid configuration`. Боевой конфиг не менялся.
- [x] Проверить общий `caddy-data` на `node-1`: миграция выполнена, старые сертификаты
  читаются, HTTPS работает. [ ] Повторить lock/запись на паре нод с включённой `node-2`.
- [ ] Проверить выпуск тестового сертификата Caddy в staging CA через NLB: нет `custom.nestdev.ru`.
- [x] Включить node-2 для HA-теста (по просьбе пользователя 14.11.2026): MWS `power=ON`,
  `node-1` остаётся primary (`pg_is_in_recovery()=f`), `node-2` поднялась standby (`t`),
  API на обеих нодах — `200`, Gluster `data`/`sandboxes`/`sites` — по два online-brick'а.
  Это ещё не production switchover: primary по-прежнему на `node-1`.

**Итог:** этап 0 **частично проверен**. SSH восстановлен, Caddy 2.11.8 принимает generated-конфиг
с пустым custom-файлом. Остаются NLB API/статичность IP, DNS target `custom.nestdev.ru`, живой
общий `caddy-data`, staging-сертификат и HA на двух нодах. Эти пункты нельзя считать проверенными.

### Этап 1. Данные и верификация

- [x] DDL `site_domains` в PostgreSQL (вызывается из `storage/pg.ts`) и JSON-хранилище.
  **Применено к живой БД 13.11.2026:** таблица `public.webnestdev_site_domains`, столбцы,
  check-ограничения и уникальные индексы проверены через `psql`.
- [x] Нормализация hostname, punycode, PSL, запреты; тесты IDN/URL/IP/wildcard/платформенных имён.
- [x] TXT-токен (192 бита), создание/истечение заявки (7 дней, ленивая очистка).
- [x] DNS-проверки TXT, A, CNAME, CAA с injectable resolver; TXT для apex и `www` отдельно.
- [x] API add/list/check/remove/canonical + `domains` в `GET /hosting`.
- [x] Лимит тарифа 0/1/1, аудит, transfer владельца, cascade delete при удалении сайта.
- [x] Тесты на невалидные имена, IDN, захват/дубль домена, лимит, feature flag, cascade и
  одновременное создание (JSON). PostgreSQL-гонка закрыта транзакцией и `FOR UPDATE`, но на
  живой БД не проверялась.
- [ ] Проверить транзакцию создания и transfer на живых данных с реальным доменом; DDL и
  индексы уже проверены. Это остаётся ограничением этапа.

**Итог:** DDL этапа 1 применён к живой PostgreSQL, API и тесты готовы, feature flag выключен.
Создание/проверку домена нельзя проверить без DNS: `verify` требует TXT; чужой/занятый
hostname отклоняется уникальным ограничением.

### Этап 2. Caddy, TLS, HA

- [x] Генератор точных site-блоков без host-derived root: `hosting/caddy-config.ts`,
  `hosting/caddy-routes.ts`; root строится только из проверенного slug.
- [x] Общий файл конфига и атомарная запись: `hosting/caddy-config-writer.ts`,
  `CUSTOM_DOMAINS_CADDY_DIR`; Caddy читает `/etc/caddy/custom` read-only.
- [x] Таймер reload с validate и откатом: `deploy/ha/caddy-reload.sh`,
  `webnestdev-caddy-reload.{service,timer}`, установщик. На `node-1` active/enabled; автоматический
  reload после изменения `custom-domains.caddy` проверен, `caddy validate` проходит.
- [x] Общий `caddy-data`: compose-монтирование `CADDY_DATA_HOST_DIR`, однократная миграция
  старого `src_caddy-data` в `vm-deploy.sh`. На `node-1` сертификаты перенесены, HTTPS работает;
  Gluster-блокировка на паре нод и HA не проверены.
- [x] Расширение `/api/tls-ask` с кешем и cooldown: положительный TTL 15 с, отрицательный 5 с,
  инвалидация при смене домена; повтор TLS-активации — не чаще раза в 60 с.
- [x] Выпуск сертификата, TLS-проба через NLB IP и SNI: `hosting/domain-tls.ts`,
  `hosting/domain-activation.ts`. Проверка `nestdev.ru` через NLB — `TLSv1.3`, ok. Custom-домен
  ещё не выпускался: нет DNS target.
- [x] Канонический 301 и HTTP→HTTPS: Caddy 2.11.8 validate показывает automatic HTTP→HTTPS;
  generated alias-блоки отдают `redir ... permanent` (unit-тесты). Живой домен не проверен.
- [x] Suspend/unpublish удаляет маршрут: refresh после изменения сайта и периодический проход;
  тест `caddy-refresh.test.ts` проверяет исчезновение блока после `unpublishSite`.
- [ ] Тесты конфига и HA: конфиг/активация/cache — 42 точечных теста, 0 fail; HA и Caddy reload
  на паре нод не проверены без `node-2`.

**Готово, когда:** сертификат выпускается на обеих нодах/в общем storage; падение node-1 не
ломает домен; ошибка reload не ломает рабочий конфиг. **Сейчас инфраструктура node-1
выкачена и проверена, `node-2` включена, но end-to-end-критерий не выполнен:** нет тестового
клиентского домена; HA и общий Gluster-lock ещё не проверены на паре нод.

Файлы этапа 2: `server/src/hosting/caddy-config.ts`, `caddy-routes.ts`,
`caddy-config-writer.ts`, `caddy-refresh.ts`, `domain-tls.ts`, `domain-activation.ts`,
`tls-ask-cache.ts`; `deploy/Caddyfile`; `deploy/ha/caddy-reload.sh` и units;
`docker-compose.yml`; `deploy/scripts/vm-deploy.sh`.

**Проверки 13.11.2026:**

- `node --import tsx --test` по caddy/refresh/activation/cache/domain/routes — 42 теста, 0 fail.
- Полный `npm test` сервера — 1828 тестов, 0 fail, 10 skip (Chromium в среде недоступен).
- `npx tsc -p server/tsconfig.json --noEmit` — 0 ошибок.
- `npx tsc -b --noEmit` — 0 ошибок.
- generated Caddyfile, фактический `deploy/Caddyfile` с пустым custom-файлом и он же с
  сгенерированными блоками проверены `caddy:2.11.8-alpine`: `Valid configuration`,
  automatic HTTP→HTTPS включён.
- `docker compose config --quiet` для нового `docker-compose.yml` — ok (на временной копии,
  без изменения production).
- `probeCustomDomainTls("nestdev.ru")` через NLB IP: `ok:true`, `TLSv1.3`.
- `caddy:2.11.8-alpine` digest: `sha256:f6228111e5fafa1a5238258d0858e103f10599b8d1659a146e7726681a002bb9`.

**Выкатка 13.11.2026 (выполнена на `node-1`):**

- Первая попытка (`ecbc9d6`) упала на старте API: `tldts` установился в `server/node_modules`, а
  production-образ копировал только корневой `node_modules`. Deploy автоматически вернул
  предыдущий образ, прод не остался на сломанной сборке.
- Исправление `5551969` добавило вложенные зависимости в Dockerfile; затем доставка
  reload-таймера в image-режиме и два исправления вызовов `docker compose` — `64b00c0`,
  `04ef8cc`, `da66041`.
- Текущая сборка — `9a6cba0` (run `43634687022`); `/api/health` сообщает её SHA на обеих нодах.
- Caddy 2.11.8 работает; общий `caddy-data` содержит перенесённые сертификаты; публичный
  `https://nestdev.ru` и `/api/ready` — `200`.
- `webnestdev-caddy-reload.timer` active/enabled; после добавления комментария в общий
  `custom-domains.caddy` сервис сам сделал `validate` и `reload`, затем файл возвращён.
- На живой БД создана `public.webnestdev_site_domains`; строк `0`, feature flag выключен.
- `node-2` включена 14.11.2026 и работает standby; выкатка `43634687022` обновила её до
  `9a6cba0`, пересоздала Caddy 2.11.8 и установила active reload-таймер. HA/lock ещё не проверены.
- `custom.nestdev.ru` резолвится в `178.236.27.102`; реальный клиентский домен и TLS для него
  ещё не выпускались — для приёмки нужен тестовый домен пользователя.

**Порядок выкатки этапа 2 (частично выполнен):**

1. [x] Backup старого `src_caddy-data` и проверка, что `node-1` — primary. Backup PostgreSQL
   остаётся штатным расписанием; DDL не разрушающий.
2. [x] Выкатить образ/сервис на `node-1`; `vm-deploy.sh` перенёс `caddy-data` в
   `/var/lib/webnestdev/data/caddy-data`, создал `caddy-custom` и проверил Caddyfile.
3. [x] Установить и включить таймер на `node-1`; timer active, автоматический reload проверен.
   `node2-sync.sh` установил и включил `webnestdev-caddy-reload.timer` на `node-2`; timer active.
4. [x] Создать `custom.nestdev.ru` в DNS (по просьбе пользователя 14.11.2026) и проверить target.
5. [ ] Включить `CUSTOM_DOMAINS_ENABLED=1`; подключить тестовый домен, проверить
   `https://<домен>` / `https://www.<домен>`, 301, 404, `caddy-data` на обеих нодах и падение
   `node-1`. Без тестового домена end-to-end custom domain не считается проверенным.

### Этап 3. UI

- [x] Карточка «Свой домен» с тарифным gate: `src/features/hosting/CustomDomainCard.tsx`.
- [x] Мастер из трёх шагов «Домен → DNS → HTTPS».
- [x] Копирование TXT/A/CNAME и показ target/IP.
- [x] Автопроверка раз в 8 секунд и ручная кнопка «Проверить DNS».
- [x] Статусы `pending_dns/verified/configuring/issuing_certificate/active/error`, ошибки и
  подсказки по DNS; отдельной ссылки в поддержку пока нет.
- [x] Выбор canonical внутри apex/www и предупреждение о 301.
- [x] Мобильная раскладка добавлена в `src/styles.css`.
- [ ] Admin suspend UI: API уже есть (`/api/admin/hosting/...`), отдельный экран не делался.

**Готово, когда:** пользователь без терминала и без чтения документации проходит подключение;
все состояния понятны; ошибки не раскрывают чужие аккаунты. **Код и сборка готовы, но живой
проход blocked:** feature flag выключен, target `custom.nestdev.ru` готов, а тестовый домен
пользователя ещё не подключён.

### Этап 4. SEO и приёмка

- [ ] Матрица редиректов и 404 из раздела 9.
- [ ] Проверка apex+www и только www.
- [ ] Проверка IDN.
- [ ] Проверка кеша HTML/ассетов.
- [ ] Проверка отсутствия directory listing и утечек.
- [ ] Проверка, что canonical не дублируется.
- [ ] Проверка, что Caddy не отдаёт чужой сайт по Host.

### Этап 5. CDN для «Премиума»

- [ ] Проверить квоты MWS CDN и Certificate Manager в аккаунте.
- [ ] Проверить CNAME custom domain и DNS-01 delegation.
- [ ] Создание ресурса, ожидание `Active`.
- [ ] Origin через NLB с Host/SNI.
- [ ] Выпуск и установка сертификата.
- [ ] Purge после публикации.
- [ ] Canonical `www`, apex 301.
- [ ] Лимиты, очередь, отключение.
- [ ] UI CDN.
- [ ] Тесты кеша и SEO.

### Этап 6. Пилот и выкатка

- [ ] Feature flag по умолчанию выключен.
- [ ] 3–5 реальных доменов, включая apex+www и IDN.
- [ ] HA-тест с включённой node-2.
- [ ] Runbook для поддержки.
- [ ] Мониторинг ошибок TLS/DNS.
- [ ] Включение для «Плюса»/«Премиума».
- [ ] Отдельный коммит/выкатка; не смешивать с preview-правками.

## 14. Критерии production-готовности

- [ ] «Плюс» и «Премиум» могут подключить один домен; «Старт» — нет.
- [ ] Домен активируется только после TXT и трафика.
- [ ] HTTPS-сертификат валиден для apex и www.
- [ ] Один canonical, второй адрес — 301.
- [ ] HTTP → HTTPS, неизвестный путь → 404, SPA работает корректно.
- [ ] Падение node-1 не ломает домен.
- [ ] Caddy reload при ошибке не ломает текущий конфиг.
- [ ] Нет open proxy и отдачи чужого сайта.
- [ ] Есть admin suspend и audit.
- [ ] Есть тесты, tsc, staging-проверка и пилот.
- [ ] CDN «Премиума» либо работает, либо явно скрыт; нет фиктивной кнопки.

## 15. Риски

| Риск | Что делаем |
|---|---|
| NLB IP не статический | Остановиться; использовать статический IP/ALIAS, не обещать apex. |
| Gluster-локи Caddy не работают | Не игнорировать; альтернативный storage или CM, с тестом. |
| Caddy 2.8/уязвимости | Обновить до 2.11.8+, pin digest, никакого host-derived root. |
| HTTP-01 за NLB | Общий storage + тест; иначе не выпускать в production. |
| CAA/Cloudflare proxy | Понятная ошибка; DNS-only на подключении. |
| Phishing на custom domain | Платный тариф, audit, admin suspend, ручной разбор жалоб. |
| Квота CDN 25 | Premium opt-in, очередь, запрос увеличения; не тихий обход. |
| Apex CNAME | A на NLB; ALIAS/ANAME — если поддерживает DNS клиента. |
| node-2 включена, но HA не проверена | Не считать отказоустойчивость проверенной до падения node-1 и возврата standby. |
| Смешивание с preview-правками | Отдельные файлы/коммит; не коммитить чужие изменения. |

## 16. Журнал изменений

| Дата | Что изменилось | Проверка |
|---|---|---|
| 13.11.2026 | Создан план; зафиксированы UI, архитектура, SEO, CDN-ограничения. | Документ создан, реализация не начата. |
| 13.11.2026 | Реализован этап 1: типы, нормализация, JSON/PG store, DDL, DNS, service, routes, лимит тарифа, аудит, transfer, cascade. | `node --import tsx --test` по domain/config/name/dns/store/custom-domains: 28 тестов, 0 fail. |
| 13.11.2026 | Проверен tsc сервера. | `npx tsc -p server/tsconfig.json --noEmit` — 0 ошибок. |
| 13.11.2026 | Проверены DNS и доступ к MWS. | `nestdev.ru` и `host.nestdev.ru` → `178.236.27.102`; `custom.nestdev.ru` → `ENOTFOUND`; MWS-ключ работает (`MWS-ACCESS=ok`), но NLB API по трём известным путям даёт 404. |
| 13.11.2026 | Проверен доступ к ВМ для этапа 0. | `/tmp/nestdev-agent` отсутствует, SSH к `node-1` — `Permission denied (publickey)`. Caddy/Gluster/staging не проверены; обход не создавался. |
| 13.11.2026 | Реализован этап 2: генератор точных Caddy-блоков, общий файл с атомарной записью, reload-таймер, TLS-проба/активация, cache ask, общий `caddy-data` и миграция. | 42 точечных теста, 0 fail; `tsc` server/frontend — 0; Caddy 2.11.8 `Valid configuration`; TLS-проба `nestdev.ru` через NLB — `TLSv1.3`. На тот момент живой custom-домен, Gluster lock и HA ещё не были проверены: `custom.nestdev.ru` отсутствует, `node-2` выключена, выкатки не было; инфраструктура выкачена позже в тот же день. |
| 13.11.2026 | Обновлён живой статус после этапа 1. | Код готов; PostgreSQL-ветка и этап 2 остаются непроверенными/заблокированными. |
| 13.11.2026 | Этап 2 выкачен на `node-1`: Caddy 2.11.8, общий `caddy-data`, `custom-domains.caddy`, reload-таймер. | Deploy run 43501085787 сначала упал на `tldts` и откатился; после Dockerfile-fix 43502136872 и run 43506233483 — success. Публичный `/api/ready` и `/` — 200; timer active; автоматический reload проверен. |
| 13.11.2026 | Этап 3: мастер домена в панели хостинга и API-лимит тарифа. | `tsc -b --noEmit` — 0; `npm run build` — ok; deploy 43507645305 — success, build `9d038bb`. Feature flag оставлен выключенным; реальный домен не подключался. |
| 14.11.2026 | DNS target исправлен, включена `node-2`; обновление выкачено через Actions. | `custom.nestdev.ru` → `178.236.27.102` (A, TTL 3600); MWS `power=ON`; `node-1` primary (`f`), `node-2` standby (`t`), API `200` на обеих, Gluster — по два online-brick'а. Deploy run `43634687022` — success, build `9a6cba0` на обеих, Caddy 2.11.8 и reload-таймер active. Feature flag всё ещё `0`; тестовый домен не подключён. |
