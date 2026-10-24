import { CLOUD_PROVIDERS } from "../cloud/providers.js";
import { DOMAIN_REGISTRARS } from "../domains/providers.js";
import { SERVICES } from "../services/catalog.js";
import type { AccessKind } from "./pending-access.js";

/**
 * Описание того, что именно просит агент: поля кабинета, шаги и ссылки. Каталоги уже знают
 * это для облаков, регистраторов и сервисов — здесь они приводятся к одной форме, чтобы
 * карточка в чате не зависела от того, какой провайдер попросили.
 */

export type AccessField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
  optional?: boolean;
};

export type AccessTarget = {
  kind: AccessKind;
  providerId: string;
  name: string;
  fields: AccessField[];
  steps: string[];
  keyUrl?: string;
  docsUrl?: string;
  verification: "check" | "store";
  verificationNote: string;
  /** Меняет ресурсы провайдера — значит, карточка спрашивает разрешение на изменения. */
  writes: boolean;
  /** Переменные проекта, которые появятся после подключения сервиса. */
  env?: string[];
};

function cloudTarget(id: string): AccessTarget {
  const provider = CLOUD_PROVIDERS.find(item => item.id === id);
  if (!provider) throw new Error("Неизвестное облако: " + id + ". Доступны: " + CLOUD_PROVIDERS.map(item => item.id).join(", ") + ". Для Yandex Cloud используйте kind 'yandex'.");
  return {
    kind: "cloud",
    providerId: provider.id,
    name: provider.name,
    fields: provider.fields.map(field => ({ ...field })),
    steps: provider.steps,
    keyUrl: provider.keyUrl,
    docsUrl: provider.docsUrl,
    verification: "check",
    verificationNote: "Ключ проверяется запросом к API провайдера до сохранения.",
    writes: true,
  };
}

function domainTarget(id: string): AccessTarget {
  const registrar = DOMAIN_REGISTRARS.find(item => item.id === id);
  if (!registrar) throw new Error("Неизвестный регистратор: " + id + ". Доступны: " + DOMAIN_REGISTRARS.map(item => item.id).join(", "));
  return {
    kind: "domain",
    providerId: registrar.id,
    name: registrar.name,
    fields: registrar.fields.map(field => ({ ...field })),
    steps: registrar.steps,
    keyUrl: registrar.keyUrl,
    docsUrl: registrar.docsUrl,
    verification: "check",
    verificationNote: "Доступ проверяется чтением списка доменов до сохранения.",
    writes: true,
  };
}

function serviceTarget(id: string): AccessTarget {
  const service = SERVICES.find(item => item.id === id);
  if (!service) throw new Error("Неизвестный сервис: " + id + ". Список доступных — в service.status.");
  return {
    kind: "service",
    providerId: service.id,
    name: service.name,
    fields: service.fields.map(field => ({ ...field })),
    steps: service.steps,
    keyUrl: service.keyUrl,
    docsUrl: service.docsUrl,
    verification: service.verification,
    verificationNote: service.verificationNote,
    writes: false,
    env: service.env.map(entry => entry.name),
  };
}

function databaseTarget(): AccessTarget {
  return {
    kind: "database",
    providerId: "database",
    name: "База данных",
    fields: [{ key: "url", label: "Строка подключения", placeholder: "postgresql://user:password@host:5432/database", secret: true }],
    steps: [
      "Откройте базу в кабинете провайдера (Yandex Cloud, Timeweb Cloud, VK Cloud, Selectel, Cloud.ru или другой).",
      "Скопируйте строку подключения вместе с логином и паролем.",
      "Вставьте её здесь — значение уйдёт в зашифрованное хранилище и будет доступно приложению как DATABASE_URL.",
    ],
    docsUrl: "https://yandex.cloud/ru/docs/managed-postgresql/operations/connect",
    verification: "store",
    verificationNote: "Строка подключения сохраняется без сетевой проверки: доступность базы зависит от её сети, а агент проверит это отдельно.",
    writes: false,
  };
}

function yandexTarget(): AccessTarget {
  return {
    kind: "yandex",
    providerId: "yandex",
    name: "Yandex Cloud",
    fields: [{ key: "secret", label: "Ключ сервисного аккаунта или токен", placeholder: "JSON authorized key целиком, IAM-токен (t1.…) или OAuth-токен (y0_…)", secret: true, multiline: true }],
    steps: [
      "Консоль Yandex Cloud → «Сервисные аккаунты»: аккаунт с нужными ролями (например, editor в каталоге).",
      "В аккаунте → «Создать новый ключ» → «Создать авторизованный ключ»: скачайте JSON-файл целиком.",
      "Вставьте JSON сюда — платформа проверит ключ и определит каталог, в котором будет работать агент.",
    ],
    keyUrl: "https://yandex.cloud/ru/docs/iam/operations/authentication/manage-authorized-keys",
    docsUrl: "https://yandex.cloud/ru/docs/iam/concepts/authorization/",
    verification: "check",
    verificationNote: "Ключ проверяется запросом к Yandex Cloud до сохранения; изменения разрешаются отдельным переключателем в карточке.",
    writes: true,
  };
}

export function resolveAccessTarget(kind: AccessKind, providerId: string): AccessTarget {
  if (kind === "cloud") return cloudTarget(providerId);
  if (kind === "domain") return domainTarget(providerId);
  if (kind === "service") return serviceTarget(providerId);
  if (kind === "database") return databaseTarget();
  if (kind === "yandex") return yandexTarget();
  throw new Error("Неизвестный тип доступа: " + String(kind));
}
