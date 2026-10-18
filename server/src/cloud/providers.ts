/**
 * Каталог российских облаков, которые подключаются ключом.
 *
 * Общее у них одно: GitHub-подобного «войди и разреши» для доступа к ресурсам нет ни у кого
 * (проверено по документации в октябре 2026) — везде сервисный аккаунт или токен из личного
 * кабинета. Разное — способ проверки ключа, поэтому проверка живёт в verify.ts, а здесь только
 * описание: что спросить у пользователя и куда его отправить.
 */

export type CloudProviderId = "timeweb" | "cloudru" | "mws";

export type CloudField = {
  key: string;
  /** Подпись поля в форме. */
  label: string;
  /** Пример значения — чтобы не гадать, что вставлять. */
  placeholder: string;
  /** Значение скрывается в интерфейсе (токен/секрет), но приходит на сервер как есть. */
  secret?: boolean;
  /** Многострочное поле: JSON-ключ удобнее вставлять целиком. */
  multiline?: boolean;
};

export type CloudProvider = {
  id: CloudProviderId;
  name: string;
  /** Куда ведёт кнопка «Открыть консоль». */
  consoleUrl: string;
  /** Документация провайдера по ключам. */
  docsUrl: string;
  fields: CloudField[];
  /** Короткие шаги: что сделать в консоли, прежде чем вставлять ключ. */
  steps: string[];
};

const TOKEN_FIELD: CloudField = { key: "token", label: "API-токен", placeholder: "токен из личного кабинета", secret: true };

export const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    id: "timeweb",
    name: "Timeweb Cloud",
    consoleUrl: "https://timeweb.cloud/",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    fields: [TOKEN_FIELD],
    steps: [
      "Откройте личный кабинет Timeweb Cloud.",
      "Раздел «API и Terraform» → создайте токен.",
      "Вставьте токен ниже — доступ только на чтение проверяется запросом к серверам.",
    ],
  },
  {
    id: "cloudru",
    name: "Cloud.ru",
    consoleUrl: "https://console.cloud.ru/",
    docsUrl: "https://cloud.ru/docs/console_api/ug/topics/guides__auth_api",
    fields: [
      { key: "keyId", label: "Key ID", placeholder: "идентификатор ключа сервисного аккаунта" },
      { key: "secret", label: "Key Secret", placeholder: "секрет ключа", secret: true },
    ],
    steps: [
      "Откройте консоль Cloud.ru → «Пользователи» → «Сервисные аккаунты».",
      "Создайте аккаунт и его ключ доступа (Key ID и Key Secret).",
      "Вставьте обе части ниже — платформа обменяет их на токен и проверит доступ.",
    ],
  },
  {
    id: "mws",
    name: "MWS (МТС)",
    consoleUrl: "https://mws.ru/",
    docsUrl: "https://mws.ru/docs/cloud-platform/iam/general/sa-get-access-token.html",
    fields: [{ key: "key", label: "Авторизованный ключ", placeholder: '{"keyId":"…","privateKey":"…"} — файл key.json целиком', multiline: true, secret: true }],
    steps: [
      "Откройте консоль MWS → сервисные аккаунты.",
      "Создайте авторизованный ключ и скачайте key.json.",
      "Вставьте файл целиком: платформа обменяет его на IAM-токен и прочитает проекты.",
    ],
  },
];

export function findCloudProvider(id: string): CloudProvider | undefined {
  return CLOUD_PROVIDERS.find(provider => provider.id === id);
}

/** Проверяет, что присланные поля — ровно те, что просит провайдер, и непустые. */
export function readCloudFields(provider: CloudProvider, input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) throw new Error("Ожидался объект с полями ключа");
  const values = input as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : "";
    if (!value) throw new Error("Заполните поле «" + field.label + "»");
    if (value.length > 8000) throw new Error("Поле «" + field.label + "» слишком длинное");
    fields[field.key] = value;
  }
  return fields;
}
