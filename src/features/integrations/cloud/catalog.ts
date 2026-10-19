/**
 * Российские облака, которые подключаются ключом. Описание повторяет серверный каталог
 * (`server/src/cloud/providers.ts`): поля и шаги должны совпадать, иначе форма отправит
 * не то, что сервер ждёт. Отдельный файл — чтобы карточки и каталог не разрастались.
 *
 * `keyUrl` — страница, где ключ выдаётся, а не главная облака: у консоли нет постоянной ссылки
 * на раздел сервисного аккаунта, поэтому ведём на инструкцию провайдера именно про создание
 * ключа, а шаги называют разделы консоли по именам.
 */

import type { BrandId } from "../../../components/BrandLogo";

export type CloudProviderId = "timeweb" | "cloudru" | "mws" | "regru";

export type CloudProviderField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
};

export type CloudProviderInfo = {
  id: CloudProviderId;
  name: string;
  /** Страница выдачи ключа — ссылка «Где взять ключ» ведёт ровно туда. */
  keyUrl: string;
  docsUrl: string;
  /** Короткий слоган под названием — одна строка, без абзацев. */
  tagline: string;
  fields: CloudProviderField[];
  steps: string[];
  /** Официальный логотип сервиса. */
  logo: BrandId;
};

export const CLOUD_PROVIDERS: CloudProviderInfo[] = [
  {
    id: "timeweb",
    logo: "timeweb",
    name: "Timeweb Cloud",
    keyUrl: "https://timeweb.cloud/docs/account-management/token",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    tagline: "Серверы, базы и хранилище",
    fields: [{ key: "token", label: "API-токен", placeholder: "токен из раздела «API и Terraform»", secret: true }],
    steps: [
      "Панель → вкладка «API и Terraform» → «Добавить токен».",
      "«Выпустить» — токен показывается один раз, сохраните его.",
      "Вставьте сюда — проверим чтением серверов.",
    ],
  },
  {
    id: "cloudru",
    logo: "cloudru",
    name: "Cloud.ru",
    keyUrl: "https://cloud.ru/docs/console_api/ug/topics/guides__service_accounts_key-create",
    docsUrl: "https://cloud.ru/docs/console_api/ug/topics/guides__auth_api",
    tagline: "Бывш. SberCloud",
    fields: [
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа" },
      { key: "secret", label: "Key Secret", placeholder: "секрет ключа", secret: true },
    ],
    steps: [
      "Консоль → выберите проект → «Пользователи» → «Сервисные аккаунты».",
      "Откройте аккаунт → «Учетные данные доступа» → «Ключи доступа» → «Создать ключ».",
      "Вставьте Key ID и Secret — проверим обменом на токен.",
    ],
  },
  {
    id: "mws",
    logo: "mts",
    name: "MWS (МТС)",
    keyUrl: "https://mws.ru/docs/cloud-platform/iam/general/keys-auth-create.html",
    docsUrl: "https://mws.ru/docs/cloud-platform/iam/general/sa-get-access-token.html",
    tagline: "Облако МТС",
    fields: [{ key: "key", label: "Авторизованный ключ", placeholder: "содержимое key.json целиком", multiline: true, secret: true }],
    steps: [
      "Консоль MWS → выберите проект → IAM → «Сервисные аккаунты» → откройте аккаунт.",
      "«Ключи доступа» → «Создать» → «Авторизованный ключ»: скачайте key.json.",
      "Вставьте файл целиком — проверим чтением проектов.",
    ],
  },
  {
    id: "regru",
    logo: "regru",
    name: "REG.RU Облако",
    keyUrl: "https://reg.cloud/support/cloud/oblachnyye-servery/rabota-s-serverom/api-dlya-oblachnykh-serverov",
    docsUrl: "https://developers.cloudvps.reg.ru/",
    tagline: "Облачные серверы REG.RU",
    fields: [{ key: "token", label: "API-ключ облака", placeholder: "ключ из «Настройки» → «Настройки окружения»", secret: true }],
    steps: [
      "Кабинет cloud.reg.ru → «Настройки» → «Настройки окружения»: там лежит API-ключ.",
      "Ключ создаётся автоматически — скопируйте его; он открывает все операции облачных серверов.",
      "Вставьте сюда — проверим чтением списка серверов.",
    ],
  },
];
