# SEO платформы: план реализации

Дата создания: **15.11.2026**

Статус: **этапы 1–3 реализованы полностью; SEO-шаблоны агента, Search Console HTML-подтверждение и CDN-статус добавлены; SSR не реализован** (19.11.2026, 21:35 UTC)

Связанные документы: [`CUSTOM_DOMAINS_PLAN.md`](CUSTOM_DOMAINS_PLAN.md),
[`STATIC_HOSTING_PLAN.md`](STATIC_HOSTING_PLAN.md),
[`PRODUCTION_STATE.md`](PRODUCTION_STATE.md),
[`AI_AGENT_CAPABILITY_PLAN.md`](AI_AGENT_CAPABILITY_PLAN.md).

Этот документ — не рекламное описание «SEO-функции», а **план реализации технического SEO
для сайтов, которые пользователи публикуют на платформе**. Он отвечает на три вопроса:

1. Что гарантирует платформа, а что делает пользователь.
2. Как должны работать кастомный домен и платформенный адрес.
3. В каком порядке это внедрять, чтобы не сломать SPA и не сделать SEO хуже.

**Коротко:** платформа отвечает за HTTP-слой, canonical-хост, 404, sitemap/robots и
`noindex` технических адресов. Пользователь отвечает за контент и метаданные. Контентные
сайты по умолчанию должны быть static/SSG, SPA — только для приложений; SSR — отдельный
поздний этап. Custom domain и platform host работают по одним правилам, меняется только
primary domain и 301.

---

## 0. Если ты вернулся к задаче

1. Прочитай таблицу «Живой статус» ниже.
2. Проверь, какой этап последний завершён.
3. Не начинай с SSR и CDN: сначала этап 1 и 2.
4. Не включай глобальный `404` вместо SPA-fallback: это сломает React-приложения.
5. После каждого этапа обнови статус, журнал и тесты.
6. Не коммить и не выкатывать без явной просьбы пользователя.

---

## 1. Живой статус

| Этап | Статус | Обновлено | Следующий шаг |
|---|---|---|---|
| 0. Решения и baseline | решения приняты и реализованы в коде | 19.11.2026, 10:38 UTC | — |
| 1. Static/404/noindex | реализовано | 19.11.2026, 10:38 UTC | Live-проверка Caddy на стенде |
| 2. Route manifest и режимы | реализовано, включая sitemap index >50k | 19.11.2026, 21:35 UTC | — |
| 3. SEO-аудит и редиректы | реализовано: аудит, API/UI, `_redirects`, trailing slash | 19.11.2026, 21:35 UTC | Live-проверка Caddy на стенде |
| 4. AI-шаблоны и SSG | частично: `seo.templates`, SEO-правила агента; готового Astro-скаффолда нет | 19.11.2026, 21:35 UTC | Astro/SSG-скаффолд отдельным этапом |
| 5. SSR/CDN/Search Console | CDN purge и Search Console HTML есть; SSR-рантайма нет | 19.11.2026, 21:35 UTC | SSR-рантайм отдельным этапом |

---

## 2. Что уже есть на 19.11.2026

### Работает

- Статический хостинг: сборка проекта, релизы, Caddy, HTTPS.
- Custom domain: apex + `www`, TXT-подтверждение, A/CNAME, Let’s Encrypt.
- 301 между `www` и apex.
- HTTP → HTTPS (308).
- SPA-fallback для путей без расширения.
- Отсутствующие ассеты с расширением дают 404.
- Кэширование хешированных ассетов.
- Preview-домены и отдельный TLS-ask.

### Чего не было на 15.11.2026 (baseline)

- Режима сайта `static | spa | hybrid | ssr`.
- Настоящего 404 для статического сайта с несколькими страницами.
- Кастомной `404.html` с сохранением статуса 404.
- `noindex` для preview и платформенного адреса при активном custom domain.
- Автогенерации `sitemap.xml` и `robots.txt`.
- SEO-аудита в панели.
- Route manifest для релиза.
- Управляемых редиректов и политики trailing slash.
- SSR-рантайма.
- SEO-шаблонов в AI-агенте.

### Реализовано 19.11.2026, 10:38 UTC

- `routing_mode` (`auto | static | spa | hybrid`) и `effective_routing_mode` у сайта;
  `route_manifest_json` и режим у релиза; PostgreSQL-колонки с безопасными default.
- Route manifest из реальных HTML-файлов; `/` и `/about/`; `404.html`; исключение скрытых
  файлов. `auto` для одностарничной сборки сохраняет SPA, для многостраничной — static.
- Caddy: strict 404 для static, SPA-fallback только без расширения, hybrid `/app/*`,
  `404.html` с `noindex`, sitemap/robots из релиза или overlay, `X-Robots-Tag: noindex, nofollow`
  на всём preview и `/robots.txt` с `Disallow: /`.
- Сгенерированный `hosting-modes.map` вместо site-блока на каждый платформенный адрес;
  canonical custom domain даёт 301 с платформенного адреса только после `active`.
- `sitemap.xml`/`robots.txt` overlay в `/srv/sites/<slug>/seo`; пользовательские файлы
  главнее; пересборка при публикации, rollback, смене slug/canonical и активации домена;
  удаление при unpublish/suspend/delete.
- Технический SEO-аудит: title/description/H1/lang/canonical/noindex/OG-база, alt,
  внутренние ссылки, sitemap/robots, 404 живым запросом; critical/warning/info без score.
- API `GET/PATCH /api/projects/:id/hosting/seo`, `POST .../seo/audit`; карточка SEO в панели.

**Добавлено 19.11.2026, 21:35 UTC**

- `_redirects` в корне релиза: строгий парсер (внутренние пути, 301/302, один `*` в конце,
  `:splat`, сохранение query, лимит 100 правил/256 КБ), проверка циклов, дублей и open
  redirect; ошибки не валят публикацию, видны в SEO-панели и аудите. Caddy получает общий
  файл `caddy-custom/hosting-redirects.map`, импортируемый внутрь wildcard-блока; для
  custom domains правила встраиваются в site-блок.
- Политика trailing slash `always | never | ignore` хранится в `seo/settings.json` рядом с
  overlay и переживает публикацию/rollback. Default: `always` для static/hybrid, `ignore`
  для SPA. Второй вариант отвечает 301, query сохраняется через `{?query}`; sitemap
  использует тот же вариант.
- Sitemap index `sitemap-1.xml …` при >50 000 URL; старые куски удаляются, Caddy отдаёт
  `/sitemap-*.xml` из релиза или overlay, аудит не считает index ошибкой отсутствия
  главной и проверяет куски.
- `seo.templates` в AI-агенте: head с title/description/canonical/OG/Twitter, JSON-LD,
  `404.html` и шаблон `_redirects`; правила агента требуют static/SSG для контентных сайтов,
  hybrid для SaaS и запрещают говорить «SEO готово» без аудита.
- Search Console: подтверждение владения HTML-файлом `google<token>.html`; файл пишется в
  overlay без публикации, отдаётся Caddy и удаляется при отключении. OAuth-интеграции с
  Search Console нет.
- CDN: purge уже работает на публикации и rollback (`cdn-purge.ts`); в SEO-панели показан
  реальный статус, а не обещание. Ограничение общего CDN-ресурса остаётся: purge чистит
  пути, а не отдельный hostname.

**Осталось:** полноценный SSR-рантайм (сейчас серверные проекты отклоняются, а не молча
превращаются в SPA), готовый Astro/SSG-скаффолд и OAuth-интеграция Search Console. Живой
`caddy validate` на стенде не запускался: Caddy в workspace нет.

### Живой пример

`nestdevtest.ru` — React SPA:

- `/` → 200;
- `/no-such-page` → 200 (SPA-fallback);
- `/no-such-page.js` → 404;
- `/assets/missing.js` → 404;
- `/missing.png` → 404;
- `www` → 301 на apex;
- HTTP → 308 на HTTPS.

Это нормально для SPA, но **не идеально для SEO**: неизвестный маршрут отдаёт 200, а контент
страниц зависит от JavaScript.

---

## 3. Главный принцип: два слоя SEO

### Слой платформы

Платформа отвечает за то, **как сайт отдаётся**:

- HTTPS и редиректы;
- какой домен главный;
- 301 между адресами;
- 200/301/404;
- `noindex` для технических адресов;
- готовый HTML или SPA-fallback;
- sitemap/robots по умолчанию;
- кэш, сжатие, скорость;
- SEO-аудит и предупреждения.

### Слой пользователя

Пользователь отвечает за **содержимое**:

- title, description, H1;
- canonical;
- sitemap/robots, если хочет переопределить платформенные;
- structured data;
- alt у изображений;
- внутренние ссылки;
- качество и объём контента;
- Search Console / Яндекс.Вебмастер.

### Правило

> Платформа не может сделать SEO за пользователя. Пользователь не может исправить
> HTTP-статусы и дубли доменов через свой HTML.

Если платформа отдаёт 200 вместо 404, пользователь не исправит это мета-тегом. Если
пользователь не заполнил title, платформа не придумает за него содержание.

---

## 4. Режимы сайта

### 4.1. `static`

Подходит: лендинг, блог, визитка, документация, каталог, SSG.

Признаки:

- в сборке есть HTML-страницы;
- есть `index.html` и/или `about/index.html`, `blog/post/index.html`;
- может быть `404.html`.

Поведение:

- существующий путь → 200;
- существующий каталог с `index.html` → 200;
- неизвестный путь → **404**;
- отсутствующий ассет → **404**;
- `404.html` отдаётся с кодом **404**, не 200;
- sitemap можно построить из реальных HTML-файлов.

Это лучший режим для SEO.

### 4.2. `spa`

Подходит: личный кабинет, приложение после логина, инструмент.

Признаки:

- только `index.html` и `/assets/*`;
- маршруты задаёт JavaScript.

Поведение:

- известные/все пути без расширения → `index.html`, 200;
- отсутствующий файл с расширением → 404;
- неизвестный маршрут всё равно 200 — это soft 404;
- публичные страницы нужно пререндерить или смириться с ограничением;
- приватные маршруты — `noindex` и не в sitemap.

Нельзя делать SPA режимом по умолчанию для лендингов и блогов.

### 4.3. `hybrid`

Подходит: SaaS с публичным лендингом, блогом и приложением.

Пример:

- `/`, `/about`, `/blog/*` — статические HTML;
- `/app/*` — SPA-fallback;
- неизвестный публичный путь → 404;
- неизвестный `/app/*` → `index.html`.

Это лучший компромисс для продукта, у которого есть и маркетинг, и приложение.

### 4.4. `ssr`

Подходит: динамические страницы, персонализация, магазин, кабинет с SEO.

Требует:

- Node-процесс или контейнер;
- reverse proxy в Caddy;
- управление ресурсами и сном;
- отдельный тариф/лимиты;
- собственные 200/301/404 от приложения.

**Статус на 19.11.2026:** режим не реализован. `project-mode.ts` явно отклоняет проект с
постоянным сервером (`PROJECT_NOT_STATIC`) и предлагает статику/serverless-функции; молча
превращать SSR в SPA платформа не должна. Это отдельный этап с процессом, лимитами и
соном, а не флаг в map.

### 4.5. Как выбирать режим

Автоматически при публикации:

- есть несколько HTML-файлов или `404.html` → `static`;
- только `index.html` + `/assets/*` → `spa`;
- есть серверный рантайм → сейчас отказ с понятной причиной, SSR-рантайма нет;
- пользователь может переопределить режим в настройках сайта.

Ручной выбор обязателен: автоматика не должна угадывать там, где ошибка ломает сайт.

---

## 5. Политика доменов и canonical

### 5.1. Основной адрес

У сайта должен быть **один primary domain**:

- либо custom domain, выбранный пользователем;
- либо платформенный `<slug>.host.nestdev.ru`, если custom нет.

`www`/apex — это одна группа. Второй адрес получает 301 на основной.

### 5.2. Матрица поведения

| Адрес | Условие | Ответ | Canonical |
|---|---|---|---|
| custom primary | custom active | 200 | этот custom |
| custom `www`/apex non-primary | custom active | 301 на primary | primary |
| platform host | custom active | 301 на custom primary | custom |
| platform host | custom нет/не активен | 200 | platform host |
| preview host | всегда | 200 + `noindex, nofollow` | нет |
| 404 | всегда | 404 + `noindex` | нет |

Важно: **не делать 301 с платформенного адреса на custom, пока custom не активен**. Иначе
сайт уйдёт в неработающий домен. Переключать 301 только после `active` и успешной TLS-пробы.

### 5.3. Custom domain vs платформенный адрес

SEO-правила одинаковые. Разница только в базовом URL:

- custom: canonical, sitemap и внутренние ссылки — на custom;
- platform host: canonical, sitemap — на platform host;
- при подключении custom платформа должна переключить canonical-базу и 301;
- если пользователь уже использовал platform host в canonical/sitemap, предупредить.

### 5.4. Preview

Preview-домены:

- всегда `X-Robots-Tag: noindex, nofollow`;
- отдельный `robots.txt` с `Disallow: /`;
- никогда не canonical;
- не попадают в sitemap.

---

## 6. Caddy: как отдавать сайт

### 6.1. Static

Логика:

1. Проверить реальный файл.
2. Проверить `index.html` в каталоге.
3. Если нет — 404.
4. Для 404 использовать `404.html`, но сохранить статус **404**.
5. Не отдавать `index.html` вместо отсутствующей страницы.

Нужно проверить, что Caddy `handle_errors` не превращает 404 в 200. Если превращает —
использовать явный `respond`/шаблон с нужным статусом.

### 6.2. SPA

Логика:

1. Существующий файл → отдать.
2. Файл с расширением и не найден → 404.
3. Путь без расширения → `index.html`.
4. Не отдавать `/index.html` вместо отсутствующего `.js`/`.css`/картинки.

### 6.3. Hybrid

Логика:

1. Публичные статические пути — как static.
2. `/app/*` — SPA-fallback.
3. Неизвестный публичный путь → 404.
4. Ассеты с расширением → 404.

### 6.4. Порядок маршрутов

- `.well-known` и ACME — до сайта.
- скрытые файлы (`/.env`, `/.git`) — 404.
- `/sitemap.xml` и `/robots.txt` — сначала пользовательский файл, затем сгенерированный.
- `/404.html` — служебный файл, не должен быть доступен как обычная страница без редиректа.
- trailing slash — один канонический вариант, второй 301.

---

## 7. Sitemap и robots

### 7.1. Правило

Пользовательские файлы главнее. Если файла нет — платформа генерирует безопасный дефолт.

Это меняет старое решение «robots/sitemap остаются только файлами клиента»: для массового
продукта пользователи их просто не положат, и SEO будет пустым. Но нельзя перезаписывать
чужие файлы.

### 7.2. Sitemap

Строится из route manifest:

- `/` из `index.html`;
- `/about/` из `about/index.html`;
- `/blog/post/` из `blog/post/index.html`;
- 404, preview, noindex-страницы исключаются;
- `lastmod` — дата релиза, не выдуманная дата;
- лимит 50 000 URL / 50 MB; при превышении — sitemap index;
- базовый URL — primary domain;
- при смене primary domain sitemap перегенерируется.

### 7.3. Robots

Дефолт:

```text
User-agent: *
Allow: /

Sitemap: https://<primary-domain>/sitemap.xml
```

Для preview:

```text
User-agent: *
Disallow: /
```

Для 404 — `X-Robots-Tag: noindex`.

### 7.4. Где хранить сгенерированные файлы

Не мутировать релиз пользователя. Использовать отдельный overlay:

```text
/srv/sites/<slug>/seo/robots.txt
/srv/sites/<slug>/seo/sitemap.xml
```

Caddy проверяет сначала файл релиза, затем overlay. Overlay пересобирается при смене домена,
режима или публикации. Запись атомарная, общая для обеих нод.

---

## 8. Canonical и метаданные

### 8.1. Что нельзя делать

- Не вставлять canonical в чужой HTML молча.
- Не переписывать title/description пользователя.
- Не генерировать фиктивные structured data.
- Не делать canonical на preview.
- Не оставлять canonical на platform host после подключения custom.

### 8.2. Что можно делать

- В шаблонах платформы сразу использовать `SITE_URL`.
- Для произвольных сайтов показывать аудит: canonical отсутствует/указывает не туда.
- Опционально «SEO assist»: если canonical нет и пользователь включил опцию, вставить его
  в **собранный** HTML перед `</head>`; исходники не трогать.
- Всегда сохранять существующий canonical пользователя, если он валиден.

### 8.3. Проверки

- canonical абсолютный;
- canonical на primary domain;
- canonical не на preview;
- canonical не дублируется;
- canonical не указывает на 404;
- `lang` заполнен;
- title/description/H1 присутствуют;
- нет `noindex` на продакшене;
- нет `noindex` на главной и ключевых страницах.

---

## 9. SEO-аудит в панели

### 9.1. Когда запускать

- при публикации;
- по кнопке «Проверить SEO»;
- после подключения custom domain;
- после смены primary domain.

### 9.2. Уровни

**Critical:**

- продакшен отдаёт `noindex`;
- canonical ведёт на platform host при активном custom;
- static-сайт отдаёт 200 на неизвестный путь;
- sitemap/robots отдают 5xx;
- основной домен не HTTPS;
- сайт дублируется на двух доменах без 301/noindex.

**Warning:**

- нет title/description/H1;
- нет canonical;
- нет sitemap;
- нет `lang`;
- картинки без alt;
- большие изображения;
- нет structured data;
- битые внутренние ссылки.

**Info:**

- рекомендации по длине title/description;
- suggestions по Core Web Vitals;
- советы по контенту.

### 9.3. Поведение

- Warnings не блокируют публикацию.
- Critical показываются явно; для custom domain можно требовать подтверждение.
- Результат аудита хранится у релиза/сайта, чтобы панель показывала его после перезагрузки.
- Аудит не должен обещать позиции в поиске.

---

## 10. Редиректы и trailing slash

### 10.1. Редиректы

Поддержать простой формат `_redirects`:

```text
/old-page /new-page 301
/blog/* /articles/:splat 301
```

Правила:

- только внутренние пути или явно разрешённые внешние;
- 301 для постоянных, 302 только если пользователь явно попросил;
- сохранять query string;
- ограничить количество;
- проверять циклы;
- не делать open redirect.

### 10.2. Trailing slash

Выбрать один вариант:

- `/about/` — канонический, `/about` → 301;
- или `/about` — канонический, `/about/` → 301.

Не отдавать оба варианта с 200. Проверить ссылки в sitemap и canonical.

Реализация: политика `always | never | ignore` лежит в `seo/settings.json` (не в БД, чтобы
переживать rollback вместе с overlay). Default — `always` для static/hybrid и `ignore` для
SPA; пользователь меняет её в SEO-карточке. Caddy делает 301 на один вариант, сохраняя
query через `{?query}`; sitemap генерируется с тем же вариантом. Пользовательский файл
`_redirects` читается из корня активного релиза, ошибки показываются, но публикацию не
ломают. Общий `hosting-redirects.map` импортируется внутрь wildcard-блока; deploy создаёт
пустой файл и обновляет старый `hosting-modes.map` с тремя колонками до четырёх.

---

## 11. AI-агент и шаблоны

### 11.1. Выбор стека

Агент должен классифицировать задачу:

| Запрос | Стек по умолчанию |
|---|---|
| Лендинг, визитка, блог, документация | Astro / SSG |
| Магазин, каталог с динамикой | SSR или SSG + API |
| Личный кабинет, инструмент | SPA, приватные маршруты noindex |
| SaaS с лендингом и приложением | Hybrid: SSG + SPA `/app/*` |

Не делать React SPA дефолтом для контентных сайтов.

### 11.2. Что агент обязан сгенерировать

- отдельные HTML-страницы для публичных URL;
- title/description на каждую страницу;
- canonical через `SITE_URL`;
- `sitemap.xml` и `robots.txt` — по умолчанию их строит hosting overlay из релиза; агент создаёт свои только для явно нестандартного набора;
- `404.html`;
- alt у изображений;
- семантические заголовки;
- внутренние ссылки;
- корректный `lang`;
- structured data, если тип страницы очевиден;
- проверку сборки и прогон `seo.check` по публичным маршрутам до публикации; технический аудит живого релиза запускает панель публикации.

Практическая поддержка: инструмент `seo.templates` возвращает head с canonical/OG/Twitter,
JSON-LD, `public/404.html` и шаблон `public/_redirects`; агент адаптирует их под фреймворк.
Sitemap/robots и Google-файл он не дублирует — их строит overlay из реального релиза.
`seo.check` проверяет то, что агент может исправить до публикации: отрендеренные страницы
Preview и файлы проекта (title, description, H1, canonical, lang, noindex, alt, дубли title,
битые внутренние ссылки, `404.html`, `_redirects`, robots/sitemap). Аудит живого релиза
(каталог релиза, манифест, ответ 404 на реальном домене) остаётся у панели публикации:
у агента нет доступа к релизу, и выдавать его результат за свой нельзя. Готового
Astro-скаффолда пока нет.

### 11.3. Запрет

Агент не должен говорить «SEO готово», если:

- нет HTML-контента без JS;
- неизвестный путь отдаёт 200 в static;
- canonical отсутствует;
- sitemap/robots отсутствуют;
- `seo.check` не запускался, а панель ещё не показывала аудит живого релиза.

---

## 12. Данные, API и UI

### 12.1. Данные

Добавить к сайту:

- `routing_mode`: `auto | static | spa | hybrid | ssr`;
- `seo_settings`: JSON с `canonical`, `sitemap`, `robots`, `trailing_slash`, `redirects`;
- `primary_domain` / использовать существующий `is_canonical`;
- `seo_audit_json` и `seo_audit_at` у сайта или релиза;
- `route_manifest_json` у релиза (или вычислять из артефакта).

### 12.2. API

Предлагаемые маршруты:

```text
GET   /api/projects/:id/hosting/seo
PATCH /api/projects/:id/hosting/seo
POST  /api/projects/:id/hosting/seo/audit
```

`PATCH` принимает `routingMode`, `trailingSlash` (`always | never | ignore`) и
`googleVerification` (токен Search Console или `null`, чтобы удалить проверку). Ответ —
`HostingSeoView` с реальными `redirects`, `sitemapChunks`, `googleVerificationReady` и
`cdn.enabled`.

Публикация:

```text
POST /api/projects/:id/hosting/publish
{ "routingMode": "auto" | "static" | "spa" | "hybrid" }
```

Ответ аудита (без score и без обещания позиций):

```json
{
  "version": 1,
  "checkedAt": "2026-11-19T10:38:20Z",
  "mode": "static",
  "origin": "https://site.example.ru",
  "pages": 3,
  "issues": [
    { "id": "canonical-missing", "level": "warning", "title": "Нет canonical", "detail": "…" }
  ]
}
```

### 12.3. UI

В «Хостинге»:

- режим сайта;
- primary domain;
- статус sitemap/robots;
- кнопка «Проверить SEO»;
- список critical/warning;
- объяснение, что платформа уже сделала, а что нужно пользователю;
- ссылка на документацию.

Не показывать «SEO 100/100» как гарантию позиций.

---

## 13. Код: где менять

| Файл | Что делать |
|---|---|
| `server/src/hosting/artifact.ts` | Собрать route manifest, найти `404.html` |
| `server/src/hosting/publisher.ts` | Определить режим, сохранить manifest, запустить аудит |
| `server/src/hosting/caddy-config.ts` | Разные блоки для static/spa/hybrid, 404, noindex |
| `server/src/hosting/caddy-routes.ts` | Primary domain и platform-host редирект |
| `server/src/hosting/site-store.ts` | Поля `routing_mode`, SEO-настройки, аудит |
| `server/src/hosting/domain-service.ts` | Canonical policy, 301 после активации |
| `server/src/routes/hosting.ts` | API SEO/режима/аудита |
| `server/src/routes/custom-domains.ts` | Переключение primary domain |
| `src/features/hosting/HostingPanel.tsx` | Карточка SEO |
| `src/features/hosting/CustomDomainCard.tsx` | Canonical-подсказки |
| `src/lib/hosting-api.ts` | Типы и вызовы |
| `docs/SEO_PLATFORM_PLAN.md` | Обновлять статус после этапа |

Новую логику не складывать в один большой файл: `seo/` и `routing/` — отдельные небольшие
модули.

---

## 14. Этапы

### Этап 0. Решения и baseline — 1–2 дня

- [x] Утвердить режимы сайта.
- [x] Утвердить политику custom/platform host.
- [x] Утвердить правило sitemap/robots: defaults + override.
- [x] Утвердить правило canonical: шаблоны/opt-in, без молчаливой мутации.
- [x] Зафиксировать текущий baseline тестами.

**Гейт:** решения записаны, противоречий в документах нет.

### Этап 1. Static/404/noindex — 1–2 недели

- [x] `routing_mode` в данных.
- [x] Автоопределение static/spa.
- [x] Strict 404 для static.
- [x] `404.html` с кодом 404.
- [x] `noindex` для preview.
- [x] 301 platform host → custom после активации.
- [x] Тесты матрицы статусов (юнит; live Caddy не проверялся).

**Гейт:** static-сайт не отдаёт 200 на неизвестный путь; SPA не сломан; custom host не
дублируется.

### Этап 2. Sitemap/robots/route manifest — 2–3 недели

- [x] Route manifest из артефакта.
- [x] Sitemap из реальных страниц.
- [x] Robots default + override.
- [x] Overlay для сгенерированных файлов.
- [x] Пересборка при смене домена.
- [x] Тесты sitemap/robots (юнит).

**Гейт:** каждый публичный URL есть в sitemap; 404/preview отсутствуют; пользовательские
файлы не перезаписаны.

### Этап 3. SEO-аудит и редиректы — 2–3 недели

- [x] Аудит title/description/H1/canonical/lang/noindex.
- [x] Проверка 404 и sitemap живыми запросами (404 — live-probe; sitemap — файл).
- [x] UI-карточка SEO.
- [x] `_redirects` и trailing slash.
- [x] Critical/warning.
- [x] Тесты аудита.

**Гейт:** аудит ловит критичные ошибки; warnings не блокируют публикацию; редиректы не
ломают сайт.

### Этап 4. AI-шаблоны и SSG — 3–5 недель

- [ ] Astro/SSG шаблон для контентных сайтов.
- [ ] Hybrid-шаблон для SaaS.
- [x] Агент генерирует SEO-фрагменты и метаданные (`seo.templates`).
- [x] Аудит доступен агенту через панель; отдельный `seo.check` не добавлялся.
- [ ] Проверка на 5–10 реальных сайтах.

**Гейт:** новый лендинг/блог по умолчанию имеет HTML-страницы, canonical, sitemap, robots,
404 и проходит аудит.

### Этап 5. SSR/CDN/Search Console — 6–10 недель

- [ ] Node/SSR runtime. Сейчас серверные проекты явно отклоняются при публикации; фиктивного режима нет.
- [ ] Reverse proxy и лимиты для SSR.
- [x] CDN purge на публикации/rollback (существующий механизм); общего CDN-ресурса на сайт по-прежнему нет.
- [ ] Оптимизация изображений.
- [x] Search Console: подтверждение владения HTML-файлом; [ ] OAuth/API.
- [ ] hreflang.

**Гейт:** SSR не влияет на static-сайты; CDN не кэширует 404/редиректы неправильно;
интеграции не обязательны для базового SEO.

---

## 15. Матрица тестов

| Сценарий | Ожидание |
|---|---|
| Static: `/` | 200, HTML |
| Static: `/about/` | 200, HTML |
| Static: `/missing` | 404, `404.html`, `noindex` |
| Static: `/assets/missing.js` | 404, не `index.html` |
| SPA: `/dashboard` | 200, `index.html` |
| SPA: `/assets/missing.js` | 404 |
| SPA: `/missing` | 200, `index.html` (soft 404) |
| Hybrid: `/blog/post/` | 200, HTML |
| Hybrid: `/app/settings` | 200, `index.html` |
| Hybrid: `/missing` | 404 |
| Custom primary | 200 |
| Custom non-primary | 301 на primary, путь и query сохранены |
| Platform host при custom active | 301 на custom |
| Platform host без custom | 200 |
| Preview | 200 + `X-Robots-Tag: noindex, nofollow` |
| 404 | 404 + `noindex` |
| HTTP | 308/301 на HTTPS |
| Trailing slash | 301 на канонический вариант, query сохранён |
| `_redirects` | 301/302, wildcard, без цикла и open redirect |
| Sitemap | только 200-страницы, primary domain |
| Sitemap >50k | index + куски, каждый не больше 50k |
| Search Console | `google<token>.html` отдаётся с 200 |
| Robots | sitemap URL, preview disallow |

---

## 16. Риски

| Риск | Мера |
|---|---|
| Сломали SPA глобальным 404 | Режим сайта, fallback только для SPA/hybrid |
| Дублирование platform/custom | 301 после активации, noindex до неё |
| 301 на неактивный custom | Переключать только после `active` + TLS |
| Canonical остался на platform host | Аудит и предупреждение при смене домена |
| Sitemap содержит 404/preview | Генерация только из route manifest |
| Пользовательский sitemap перезаписан | Override wins |
| 404 отдаётся как 200 | Проверка статуса, не только тела |
| Caddy `handle_errors` меняет статус | Тест и явный `respond` при необходимости |
| Сгенерированные файлы не видны на второй ноде | Общий storage + атомарная запись |
| Аудит даёт ложные critical | Разделить critical/warning, тесты на реальных сайтах |
| SEO-аудит обещает позиции | Только технические проверки, без гарантий |

---

## 17. Не входит в первую версию

- SSR-рантайм.
- CDN для всех тарифов.
- Автоматическая генерация контента и title за пользователя.
- Молчаливая перезапись HTML пользователя.
- Гарантия позиций в Google/Яндексе.
- Собственный DNS-сервер.
- Управление Search Console за пользователя.
- Поддержка произвольных CMS.

---

## 18. Открытые решения

1. **Default mode для нового сайта:** `auto` или сразу `static` для контентных шаблонов?
   Рекомендация: `auto`, но шаблоны создают `static`.
2. **Platform host при custom:** 301 или только noindex?
   Рекомендация: 301 после активации, noindex как временная мера.
3. **Sitemap/robots:** генерировать всегда или только если файла нет?
   Рекомендация: только если файла нет; пользовательский файл главнее.
4. **Canonical:** только шаблоны или opt-in inject?
   Рекомендация: шаблоны + аудит; inject только по явному согласию.
5. **Redirects:** `_redirects` или UI-таблица?
   Рекомендация: `_redirects` в первой версии, UI позже.
6. **SSR:** отдельный тариф или всем?
   Рекомендация: отдельный этап и тариф, не смешивать со static.

---

## 19. Definition of Done

Для static-сайта:

- [ ] неизвестный путь → 404, не 200;
- [ ] кастомная 404-страница;
- [ ] отсутствующие ассеты → 404;
- [ ] canonical на primary domain;
- [ ] sitemap из реальных страниц;
- [ ] robots со ссылкой на sitemap;
- [ ] нет noindex на продакшене;
- [ ] HTTPS и 301;
- [ ] аудит проходит.

Для SPA:

- [ ] fallback работает;
- [ ] ассеты с расширением → 404;
- [ ] публичные страницы пререндерены или есть предупреждение;
- [ ] приватные маршруты noindex;
- [ ] нет обещания «SEO идеально» без пререндера.

Для custom domain:

- [ ] custom primary → 200;
- [ ] `www`/apex non-primary → 301;
- [ ] platform host → 301 после активации;
- [ ] canonical/sitemap на custom;
- [ ] preview noindex;
- [ ] нет дубля.

---

## 20. Журнал изменений

| Дата | Что изменилось | Проверка |
|---|---|---|
| 15.11.2026 | Создан план SEO-платформы; зафиксированы режимы, домены, sitemap/robots, аудит, этапы и тесты. | Документ создан; реализация не начата. |
| 19.11.2026, 10:38 UTC | Реализованы режимы сайта, route manifest, strict 404/404.html, Caddy map, sitemap/robots overlay, canonical 301 и preview noindex; добавлены SEO-аудит, API и UI. | `node --test` по caddy/route-manifest/audit/API хостинга; `tsc -p server/tsconfig.json --noEmit`; `tsc -b --noEmit`. Caddy validate на стенде не запускался. |
| 19.11.2026, 21:35 UTC | Добавлены `_redirects`, trailing slash, sitemap index >50k, `seo.templates`, Search Console HTML-файл и CDN-статус в SEO-панели. SSR и Astro-скаффолд остаются отдельными этапами. | `node --test` по redirects/sitemap/audit/caddy/API/шаблонам/промпту — 63/63; `tsc -p server/tsconfig.json --noEmit`; `tsc -b --noEmit`; Biome; `git diff --check`. Caddy validate на стенде не запускался. |
