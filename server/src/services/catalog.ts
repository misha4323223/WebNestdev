/**
 * Каталог сервисов, которые подключаются ключом из кабинета провайдера: файлы, почта, оплата,
 * AI, карты, CRM. Ни у одного из них нет GitHub-подобного «войди и разреши», поэтому карточка
 * работает как у облаков: шаги, ссылка на кабинет, проверка ключа до сохранения.
 *
 * Правило проверки: ключ сохраняется после того, как провайдер его принял. Там, где безопасной
 * проверки не существует (Robokassa, Т-Банк), карточка честно сохраняет без проверки —
 * `verification: "store"` и предупреждение в интерфейсе.
 *
 * Координаты провайдеров и способы проверки подтверждены по их документации в октябре 2026
 * (см. docs/INTEGRATIONS_ROADMAP.md).
 */

export type ServiceCategoryId = "storage" | "email" | "payments" | "ai" | "maps" | "crm";

export type ServiceCategory = {
  id: ServiceCategoryId;
  name: string;
  note: string;
};

export const SERVICE_CATEGORIES: ServiceCategory[] = [
  { id: "storage", name: "Файлы", note: "Хранилище файлов приложения: картинки, документы, аватары" },
  { id: "email", name: "Почта", note: "Письма из приложения: подтверждение, сброс пароля, уведомления" },
  { id: "payments", name: "Оплата", note: "Приём денег: магазины, донаты, подписки внутри приложения" },
  { id: "ai", name: "AI", note: "Модели внутри приложения: чат, генерация текста" },
  { id: "maps", name: "Карты", note: "Адреса, доставка, карта точек на странице" },
  { id: "crm", name: "CRM", note: "Заявки с формы сайта уходят менеджеру" },
];

export type ServiceField = {
  key: string;
  label: string;
  placeholder: string;
  /** Значение скрывается в интерфейсе, но приходит на сервер как есть. */
  secret?: boolean;
  /** Поле можно не заполнять: тогда используется значение из `defaults`. */
  optional?: boolean;
};

/** Переменная окружения, которую сервис добавляет в проект пользователя. */
export type ServiceEnvVar = {
  name: string;
  field: string;
};

export type ServiceDefinition = {
  id: string;
  name: string;
  category: ServiceCategoryId;
  /** Одна строка под названием. */
  tagline: string;
  consoleUrl: string;
  docsUrl: string;
  steps: string[];
  fields: ServiceField[];
  /** Значения необязательных полей, если пользователь их не заполнил. */
  defaults?: Record<string, string>;
  /** Производные поля: например accessKey = tenantId:keyId. */
  derive?: (fields: Record<string, string>) => Record<string, string>;
  env: ServiceEnvVar[];
  /** `check` — ключ проверяется запросом к провайдеру; `store` — проверки не существует. */
  verification: "check" | "store";
  /** Что именно проверяется или почему проверки нет — текст для карточки. */
  verificationNote: string;
};

const S3_ENV = (): ServiceEnvVar[] => [
  { name: "S3_ENDPOINT", field: "endpoint" },
  { name: "S3_REGION", field: "region" },
  { name: "S3_ACCESS_KEY_ID", field: "accessKey" },
  { name: "S3_SECRET_ACCESS_KEY", field: "secretKey" },
];

const S3_OPTIONAL: ServiceField[] = [
  { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию из документации провайдера", optional: true },
  { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию — регион провайдера", optional: true },
];

export const SERVICES: ServiceDefinition[] = [
  // ── Файлы ─────────────────────────────────────────────────────────────────
  {
    id: "selectel-storage",
    name: "Selectel",
    category: "storage",
    tagline: "Объектное хранилище Selectel",
    consoleUrl: "https://my.selectel.ru/",
    docsUrl: "https://docs.selectel.ru/en/api/object-storage-s3/",
    steps: [
      "Панель Selectel → «Пользователи сервиса» (IAM): создайте сервисного пользователя с доступом к S3.",
      "В разделе S3 создайте ключ: Access key и Secret key.",
      "Вставьте ключи сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Access key", placeholder: "ключ доступа" },
      { key: "secretKey", label: "Secret key", placeholder: "секретный ключ", secret: true },
      ...S3_OPTIONAL,
    ],
    defaults: { endpoint: "https://s3.storage.selcloud.ru", region: "ru-1" },
    env: S3_ENV(),
    verification: "check",
    verificationNote: "Проверяем чтением списка бакетов. Если у ключа нет роли на список (s3.bucket.user) — сообщим об этом отдельно.",
  },
  {
    id: "vk-storage",
    name: "VK Cloud",
    category: "storage",
    tagline: "Объектное хранилище VK Cloud",
    consoleUrl: "https://cloud.vk.ru/",
    docsUrl: "https://cloud.vk.ru/docs/en/storage/s3/quick-start",
    steps: [
      "Консоль VK Cloud → «Облачное хранилище» → «Аккаунты».",
      "Создайте аккаунт и сохраните Access Key ID и Secret Key (секрет показывается один раз).",
      "Вставьте их сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Access Key ID", placeholder: "ключ доступа" },
      { key: "secretKey", label: "Secret Key", placeholder: "секретный ключ", secret: true },
      ...S3_OPTIONAL,
    ],
    defaults: { endpoint: "https://hb.ru-msk.vkcloud-storage.ru", region: "ru-msk" },
    env: S3_ENV(),
    verification: "check",
    verificationNote: "Проверяем чтением списка бакетов.",
  },
  {
    id: "yandex-storage",
    name: "Yandex Object Storage",
    category: "storage",
    tagline: "Хранилище Yandex Cloud",
    consoleUrl: "https://console.yandex.cloud/",
    docsUrl: "https://yandex.cloud/ru/docs/storage/s3/",
    steps: [
      "Консоль Yandex Cloud → «Сервисные аккаунты»: у аккаунта должна быть роль на хранилище.",
      "«Создать новый ключ» → «Создать статический ключ доступа».",
      "Вставьте key_id и secret — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Статический ключ (key_id)", placeholder: "идентификатор ключа" },
      { key: "secretKey", label: "Секретный ключ", placeholder: "secret", secret: true },
      ...S3_OPTIONAL,
    ],
    defaults: { endpoint: "https://storage.yandexcloud.net", region: "ru-central1" },
    env: S3_ENV(),
    verification: "check",
    verificationNote: "Регион для Yandex всегда ru-central1; сервисный аккаунт видит бакеты своего каталога.",
  },
  {
    id: "timeweb-storage",
    name: "Timeweb Cloud S3",
    category: "storage",
    tagline: "Хранилище Timeweb Cloud",
    consoleUrl: "https://timeweb.cloud/",
    docsUrl: "https://timeweb.cloud/docs/s3-storage/manage-storage/s3-guide",
    steps: [
      "Личный кабинет Timeweb Cloud → раздел S3-хранилища.",
      "Откройте бакет → вкладка «Панель управления»: S3 Access Key и S3 Secret Access Key.",
      "Вставьте их сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "S3 Access Key", placeholder: "ключ доступа" },
      { key: "secretKey", label: "S3 Secret Access Key", placeholder: "секретный ключ", secret: true },
      ...S3_OPTIONAL,
    ],
    defaults: { endpoint: "https://s3.twcstorage.ru", region: "ru-1" },
    env: S3_ENV(),
    verification: "check",
    verificationNote: "Проверяем чтением списка бакетов.",
  },
  {
    id: "cloudru-storage",
    name: "Cloud.ru",
    category: "storage",
    tagline: "Object Storage Cloud.ru",
    consoleUrl: "https://console.cloud.ru/",
    docsUrl: "https://cloud.ru/docs/s3e/ug/topics/api__api-key",
    steps: [
      "Консоль Cloud.ru → «Хранение данных» → Object Storage → «Параметры работы с API»: скопируйте tenant ID.",
      "Создайте ключ доступа: Key ID и Key Secret.",
      "Заполните три поля — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "tenantId", label: "Tenant ID", placeholder: "идентификатор тенанта" },
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа" },
      { key: "secretKey", label: "Key Secret", placeholder: "секрет ключа", secret: true },
      ...S3_OPTIONAL,
    ],
    defaults: { endpoint: "https://s3.cloud.ru", region: "ru-central-1" },
    derive: fields => ({ accessKey: fields.tenantId + ":" + fields.keyId }),
    env: S3_ENV(),
    verification: "check",
    verificationNote: "Cloud.ru ждёт access key в виде tenant_id:key_id — склеиваем его сами.",
  },

  // ── Почта ─────────────────────────────────────────────────────────────────
  {
    id: "notisend",
    name: "NotiSend",
    category: "email",
    tagline: "Письма и рассылки, серверы в РФ",
    consoleUrl: "https://notisend.ru/",
    docsUrl: "https://notisend.ru/dev/email/api/",
    steps: [
      "Кабинет NotiSend → «Автоматизация» → «API и SMTP» → «Параметры подключения».",
      "Скопируйте API-ключ (для писем, не для SMS).",
      "Вставьте ключ — проверим чтением списка шаблонов.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета NotiSend", secret: true }],
    env: [{ name: "NOTISEND_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем чтением списка шаблонов писем — ничего не отправляем.",
  },
  {
    id: "sendsay",
    name: "Sendsay",
    category: "email",
    tagline: "Российский сервис рассылок",
    consoleUrl: "https://app.sendsay.ru/",
    docsUrl: "https://docs.sendsay.ru/sendsay-api/how-to-get-apikey/",
    steps: [
      "Sendsay → «Настройки системы» → «Пользователи»: добавьте отдельного пользователя для API.",
      "В его настройках сгенерируйте API-ключ (2FA у пользователя должна быть выключена).",
      "Вставьте код аккаунта и API-ключ — проверим вызовом pong.",
    ],
    fields: [
      { key: "account", label: "Код аккаунта", placeholder: "обычно совпадает с логином" },
      { key: "apiKey", label: "API-ключ", placeholder: "ключ пользователя API", secret: true },
    ],
    env: [{ name: "SENDSAY_ACCOUNT", field: "account" }, { name: "SENDSAY_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем методом pong: он только подтверждает доступ, ничего не отправляет.",
  },
  {
    id: "rusender",
    name: "RuSender",
    category: "email",
    tagline: "Письма через API и SMTP",
    consoleUrl: "https://rusender.ru/",
    docsUrl: "https://rusender.ru/developer/api/email/",
    steps: [
      "Кабинет RuSender → «Интеграции» → «API» → «Создать API-ключ».",
      "Дайте ключу право external_mail.read — его достаточно для проверки.",
      "Вставьте ключ (rs_ck_v1_…) — проверим чтением списка ключей отправки.",
    ],
    fields: [{ key: "apiKey", label: "API-токен", placeholder: "rs_ck_v1_…", secret: true }],
    env: [{ name: "RUSENDER_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем чтением списка ключей отправки — ничего не отправляем.",
  },
  {
    id: "unisender",
    name: "Unisender",
    category: "email",
    tagline: "Самый известный сервис рассылок (лицензиар на Кипре)",
    consoleUrl: "https://www.unisender.com/ru/",
    docsUrl: "https://www.unisender.com/ru/support/api/common/api-key/",
    steps: [
      "Кабинет Unisender → «Настройки» → «Интеграция и API»: включите доступ к API.",
      "Скопируйте API-ключ.",
      "Вставьте ключ — проверим чтением списка адресов.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета Unisender", secret: true }],
    env: [{ name: "UNISENDER_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем методом getLists — он только читает список адресов.",
  },

  // ── Оплата ────────────────────────────────────────────────────────────────
  {
    id: "yookassa",
    name: "ЮKassa",
    category: "payments",
    tagline: "Приём платежей (Сбер)",
    consoleUrl: "https://yookassa.ru/my",
    docsUrl: "https://yookassa.ru/developers/api",
    steps: [
      "Личный кабинет ЮKassa → «Интеграция» → «Ключи API»: скопируйте shopId и секретный ключ.",
      "Для магазина должен быть подключён приём платежей.",
      "Вставьте оба поля — проверим запросом сведений о магазине.",
    ],
    fields: [
      { key: "shopId", label: "Shop ID", placeholder: "идентификатор магазина" },
      { key: "secretKey", label: "Секретный ключ", placeholder: "secret_key", secret: true },
    ],
    env: [{ name: "YOOKASSA_SHOP_ID", field: "shopId" }, { name: "YOOKASSA_SECRET_KEY", field: "secretKey" }],
    verification: "check",
    verificationNote: "Проверяем методом /v3/me: читаем сведения о магазине, денег не трогаем.",
  },
  {
    id: "cloudpayments",
    name: "CloudPayments",
    category: "payments",
    tagline: "Интернет-эквайринг Т-Банка",
    consoleUrl: "https://merchant.cloudpayments.ru/",
    docsUrl: "https://developers.cloudpayments.ru/",
    steps: [
      "Личный кабинет CloudPayments → «Настройки» → «API»: Public ID и API Secret.",
      "Скопируйте оба значения.",
      "Вставьте их сюда — проверим служебным методом test.",
    ],
    fields: [
      { key: "publicId", label: "Public ID", placeholder: "pk_…" },
      { key: "apiSecret", label: "API Secret", placeholder: "секрет API", secret: true },
    ],
    env: [{ name: "CLOUDPAYMENTS_PUBLIC_ID", field: "publicId" }, { name: "CLOUDPAYMENTS_API_SECRET", field: "apiSecret" }],
    verification: "check",
    verificationNote: "Проверяем методом /test — он только отвечает статусом, платёж не создаётся.",
  },
  {
    id: "robokassa",
    name: "Robokassa",
    category: "payments",
    tagline: "Приём платежей, принимает самозанятых",
    consoleUrl: "https://partner.robokassa.ru/",
    docsUrl: "https://robokassa.com/blog/articles/nachalo-raboty/",
    steps: [
      "Кабинет Robokassa → «Магазин» → технические настройки.",
      "Скопируйте MerchantLogin и оба пароля (Password #1 и Password #2).",
      "Вставьте их: Robokassa проверить безопасно нельзя — сохраним без проверки и напишем об этом.",
    ],
    fields: [
      { key: "merchantLogin", label: "MerchantLogin", placeholder: "логин магазина" },
      { key: "password1", label: "Password #1", placeholder: "пароль №1", secret: true },
      { key: "password2", label: "Password #2", placeholder: "пароль №2", secret: true },
    ],
    env: [
      { name: "ROBOKASSA_MERCHANT_LOGIN", field: "merchantLogin" },
      { name: "ROBOKASSA_PASSWORD1", field: "password1" },
      { name: "ROBOKASSA_PASSWORD2", field: "password2" },
    ],
    verification: "store",
    verificationNote: "Robokassa не даёт безопасного запроса для проверки ключей: любой подходящий вызов — это уже операция оплаты. Ключи сохраняются без проверки.",
  },
  {
    id: "tbank-payments",
    name: "Т-Банк Эквайринг",
    category: "payments",
    tagline: "Интернет-эквайринг Т-Банка",
    consoleUrl: "https://www.tbank.ru/business/",
    docsUrl: "https://developer.tinkoff.ru/eacq/",
    steps: [
      "Личный кабинет Т-Бизнес → «Эквайринг» → терминал: TerminalKey и Password.",
      "Скопируйте оба значения.",
      "Вставьте их: безопасной проверки у Т-Банка нет — сохраним без проверки и напишем об этом.",
    ],
    fields: [
      { key: "terminalKey", label: "TerminalKey", placeholder: "ключ терминала" },
      { key: "password", label: "Password", placeholder: "пароль терминала", secret: true },
    ],
    env: [{ name: "TBANK_TERMINAL_KEY", field: "terminalKey" }, { name: "TBANK_PASSWORD", field: "password" }],
    verification: "store",
    verificationNote: "Т-Банк подписывает каждый запрос паролем терминала, а любой запрос — уже операция. Проверить ключи, ничего не сделав, нельзя: сохраняем без проверки.",
  },

  // ── AI ────────────────────────────────────────────────────────────────────
  {
    id: "gigachat",
    name: "GigaChat",
    category: "ai",
    tagline: "Модель Сбера",
    consoleUrl: "https://developers.sber.ru/portal/products/gigachat-api",
    docsUrl: "https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-token",
    steps: [
      "Личный кабинет Sber Developers → проект GigaChat API.",
      "Скопируйте «Авторизационный ключ» (Base64 от Client ID:Client Secret).",
      "Вставьте ключ — проверим обменом на токен и чтением списка моделей.",
    ],
    fields: [
      { key: "authKey", label: "Авторизационный ключ", placeholder: "Base64 Client ID:Client Secret", secret: true },
      { key: "scope", label: "Scope (необязательно)", placeholder: "GIGACHAT_API_PERS — для физлиц", optional: true },
    ],
    defaults: { scope: "GIGACHAT_API_PERS" },
    env: [{ name: "GIGACHAT_AUTH_KEY", field: "authKey" }, { name: "GIGACHAT_SCOPE", field: "scope" }],
    verification: "check",
    verificationNote: "Проверяем обменом ключа на короткий токен и чтением списка моделей — генерации нет, списаний нет.",
  },
  {
    id: "yandex-ai",
    name: "Yandex AI Studio",
    category: "ai",
    tagline: "Модели Yandex Cloud",
    consoleUrl: "https://console.yandex.cloud/",
    docsUrl: "https://yandex.cloud/ru/docs/ai-studio/",
    steps: [
      "Консоль Yandex Cloud → «Сервисные аккаунты»: создайте API-ключ с доступом к AI Studio.",
      "Скопируйте API-ключ и идентификатор каталога (folder id).",
      "Вставьте оба поля — проверка отправит крошечный тестовый запрос к модели.",
    ],
    fields: [
      { key: "apiKey", label: "API-ключ", placeholder: "AQVN…", secret: true },
      { key: "folderId", label: "Folder ID", placeholder: "идентификатор каталога" },
    ],
    env: [{ name: "YANDEX_AI_API_KEY", field: "apiKey" }, { name: "YANDEX_AI_FOLDER_ID", field: "folderId" }],
    verification: "check",
    verificationNote: "Проверка отправляет один короткий запрос к модели — это доли копейки, но не бесплатно.",
  },

  // ── Карты ─────────────────────────────────────────────────────────────────
  {
    id: "yandex-maps",
    name: "Yandex Maps API",
    category: "maps",
    tagline: "Карты и геокодер Яндекса",
    consoleUrl: "https://developer.tech.yandex.ru/",
    docsUrl: "https://yandex.com/maps-api/docs/geocoder-api/quickstart.html",
    steps: [
      "Кабинет разработчика Яндекса → «Подключить API» → Geocoder API.",
      "Скопируйте API-ключ.",
      "Вставьте ключ — проверим запросом «Москва» к геокодеру.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ геокодера", secret: true }],
    env: [{ name: "YANDEX_MAPS_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем геокодером: он ничего не меняет и не расходует платные лимиты заметно.",
  },
  {
    id: "2gis",
    name: "2GIS",
    category: "maps",
    tagline: "Карты и справочник 2GIS",
    consoleUrl: "https://platform.2gis.ru/",
    docsUrl: "https://docs.2gis.com/en/api/search/regions/overview",
    steps: [
      "Platform Manager 2GIS → создайте ключ (для пробы есть бесплатный demo-ключ).",
      "Скопируйте ключ.",
      "Вставьте ключ — проверим поиском региона.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ 2GIS", secret: true }],
    env: [{ name: "TWOGIS_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем поиском региона: читающий запрос, данные не меняются.",
  },

  // ── CRM ───────────────────────────────────────────────────────────────────
  {
    id: "retailcrm",
    name: "RetailCRM",
    category: "crm",
    tagline: "CRM для интернет-магазинов",
    consoleUrl: "https://www.retailcrm.ru/",
    docsUrl: "https://help.retailcrm.pro/Developers/ApiRules",
    steps: [
      "RetailCRM → «Администрирование» → «Интеграции» → «Ключи API»: создайте ключ.",
      "Скопируйте адрес аккаунта (вида https://demo.retailcrm.ru) и ключ.",
      "Вставьте оба поля — проверим методом credentials.",
    ],
    fields: [
      { key: "accountUrl", label: "Адрес аккаунта", placeholder: "https://ваш-аккаунт.retailcrm.ru" },
      { key: "apiKey", label: "Ключ API", placeholder: "ключ из кабинета", secret: true },
    ],
    env: [{ name: "RETAILCRM_URL", field: "accountUrl" }, { name: "RETAILCRM_API_KEY", field: "apiKey" }],
    verification: "check",
    verificationNote: "Проверяем методом credentials: он показывает права ключа, ничего не меняя.",
  },
  {
    id: "bitrix24",
    name: "Битрикс24",
    category: "crm",
    tagline: "CRM через входящий вебхук",
    consoleUrl: "https://www.bitrix24.ru/",
    docsUrl: "https://apidocs.bitrix24.com/local-integrations/local-webhooks.html",
    steps: [
      "Битрикс24 → «Приложения» → «Разработчикам» → «Другое» → «Входящий вебхук».",
      "Выберите права (например, crm) и скопируйте всю ссылку вебхука.",
      "Вставьте ссылку — проверим методом user.current.",
    ],
    fields: [{ key: "webhookUrl", label: "Ссылка вебхука", placeholder: "https://портал.bitrix24.ru/rest/1/…/", secret: true }],
    env: [{ name: "BITRIX24_WEBHOOK_URL", field: "webhookUrl" }],
    verification: "check",
    verificationNote: "Ссылка вебхука сама является паролем: она шифруется и не возвращается в браузер.",
  },
  {
    id: "amocrm",
    name: "amoCRM",
    category: "crm",
    tagline: "CRM с долгосрочным токеном",
    consoleUrl: "https://www.amocrm.ru/",
    docsUrl: "https://developers.kommo.com/docs/long-lived-token",
    steps: [
      "amoCRM → «Настройки» → «Интеграции»: создайте приватную интеграцию.",
      "«Ключи и права доступа» → сгенерируйте долгосрочный токен (показывается один раз).",
      "Вставьте адрес аккаунта и токен — проверим чтением сведений об аккаунте.",
    ],
    fields: [
      { key: "host", label: "Адрес аккаунта", placeholder: "https://ваш-домен.amocrm.ru" },
      { key: "token", label: "Долгосрочный токен", placeholder: "токен из настроек интеграции", secret: true },
    ],
    env: [{ name: "AMOCRM_HOST", field: "host" }, { name: "AMOCRM_ACCESS_TOKEN", field: "token" }],
    verification: "check",
    verificationNote: "Проверяем чтением сведений об аккаунте — сделки и контакты не трогаем.",
  },
];

export function findService(id: string): ServiceDefinition | undefined {
  return SERVICES.find(service => service.id === id);
}

/**
 * Поля из формы + значения по умолчанию + производные поля. Обязательные поля проверяются,
 * необязательные подставляются из `defaults`, поэтому и проверка ключа, и переменные проекта
 * видят одинаковый набор.
 */
export function resolveServiceFields(service: ServiceDefinition, input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) throw new Error("Ожидался объект с полями доступа");
  const values = input as Record<string, unknown>;
  const fields: Record<string, string> = { ...(service.defaults ?? {}) };
  for (const field of service.fields) {
    const raw = values[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      if (field.optional) continue;
      throw new Error("Заполните поле «" + field.label + "»");
    }
    if (value.length > 8000) throw new Error("Поле «" + field.label + "» слишком длинное");
    fields[field.key] = value;
  }
  if (service.derive) Object.assign(fields, service.derive(fields));
  return fields;
}

/** Переменные окружения проекта для подключённого сервиса. */
export function serviceEnvValues(service: ServiceDefinition, fields: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of service.env) {
    const value = fields[entry.field];
    if (typeof value === "string" && value) values[entry.name] = value;
  }
  return values;
}
