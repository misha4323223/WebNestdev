/**
 * Сервисы, которые подключаются ключом. Описание повторяет серверный каталог
 * (`server/src/services/catalog.ts`): поля и шаги должны совпадать, иначе форма отправит не то,
 * что сервер ждёт. Названия переменных окружения приходят с сервера вместе со статусом.
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
  secret?: boolean;
  multiline?: boolean;
  optional?: boolean;
};

export type ServiceInfo = {
  id: string;
  name: string;
  category: ServiceCategoryId;
  tagline: string;
  consoleUrl: string;
  docsUrl: string;
  steps: string[];
  fields: ServiceField[];
  /** Фирменный цвет и монограмма плитки. */
  color: string;
  mark: string;
};

export const SERVICES: ServiceInfo[] = [
  {
    id: "selectel-storage",
    name: "Selectel",
    category: "storage",
    tagline: "Объектное хранилище Selectel",
    consoleUrl: "https://my.selectel.ru/",
    docsUrl: "https://docs.selectel.ru/en/api/object-storage-s3/",
    steps: [
      "Панель Selectel → «Пользователи сервиса»: сервисный пользователь с доступом к S3.",
      "В разделе S3 создайте ключ: Access key и Secret key.",
      "Вставьте ключи сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Access key", placeholder: "ключ доступа" },
      { key: "secretKey", label: "Secret key", placeholder: "секретный ключ", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию s3.storage.selcloud.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-1", optional: true },
    ],
    color: "#1d4ed8",
    mark: "S",
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
      "Создайте аккаунт и сохраните Access Key ID и Secret Key.",
      "Вставьте их сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Access Key ID", placeholder: "ключ доступа" },
      { key: "secretKey", label: "Secret Key", placeholder: "секретный ключ", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию hb.ru-msk.vkcloud-storage.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-msk", optional: true },
    ],
    color: "#0077ff",
    mark: "VK",
  },
  {
    id: "yandex-storage",
    name: "Yandex Object Storage",
    category: "storage",
    tagline: "Хранилище Yandex Cloud",
    consoleUrl: "https://console.yandex.cloud/",
    docsUrl: "https://yandex.cloud/ru/docs/storage/s3/",
    steps: [
      "Консоль Yandex Cloud → «Сервисные аккаунты» с ролью на хранилище.",
      "«Создать новый ключ» → «Создать статический ключ доступа».",
      "Вставьте key_id и secret — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Статический ключ (key_id)", placeholder: "идентификатор ключа" },
      { key: "secretKey", label: "Секретный ключ", placeholder: "secret", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию storage.yandexcloud.net", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-central1", optional: true },
    ],
    color: "#fc3f1d",
    mark: "Y",
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
      "Бакет → «Панель управления»: S3 Access Key и S3 Secret Access Key.",
      "Вставьте их сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "S3 Access Key", placeholder: "ключ доступа" },
      { key: "secretKey", label: "S3 Secret Access Key", placeholder: "секретный ключ", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию s3.twcstorage.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-1", optional: true },
    ],
    color: "#0b6bff",
    mark: "T",
  },
  {
    id: "cloudru-storage",
    name: "Cloud.ru",
    category: "storage",
    tagline: "Object Storage Cloud.ru",
    consoleUrl: "https://console.cloud.ru/",
    docsUrl: "https://cloud.ru/docs/s3e/ug/topics/api__api-key",
    steps: [
      "Консоль Cloud.ru → Object Storage → «Параметры работы с API»: tenant ID.",
      "Создайте ключ доступа: Key ID и Key Secret.",
      "Заполните три поля — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "tenantId", label: "Tenant ID", placeholder: "идентификатор тенанта" },
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа" },
      { key: "secretKey", label: "Key Secret", placeholder: "секрет ключа", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию s3.cloud.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-central-1", optional: true },
    ],
    color: "#1f4fd8",
    mark: "C",
  },
  {
    id: "notisend",
    name: "NotiSend",
    category: "email",
    tagline: "Письма и рассылки, серверы в РФ",
    consoleUrl: "https://notisend.ru/",
    docsUrl: "https://notisend.ru/dev/email/api/",
    steps: [
      "Кабинет NotiSend → «Автоматизация» → «API и SMTP».",
      "Скопируйте API-ключ (для писем, не для SMS).",
      "Вставьте ключ — проверим чтением списка шаблонов.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета NotiSend", secret: true }],
    color: "#00a3ff",
    mark: "N",
  },
  {
    id: "sendsay",
    name: "Sendsay",
    category: "email",
    tagline: "Российский сервис рассылок",
    consoleUrl: "https://app.sendsay.ru/",
    docsUrl: "https://docs.sendsay.ru/sendsay-api/how-to-get-apikey/",
    steps: [
      "Sendsay → «Настройки системы» → «Пользователи»: отдельный пользователь для API.",
      "В его настройках сгенерируйте API-ключ.",
      "Вставьте код аккаунта и ключ — проверим вызовом pong.",
    ],
    fields: [
      { key: "account", label: "Код аккаунта", placeholder: "обычно совпадает с логином" },
      { key: "apiKey", label: "API-ключ", placeholder: "ключ пользователя API", secret: true },
    ],
    color: "#ff5c35",
    mark: "S",
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
      "Дайте ключу право external_mail.read.",
      "Вставьте токен (rs_ck_v1_…) — проверим чтением списка ключей отправки.",
    ],
    fields: [{ key: "apiKey", label: "API-токен", placeholder: "rs_ck_v1_…", secret: true }],
    color: "#e8543f",
    mark: "R",
  },
  {
    id: "unisender",
    name: "Unisender",
    category: "email",
    tagline: "Самый известный сервис рассылок (лицензиар на Кипре)",
    consoleUrl: "https://www.unisender.com/ru/",
    docsUrl: "https://www.unisender.com/ru/support/api/common/api-key/",
    steps: [
      "Кабинет Unisender → «Настройки» → «Интеграция и API».",
      "Включите доступ к API и скопируйте ключ.",
      "Вставьте ключ — проверим чтением списка адресов.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета Unisender", secret: true }],
    color: "#8b5cf6",
    mark: "U",
  },
  {
    id: "yookassa",
    name: "ЮKassa",
    category: "payments",
    tagline: "Приём платежей (Сбер)",
    consoleUrl: "https://yookassa.ru/my",
    docsUrl: "https://yookassa.ru/developers/api",
    steps: [
      "Кабинет ЮKassa → «Интеграция» → «Ключи API».",
      "Скопируйте shopId и секретный ключ магазина.",
      "Вставьте оба поля — проверим запросом сведений о магазине.",
    ],
    fields: [
      { key: "shopId", label: "Shop ID", placeholder: "идентификатор магазина" },
      { key: "secretKey", label: "Секретный ключ", placeholder: "secret_key", secret: true },
    ],
    color: "#0f52ba",
    mark: "Ю",
  },
  {
    id: "cloudpayments",
    name: "CloudPayments",
    category: "payments",
    tagline: "Интернет-эквайринг Т-Банка",
    consoleUrl: "https://merchant.cloudpayments.ru/",
    docsUrl: "https://developers.cloudpayments.ru/",
    steps: [
      "Кабинет CloudPayments → «Настройки» → «API».",
      "Скопируйте Public ID и API Secret.",
      "Вставьте их сюда — проверим служебным методом test.",
    ],
    fields: [
      { key: "publicId", label: "Public ID", placeholder: "pk_…" },
      { key: "apiSecret", label: "API Secret", placeholder: "секрет API", secret: true },
    ],
    color: "#1a73e8",
    mark: "CP",
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
      "Скопируйте MerchantLogin и оба пароля.",
      "Внимание: Robokassa проверить безопасно нельзя — сохраним без проверки.",
    ],
    fields: [
      { key: "merchantLogin", label: "MerchantLogin", placeholder: "логин магазина" },
      { key: "password1", label: "Password #1", placeholder: "пароль №1", secret: true },
      { key: "password2", label: "Password #2", placeholder: "пароль №2", secret: true },
    ],
    color: "#ef6c00",
    mark: "R",
  },
  {
    id: "tbank-payments",
    name: "Т-Банк Эквайринг",
    category: "payments",
    tagline: "Интернет-эквайринг Т-Банка",
    consoleUrl: "https://www.tbank.ru/business/",
    docsUrl: "https://developer.tinkoff.ru/eacq/",
    steps: [
      "Личный кабинет Т-Бизнес → «Эквайринг» → терминал.",
      "Скопируйте TerminalKey и Password.",
      "Внимание: у Т-Банка нет безопасной проверки — сохраним без проверки.",
    ],
    fields: [
      { key: "terminalKey", label: "TerminalKey", placeholder: "ключ терминала" },
      { key: "password", label: "Password", placeholder: "пароль терминала", secret: true },
    ],
    color: "#ffdd2d",
    mark: "Т",
  },
  {
    id: "gigachat",
    name: "GigaChat",
    category: "ai",
    tagline: "Модель Сбера",
    consoleUrl: "https://developers.sber.ru/portal/products/gigachat-api",
    docsUrl: "https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-token",
    steps: [
      "Кабинет Sber Developers → проект GigaChat API.",
      "Скопируйте «Авторизационный ключ» (Base64 от Client ID:Client Secret).",
      "Вставьте ключ — проверим обменом на токен и списком моделей.",
    ],
    fields: [
      { key: "authKey", label: "Авторизационный ключ", placeholder: "Base64 Client ID:Client Secret", secret: true },
      { key: "scope", label: "Scope (необязательно)", placeholder: "по умолчанию GIGACHAT_API_PERS", optional: true },
    ],
    color: "#21a038",
    mark: "G",
  },
  {
    id: "yandex-ai",
    name: "Yandex AI Studio",
    category: "ai",
    tagline: "Модели Yandex Cloud",
    consoleUrl: "https://console.yandex.cloud/",
    docsUrl: "https://yandex.cloud/ru/docs/ai-studio/",
    steps: [
      "Консоль Yandex Cloud → сервисный аккаунт → API-ключ с доступом к AI Studio.",
      "Скопируйте ключ и идентификатор каталога (folder id).",
      "Вставьте оба поля — проверка отправит короткий тестовый запрос.",
    ],
    fields: [
      { key: "apiKey", label: "API-ключ", placeholder: "AQVN…", secret: true },
      { key: "folderId", label: "Folder ID", placeholder: "идентификатор каталога" },
    ],
    color: "#fc3f1d",
    mark: "YA",
  },
  {
    id: "yandex-maps",
    name: "Yandex Maps API",
    category: "maps",
    tagline: "Карты и геокодер Яндекса",
    consoleUrl: "https://developer.tech.yandex.ru/",
    docsUrl: "https://yandex.com/maps-api/docs/geocoder-api/quickstart.html",
    steps: [
      "Кабинет разработчика Яндекса → подключить Geocoder API.",
      "Скопируйте API-ключ.",
      "Вставьте ключ — проверим запросом «Москва» к геокодеру.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ геокодера", secret: true }],
    color: "#fc3f1d",
    mark: "YM",
  },
  {
    id: "2gis",
    name: "2GIS",
    category: "maps",
    tagline: "Карты и справочник 2GIS",
    consoleUrl: "https://platform.2gis.ru/",
    docsUrl: "https://docs.2gis.com/en/api/search/regions/overview",
    steps: [
      "Platform Manager 2GIS → создайте ключ (есть бесплатный demo-ключ).",
      "Скопируйте ключ.",
      "Вставьте ключ — проверим поиском региона.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ 2GIS", secret: true }],
    color: "#00b956",
    mark: "2G",
  },
  {
    id: "retailcrm",
    name: "RetailCRM",
    category: "crm",
    tagline: "CRM для интернет-магазинов",
    consoleUrl: "https://www.retailcrm.ru/",
    docsUrl: "https://help.retailcrm.pro/Developers/ApiRules",
    steps: [
      "RetailCRM → «Администрирование» → «Интеграции» → «Ключи API».",
      "Скопируйте адрес аккаунта и ключ.",
      "Вставьте оба поля — проверим методом credentials.",
    ],
    fields: [
      { key: "accountUrl", label: "Адрес аккаунта", placeholder: "https://ваш-аккаунт.retailcrm.ru" },
      { key: "apiKey", label: "Ключ API", placeholder: "ключ из кабинета", secret: true },
    ],
    color: "#2b6cb0",
    mark: "RC",
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
      "Выберите права (например, crm) и скопируйте ссылку вебхука.",
      "Вставьте ссылку — проверим методом user.current.",
    ],
    fields: [{ key: "webhookUrl", label: "Ссылка вебхука", placeholder: "https://портал.bitrix24.ru/rest/1/…/", secret: true }],
    color: "#2fc7f7",
    mark: "Б24",
  },
  {
    id: "amocrm",
    name: "amoCRM",
    category: "crm",
    tagline: "CRM с долгосрочным токеном",
    consoleUrl: "https://www.amocrm.ru/",
    docsUrl: "https://developers.kommo.com/docs/long-lived-token",
    steps: [
      "amoCRM → «Настройки» → «Интеграции»: приватная интеграция.",
      "«Ключи и права доступа» → долгосрочный токен.",
      "Вставьте адрес аккаунта и токен — проверим чтением аккаунта.",
    ],
    fields: [
      { key: "host", label: "Адрес аккаунта", placeholder: "https://ваш-домен.amocrm.ru" },
      { key: "token", label: "Долгосрочный токен", placeholder: "токен интеграции", secret: true },
    ],
    color: "#339dc7",
    mark: "A",
  },
];
