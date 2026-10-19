/**
 * Сервисы, которые подключаются ключом. Описание повторяет серверный каталог
 * (`server/src/services/catalog.ts`): поля и шаги должны совпадать, иначе форма отправит не то,
 * что сервер ждёт. Названия переменных окружения приходят с сервера вместе со статусом.
 *
 * Правило ссылок: `keyUrl` — это страница, где ключ ВЫДАЁТСЯ, а не главная сервиса. Если кабинет
 * не даёт постоянной ссылки на нужный раздел, ведём на страницу входа кабинета или на инструкцию
 * провайдера именно про выдачу ключа; шаги при этом называют разделы так, как они подписаны в
 * кабинете. Шаги сверяются с документацией провайдеров; устаревшие названия разделов — это баг:
 * пользователь ищет вкладку, которой нет.
 */

import type { BrandId } from "../../../components/BrandLogo";

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
  /** Страница выдачи ключа — ссылка «Где взять ключ» ведёт ровно туда. */
  keyUrl: string;
  docsUrl: string;
  steps: string[];
  fields: ServiceField[];
  /** Официальный логотип сервиса. */
  logo: BrandId;
};

export const SERVICES: ServiceInfo[] = [
  {
    id: "selectel-storage",
    logo: "selectel",
    name: "Selectel",
    category: "storage",
    tagline: "Объектное хранилище Selectel",
    keyUrl: "https://docs.selectel.ru/account/manage-keys/",
    docsUrl: "https://docs.selectel.ru/en/api/object-storage-s3/",
    steps: [
      "my.selectel.ru → меню аккаунта → «Профиль» → «Доступ» → «S3-ключи» → «Добавить ключ».",
      "Назовите ключ, выберите проект, скопируйте Access key и Secret key — секрет показывается один раз.",
      "Вставьте ключи сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Access key", placeholder: "ключ доступа" },
      { key: "secretKey", label: "Secret key", placeholder: "секретный ключ", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию s3.storage.selcloud.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-1", optional: true },
    ],
  },
  {
    id: "vk-storage",
    logo: "vk",
    name: "VK Cloud",
    category: "storage",
    tagline: "Объектное хранилище VK Cloud",
    keyUrl: "https://cloud.vk.ru/docs/ru/storage/s3/instructions/access-management/access-keys",
    docsUrl: "https://cloud.vk.ru/docs/en/storage/s3/quick-start",
    steps: [
      "cloud.vk.ru → выберите проект → «Object Storage» → «Аккаунты».",
      "«Добавить ключ доступа»: Access Key ID и Secret Key показываются сразу — сохраните их.",
      "Вставьте их сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Access Key ID", placeholder: "ключ доступа" },
      { key: "secretKey", label: "Secret Key", placeholder: "секретный ключ", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию hb.ru-msk.vkcloud-storage.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-msk", optional: true },
    ],
  },
  {
    id: "yandex-storage",
    logo: "yandex-cloud",
    name: "Yandex Object Storage",
    category: "storage",
    tagline: "Хранилище Yandex Cloud",
    keyUrl: "https://yandex.cloud/ru/docs/iam/operations/authentication/manage-access-keys",
    docsUrl: "https://yandex.cloud/ru/docs/storage/s3/",
    steps: [
      "Консоль Yandex Cloud → каталог → «Сервисные аккаунты»: аккаунт с ролью на Object Storage.",
      "В аккаунте: «Создать новый ключ» → «Создать статический ключ доступа» — key_id и secret показываются один раз.",
      "Вставьте обе части — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "Статический ключ (key_id)", placeholder: "идентификатор ключа" },
      { key: "secretKey", label: "Секретный ключ", placeholder: "secret", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию storage.yandexcloud.net", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-central1", optional: true },
    ],
  },
  {
    id: "timeweb-storage",
    logo: "timeweb",
    name: "Timeweb Cloud S3",
    category: "storage",
    tagline: "Хранилище Timeweb Cloud",
    keyUrl: "https://timeweb.cloud/docs/s3-storage/manage-storage/s3-guide",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    steps: [
      "Панель Timeweb Cloud → «S3-хранилища» → откройте бакет.",
      "В панели управления бакетом скопируйте S3 Access Key и S3 Secret Access Key.",
      "Вставьте их сюда — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "accessKey", label: "S3 Access Key", placeholder: "ключ доступа" },
      { key: "secretKey", label: "S3 Secret Access Key", placeholder: "секретный ключ", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию s3.twcstorage.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-1", optional: true },
    ],
  },
  {
    id: "cloudru-storage",
    logo: "cloudru",
    name: "Cloud.ru",
    category: "storage",
    tagline: "Object Storage Cloud.ru",
    keyUrl: "https://cloud.ru/docs/s3e/ug/topics/api__api-key",
    docsUrl: "https://cloud.ru/docs/s3e/ug/topics/api__api-key",
    steps: [
      "Консоль Cloud.ru → проект → Object Storage → «Параметры работы с API»: скопируйте tenant ID.",
      "Там же создайте ключ доступа: Key ID и Key Secret.",
      "Заполните три поля — проверим чтением списка бакетов.",
    ],
    fields: [
      { key: "tenantId", label: "Tenant ID", placeholder: "идентификатор тенанта" },
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа" },
      { key: "secretKey", label: "Key Secret", placeholder: "секрет ключа", secret: true },
      { key: "endpoint", label: "Endpoint (необязательно)", placeholder: "по умолчанию s3.cloud.ru", optional: true },
      { key: "region", label: "Регион (необязательно)", placeholder: "по умолчанию ru-central-1", optional: true },
    ],
  },
  {
    id: "notisend",
    logo: "notisend",
    name: "NotiSend",
    category: "email",
    tagline: "Письма и рассылки, серверы в РФ",
    keyUrl: "https://app.notisend.ru/",
    docsUrl: "https://notisend.ru/dev/email/api/",
    steps: [
      "Кабинет NotiSend → «Автоматизация» → «API и SMTP» → «Параметры подключения API и SMTP».",
      "Скопируйте API-ключ (для писем, не для SMS).",
      "Вставьте ключ — проверим чтением списка шаблонов.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета NotiSend", secret: true }],
  },
  {
    id: "sendsay",
    logo: "sendsay",
    name: "Sendsay",
    category: "email",
    tagline: "Российский сервис рассылок",
    keyUrl: "https://docs.sendsay.ru/sendsay-api/how-to-get-apikey/",
    docsUrl: "https://docs.sendsay.ru/",
    steps: [
      "Sendsay → «Настройки системы» → «Пользователи»: заведите отдельного пользователя для API.",
      "В карточке пользователя → «API-ключ» → «Сгенерировать ключ» (у владельца аккаунта ключ не выдаётся).",
      "Вставьте код аккаунта и ключ — проверим вызовом pong.",
    ],
    fields: [
      { key: "account", label: "Код аккаунта", placeholder: "обычно совпадает с логином" },
      { key: "apiKey", label: "API-ключ", placeholder: "ключ пользователя API", secret: true },
    ],
  },
  {
    id: "rusender",
    logo: "rusender",
    name: "RuSender",
    category: "email",
    tagline: "Письма через API и SMTP",
    keyUrl: "https://rusender.ru/knowledge-base/email-service/email-api/kak-sozdat-api-klyuch/",
    docsUrl: "https://rusender.ru/developer/api/email/",
    steps: [
      "Кабинет RuSender → «Интеграции» → «API» → «Создать API-ключ».",
      "Дайте ключу право external_mail.read (это ключ аккаунта, а не ключ отправки для домена).",
      "Вставьте токен (rs_ck_v1_…) — проверим чтением списка ключей отправки.",
    ],
    fields: [{ key: "apiKey", label: "API-токен", placeholder: "rs_ck_v1_…", secret: true }],
  },
  {
    id: "unisender",
    logo: "unisender",
    name: "Unisender",
    category: "email",
    tagline: "Самый известный сервис рассылок (лицензиар на Кипре)",
    keyUrl: "https://www.unisender.com/ru/support/api/common/api-key/",
    docsUrl: "https://www.unisender.com/ru/support/api/common/api-key/",
    steps: [
      "Кабинет Unisender → нажмите на свой e-mail в нижнем левом углу.",
      "«Настройки» → «Интеграция и API» → «Доступ к API»: включите доступ и скопируйте ключ.",
      "Вставьте ключ — проверим чтением списка адресов.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета Unisender", secret: true }],
  },
  {
    id: "yookassa",
    logo: "yookassa",
    name: "ЮKassa",
    category: "payments",
    tagline: "Приём платежей (Сбер)",
    keyUrl: "https://yookassa.ru/my/merchant/integration/api-keys",
    docsUrl: "https://yookassa.ru/developers/api",
    steps: [
      "Кабинет ЮKassa → переключателем сверху выберите магазин.",
      "«Интеграция» → «Ключи API» → «Выпустить ключ»: скопируйте shopId и секретный ключ.",
      "Вставьте оба поля — проверим запросом сведений о магазине.",
    ],
    fields: [
      { key: "shopId", label: "Shop ID", placeholder: "идентификатор магазина" },
      { key: "secretKey", label: "Секретный ключ", placeholder: "secret_key", secret: true },
    ],
  },
  {
    id: "cloudpayments",
    logo: "cloudpayments",
    name: "CloudPayments",
    category: "payments",
    tagline: "Интернет-эквайринг Т-Банка",
    keyUrl: "https://merchant.cloudpayments.ru/",
    docsUrl: "https://cloudpayments.atlassian.net/wiki/spaces/KB/pages/3664052280/public+id+API",
    steps: [
      "Кабинет CloudPayments → «Сайты» → выберите свой сайт.",
      "На странице сайта скопируйте Public ID и «Пароль для API».",
      "Вставьте их сюда — проверим служебным методом test.",
    ],
    fields: [
      { key: "publicId", label: "Public ID", placeholder: "pk_…" },
      { key: "apiSecret", label: "API Secret", placeholder: "секрет API", secret: true },
    ],
  },
  {
    id: "robokassa",
    logo: "robokassa",
    name: "Robokassa",
    category: "payments",
    tagline: "Приём платежей, принимает самозанятых",
    keyUrl: "https://docs.robokassa.ru/ru/quick-start",
    docsUrl: "https://docs.robokassa.ru/ru/",
    steps: [
      "Войдите в кабинет Robokassa → «Мои магазины» → выберите магазин.",
      "«Технические настройки»: скопируйте MerchantLogin и оба пароля (Password #1 и #2).",
      "Внимание: Robokassa проверить безопасно нельзя — сохраним без проверки.",
    ],
    fields: [
      { key: "merchantLogin", label: "MerchantLogin", placeholder: "логин магазина" },
      { key: "password1", label: "Password #1", placeholder: "пароль №1", secret: true },
      { key: "password2", label: "Password #2", placeholder: "пароль №2", secret: true },
    ],
  },
  {
    id: "tbank-payments",
    logo: "tbank",
    name: "Т-Банк Эквайринг",
    category: "payments",
    tagline: "Интернет-эквайринг Т-Банка",
    keyUrl: "https://www.tbank.ru/business/help/business-payments/internet-acquiring/how-use/terminal/",
    docsUrl: "https://developer.tinkoff.ru/eacq/",
    steps: [
      "Личный кабинет интернет-эквайринга → «Магазины» → выберите магазин → «Терминалы».",
      "«Настроить» → в настройках рабочего терминала скопируйте TerminalKey и Password.",
      "Внимание: у Т-Банка нет безопасной проверки — сохраним без проверки.",
    ],
    fields: [
      { key: "terminalKey", label: "TerminalKey", placeholder: "ключ терминала" },
      { key: "password", label: "Password", placeholder: "пароль терминала", secret: true },
    ],
  },
  {
    id: "gigachat",
    logo: "gigachat",
    name: "GigaChat",
    category: "ai",
    tagline: "Модель Сбера",
    keyUrl: "https://developers.sber.ru/studio/",
    docsUrl: "https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-token",
    steps: [
      "Studio (developers.sber.ru) → создайте проект типа GigaChat API.",
      "В проекте: «Настройки API» → «Получить ключ» — скопируйте «Авторизационный ключ» (Base64 от Client ID:Client Secret).",
      "Вставьте ключ — проверим обменом на токен и списком моделей.",
    ],
    fields: [
      { key: "authKey", label: "Авторизационный ключ", placeholder: "Base64 Client ID:Client Secret", secret: true },
      { key: "scope", label: "Scope (необязательно)", placeholder: "по умолчанию GIGACHAT_API_PERS", optional: true },
    ],
  },
  {
    id: "yandex-ai",
    logo: "yandex-cloud",
    name: "Yandex AI Studio",
    category: "ai",
    tagline: "Модели Yandex Cloud",
    keyUrl: "https://yandex.cloud/ru/docs/ai-studio/operations/get-api-key",
    docsUrl: "https://yandex.cloud/ru/docs/ai-studio/",
    steps: [
      "AI Studio → «Доступ» → «API-ключи»: в строке нужного сервисного аккаунта нажмите «Создать API-ключ».",
      "Скопируйте ключ и идентификатор каталога (folder id).",
      "Вставьте оба поля — проверка отправит короткий тестовый запрос.",
    ],
    fields: [
      { key: "apiKey", label: "API-ключ", placeholder: "AQVN…", secret: true },
      { key: "folderId", label: "Folder ID", placeholder: "идентификатор каталога" },
    ],
  },
  {
    id: "yandex-maps",
    logo: "yandex",
    name: "Yandex Maps API",
    category: "maps",
    tagline: "Карты и геокодер Яндекса",
    keyUrl: "https://yandex.ru/maps-api/console",
    docsUrl: "https://yandex.com/maps-api/docs/geocoder-api/quickstart.html",
    steps: [
      "Кабинет разработчика Яндекс Карт → «Получить ключ» → выберите нужный API (геокодер).",
      "Заполните форму — ключ появится в разделе «Ключи».",
      "Вставьте ключ — проверим запросом «Москва» к геокодеру.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ геокодера", secret: true }],
  },
  {
    id: "2gis",
    logo: "2gis",
    name: "2GIS",
    category: "maps",
    tagline: "Карты и справочник 2GIS",
    keyUrl: "https://platform.2gis.ru/ru/keys",
    docsUrl: "https://docs.2gis.com/en/api/search/regions/overview",
    steps: [
      "Platform Manager 2GIS → «Ключи API» → «Создать API-ключ» (для подписки; демо-ключ выдаётся на главной).",
      "Скопируйте ключ.",
      "Вставьте ключ — проверим поиском региона.",
    ],
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ 2GIS", secret: true }],
  },
  {
    id: "retailcrm",
    logo: "retailcrm",
    name: "RetailCRM",
    category: "crm",
    tagline: "CRM для интернет-магазинов",
    keyUrl: "https://help.retailcrm.pro/Users/ApiKeys",
    docsUrl: "https://help.retailcrm.pro/Developers/ApiRules",
    steps: [
      "Ваш аккаунт RetailCRM → «Администрирование» → «Интеграции».",
      "В списке ключей нажмите «Добавить»: скопируйте адрес аккаунта и ключ API.",
      "Вставьте оба поля — проверим методом credentials.",
    ],
    fields: [
      { key: "accountUrl", label: "Адрес аккаунта", placeholder: "https://ваш-аккаунт.retailcrm.ru" },
      { key: "apiKey", label: "Ключ API", placeholder: "ключ из кабинета", secret: true },
    ],
  },
  {
    id: "bitrix24",
    logo: "bitrix24",
    name: "Битрикс24",
    category: "crm",
    tagline: "CRM через входящий вебхук",
    keyUrl: "https://apidocs.bitrix24.ru/local-integrations/local-webhooks.html",
    docsUrl: "https://apidocs.bitrix24.ru/local-integrations/local-webhooks.html",
    steps: [
      "Ваш портал Битрикс24 → «Приложения» → «Разработчикам» → «Готовые сценарии» → «Другое» → «Входящий вебхук».",
      "Выберите права (например, crm) и скопируйте ссылку вебхука.",
      "Вставьте ссылку — проверим методом user.current.",
    ],
    fields: [{ key: "webhookUrl", label: "Ссылка вебхука", placeholder: "https://портал.bitrix24.ru/rest/1/…/", secret: true }],
  },
  {
    id: "amocrm",
    logo: "amocrm",
    name: "amoCRM",
    category: "crm",
    tagline: "CRM с долгосрочным токеном",
    keyUrl: "https://developers.kommo.com/docs/private-integration",
    docsUrl: "https://developers.kommo.com/docs/long-lived-token",
    steps: [
      "Ваш аккаунт amoCRM → «Настройки» → «Интеграции» → создайте приватную интеграцию.",
      "В ней: «Ключи и права доступа» → долгосрочный токен (создаёт только администратор).",
      "Вставьте адрес аккаунта и токен — проверим чтением аккаунта.",
    ],
    fields: [
      { key: "host", label: "Адрес аккаунта", placeholder: "https://ваш-домен.amocrm.ru" },
      { key: "token", label: "Долгосрочный токен", placeholder: "токен интеграции", secret: true },
    ],
  },
];
