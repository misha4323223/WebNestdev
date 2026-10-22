/**
 * Российские облака, которые подключаются ключом. Описание повторяет серверный каталог
 * (`server/src/cloud/providers.ts`): поля должны совпадать, иначе форма отправит не то, что
 * сервер ждёт. Отдельный файл — чтобы карточки и каталог не разрастались.
 *
 * `keyUrl` — страница, где ключ выдаётся, а не главная облака: у консоли нет постоянной ссылки
 * на раздел сервисного аккаунта, поэтому ведём на инструкцию провайдера именно про создание
 * ключа. Пошаговых подсказок в каталоге нет: карточка их не показывает, путь к ключу объясняет
 * страница по кнопке «Где взять ключ».
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
  },
  {
    id: "cloudru",
    logo: "cloudru",
    name: "Cloud.ru",
    keyUrl: "https://cloud.ru/docs/console_api/ug/topics/guides__service_accounts_key-create",
    docsUrl: "https://cloud.ru/docs/console_api/ug/topics/guides__auth_api",
    tagline: "Облачная платформа",
    fields: [
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа" },
      { key: "secret", label: "Key Secret", placeholder: "секрет ключа", secret: true },
    ],
  },
  {
    id: "mws",
    logo: "mts",
    name: "MWS (МТС)",
    keyUrl: "https://mws.ru/docs/cloud-platform/iam/general/keys-auth-create.html",
    docsUrl: "https://mws.ru/docs/cloud-platform/iam/general/sa-get-access-token.html",
    tagline: "Облачная платформа",
    fields: [{ key: "key", label: "Авторизованный ключ", placeholder: "содержимое key.json целиком", multiline: true, secret: true }],
  },
  {
    id: "regru",
    logo: "regru",
    name: "REG.RU Облако",
    keyUrl: "https://reg.cloud/support/cloud/oblachnyye-servery/rabota-s-serverom/api-dlya-oblachnykh-serverov",
    docsUrl: "https://developers.cloudvps.reg.ru/",
    tagline: "Облачные серверы",
    fields: [{ key: "token", label: "API-ключ облака", placeholder: "ключ из «Настройки» → «Настройки окружения»", secret: true }],
  },
];
