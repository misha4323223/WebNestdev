/**
 * Сервисы, которые подключаются ключом. Описание повторяет серверный каталог
 * (`server/src/services/catalog.ts`): поля должны совпадать, иначе форма отправит не то,
 * что сервер ждёт. Названия переменных окружения приходят с сервера вместе со статусом.
 *
 * Правило ссылок: `keyUrl` — это страница, где ключ ВЫДАЁТСЯ, а не главная сервиса. Если кабинет
 * не даёт постоянной ссылки на нужный раздел, ведём на страницу входа кабинета или на инструкцию
 * провайдера именно про выдачу ключа. Пошаговых подсказок в каталоге нет: карточка их не
 * показывает, а ссылка ведёт туда, где ключ создаётся.
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
  fields: ServiceField[];
  /** Официальный логотип сервиса. */
  logo: BrandId;
};

export const SERVICES: ServiceInfo[] = [
  {
    id: "selectel-storage",
    logo: "selectel",
    name: "Selectel Object Storage",
    category: "storage",
    tagline: "S3-совместимое хранилище",
    keyUrl: "https://docs.selectel.ru/account/manage-keys/",
    docsUrl: "https://docs.selectel.ru/en/api/object-storage-s3/",
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
    name: "VK Cloud Object Storage",
    category: "storage",
    tagline: "S3-совместимое хранилище",
    keyUrl: "https://cloud.vk.ru/docs/ru/storage/s3/instructions/access-management/access-keys",
    docsUrl: "https://cloud.vk.ru/docs/en/storage/s3/quick-start",
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
    tagline: "S3-совместимое хранилище",
    keyUrl: "https://yandex.cloud/ru/docs/iam/operations/authentication/manage-access-keys",
    docsUrl: "https://yandex.cloud/ru/docs/storage/s3/",
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
    tagline: "S3-совместимое хранилище",
    keyUrl: "https://timeweb.cloud/docs/s3-storage/manage-storage/s3-guide",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
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
    name: "Cloud.ru Object Storage",
    category: "storage",
    tagline: "S3-совместимое хранилище",
    keyUrl: "https://cloud.ru/docs/s3e/ug/topics/api__api-key",
    docsUrl: "https://cloud.ru/docs/s3e/ug/topics/api__api-key",
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
    tagline: "Письма и рассылки",
    keyUrl: "https://app.notisend.ru/",
    docsUrl: "https://notisend.ru/dev/email/api/",
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета NotiSend", secret: true }],
  },
  {
    id: "sendsay",
    logo: "sendsay",
    name: "Sendsay",
    category: "email",
    tagline: "Рассылки и автоматизация",
    keyUrl: "https://docs.sendsay.ru/sendsay-api/how-to-get-apikey/",
    docsUrl: "https://docs.sendsay.ru/",
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
    tagline: "Транзакционные письма",
    keyUrl: "https://rusender.ru/knowledge-base/email-service/email-api/kak-sozdat-api-klyuch/",
    docsUrl: "https://rusender.ru/developer/api/email/",
    fields: [{ key: "apiKey", label: "API-токен", placeholder: "rs_ck_v1_…", secret: true }],
  },
  {
    id: "unisender",
    logo: "unisender",
    name: "Unisender",
    category: "email",
    tagline: "Рассылки и транзакционные письма",
    keyUrl: "https://www.unisender.com/ru/support/api/common/api-key/",
    docsUrl: "https://www.unisender.com/ru/support/api/common/api-key/",
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ из кабинета Unisender", secret: true }],
  },
  {
    id: "yandex-postbox",
    logo: "yandex-cloud",
    name: "Yandex Cloud Postbox",
    category: "email",
    tagline: "Транзакционные письма Yandex Cloud",
    keyUrl: "https://yandex.cloud/ru/docs/postbox/operations/send-email",
    docsUrl: "https://yandex.cloud/ru/docs/postbox/",
    fields: [
      { key: "apiKeyId", label: "Идентификатор API-ключа", placeholder: "идентификатор ключа сервисного аккаунта" },
      { key: "apiKeySecret", label: "Секретная часть ключа", placeholder: "секрет API-ключа", secret: true },
    ],
  },
  {
    id: "yookassa",
    logo: "yookassa",
    name: "ЮKassa",
    category: "payments",
    tagline: "Приём платежей",
    keyUrl: "https://yookassa.ru/my/merchant/integration/api-keys",
    docsUrl: "https://yookassa.ru/developers/api",
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
    tagline: "Интернет-эквайринг",
    keyUrl: "https://merchant.cloudpayments.ru/",
    docsUrl: "https://cloudpayments.atlassian.net/wiki/spaces/KB/pages/3664052280/public+id+API",
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
    tagline: "Приём платежей",
    keyUrl: "https://docs.robokassa.ru/ru/quick-start",
    docsUrl: "https://docs.robokassa.ru/ru/",
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
    tagline: "Интернет-эквайринг",
    keyUrl: "https://www.tbank.ru/business/help/business-payments/internet-acquiring/how-use/terminal/",
    docsUrl: "https://developer.tinkoff.ru/eacq/",
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
    tagline: "Языковая модель",
    keyUrl: "https://developers.sber.ru/studio/",
    docsUrl: "https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-token",
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
    tagline: "Языковые модели",
    keyUrl: "https://yandex.cloud/ru/docs/ai-studio/operations/get-api-key",
    docsUrl: "https://yandex.cloud/ru/docs/ai-studio/",
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
    tagline: "Карты и геокодер",
    keyUrl: "https://yandex.ru/maps-api/console",
    docsUrl: "https://yandex.com/maps-api/docs/geocoder-api/quickstart.html",
    fields: [{ key: "apiKey", label: "API-ключ", placeholder: "ключ геокодера", secret: true }],
  },
  {
    id: "2gis",
    logo: "2gis",
    name: "2GIS",
    category: "maps",
    tagline: "Карты и справочник",
    keyUrl: "https://platform.2gis.ru/ru/keys",
    docsUrl: "https://docs.2gis.com/en/api/search/regions/overview",
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
    tagline: "CRM, задачи и сайты",
    keyUrl: "https://apidocs.bitrix24.ru/local-integrations/local-webhooks.html",
    docsUrl: "https://apidocs.bitrix24.ru/local-integrations/local-webhooks.html",
    fields: [{ key: "webhookUrl", label: "Ссылка вебхука", placeholder: "https://портал.bitrix24.ru/rest/1/…/", secret: true }],
  },
  {
    id: "amocrm",
    logo: "amocrm",
    name: "amoCRM",
    category: "crm",
    tagline: "CRM для продаж",
    keyUrl: "https://developers.kommo.com/docs/private-integration",
    docsUrl: "https://developers.kommo.com/docs/long-lived-token",
    fields: [
      { key: "host", label: "Адрес аккаунта", placeholder: "https://ваш-домен.amocrm.ru" },
      { key: "token", label: "Долгосрочный токен", placeholder: "токен интеграции", secret: true },
    ],
  },
];
