/**
 * Российские облака, которые подключаются ключом. Описание повторяет серверный каталог
 * (`server/src/cloud/providers.ts`): поля и шаги должны совпадать, иначе форма отправит
 * не то, что сервер ждёт. Отдельный файл — чтобы карточки и каталог не разрастались.
 */

export type CloudProviderId = "timeweb" | "cloudru" | "mws";

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
  consoleUrl: string;
  docsUrl: string;
  /** Короткий слоган под названием — одна строка, без абзацев. */
  tagline: string;
  fields: CloudProviderField[];
  steps: string[];
  /** Фирменный цвет и монограмма для плитки, пока нет официального файла логотипа. */
  color: string;
  mark: string;
};

export const CLOUD_PROVIDERS: CloudProviderInfo[] = [
  {
    id: "timeweb",
    name: "Timeweb Cloud",
    consoleUrl: "https://timeweb.cloud/",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    tagline: "Серверы, базы и хранилище",
    fields: [{ key: "token", label: "API-токен", placeholder: "токен из раздела «API и Terraform»", secret: true }],
    steps: [
      "Личный кабинет → «API и Terraform».",
      "Создайте токен и скопируйте его.",
      "Вставьте сюда — проверим чтением серверов.",
    ],
    color: "#0b6bff",
    mark: "T",
  },
  {
    id: "cloudru",
    name: "Cloud.ru",
    consoleUrl: "https://console.cloud.ru/",
    docsUrl: "https://cloud.ru/docs/console_api/ug/topics/guides__auth_api",
    tagline: "Бывш. SberCloud",
    fields: [
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа" },
      { key: "secret", label: "Key Secret", placeholder: "секрет ключа", secret: true },
    ],
    steps: [
      "Консоль → «Пользователи» → «Сервисные аккаунты».",
      "Создайте аккаунт и ключ доступа.",
      "Вставьте Key ID и Secret — проверим обменом на токен.",
    ],
    color: "#1f4fd8",
    mark: "C",
  },
  {
    id: "mws",
    name: "MWS (МТС)",
    consoleUrl: "https://mws.ru/",
    docsUrl: "https://mws.ru/docs/cloud-platform/iam/general/sa-get-access-token.html",
    tagline: "Облако МТС",
    fields: [{ key: "key", label: "Авторизованный ключ", placeholder: "содержимое key.json целиком", multiline: true, secret: true }],
    steps: [
      "Консоль MWS → сервисные аккаунты.",
      "Создайте авторизованный ключ (key.json).",
      "Вставьте файл целиком — проверим чтением проектов.",
    ],
    color: "#e30611",
    mark: "МТС",
  },
];
