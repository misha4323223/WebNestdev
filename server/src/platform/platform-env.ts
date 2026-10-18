import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";
import { parseAuthorizedKeyJson, parseServiceAccountKey } from "../yandex/yandex-api.js";

/**
 * Platform keys — the credentials of the service itself (GitHub OAuth, Yandex Cloud, SMS, the
 * default AI model), as opposed to a project's own secrets. They are entered in the admin panel
 * instead of being set on the VM by hand, stored encrypted (the same AES-GCM store as every other
 * credential, see docs/SECRET_ENCRYPTION.md) and read through `getPlatformEnv`, which falls back to
 * the process environment: a value written in the panel wins, a deploy-time env var still works, and
 * a deployment that never opens the panel behaves exactly as before.
 */
export type PlatformEnvKind = "secret" | "json-key" | "value" | "url" | "path" | "flag";
export type PlatformEnvGroup = "github" | "yandex" | "sms" | "ai";

export type PlatformEnvEntry = {
  name: string;
  group: PlatformEnvGroup;
  label: string;
  hint: string;
  kind: PlatformEnvKind;
};

/**
 * What the panel can actually change. A key belongs here only when the server reads it through
 * `getPlatformEnv`, so the list is a promise: everything shown takes effect without a restart.
 */
export const PLATFORM_ENV_CATALOG: PlatformEnvEntry[] = [
  { name: "GITHUB_CLIENT_ID", group: "github", label: "Client ID", hint: "GitHub → Settings → Developer settings → OAuth Apps → ваше приложение. Client ID виден открыто.", kind: "value" },
  { name: "GITHUB_CLIENT_SECRET", group: "github", label: "Client Secret", hint: "Там же: «Generate a new client secret». Старый после этого перестаёт работать.", kind: "secret" },
  { name: "GITHUB_CALLBACK_URL", group: "github", label: "Callback URL", hint: "Необязательно: пустое поле — адрес берётся из домена панели (https://<домен>/api/github/callback).", kind: "url" },
  { name: "GITHUB_FRONTEND_URL", group: "github", label: "Адрес возврата", hint: "Необязательно: куда вернуть браузер после авторизации (по умолчанию — корень панели).", kind: "url" },

  { name: "YANDEX_CLIENT_ID", group: "yandex", label: "Yandex ID Client ID", hint: "Приложение в oauth.yandex.ru. Нужен для входа через Яндекс; ключ сервисного аккаунта работает и без него.", kind: "value" },
  { name: "YANDEX_CLIENT_SECRET", group: "yandex", label: "Yandex ID Client secret", hint: "Там же, в настройках приложения Yandex ID.", kind: "secret" },
  { name: "YANDEX_CALLBACK_URL", group: "yandex", label: "Redirect URI", hint: "Необязательно: по умолчанию https://<домен>/api/yandex/callback. Должен совпадать с Redirect URI в приложении Yandex ID.", kind: "url" },
  { name: "YANDEX_FRONTEND_URL", group: "yandex", label: "Адрес возврата", hint: "Необязательно: куда вернуть браузер после входа (по умолчанию — корень панели).", kind: "url" },
  { name: "YANDEX_OAUTH_SCOPE", group: "yandex", label: "OAuth scope", hint: "Необязательно и только для подключения Yandex Cloud. Вход через Яндекс ID не отправляет scope: он получает права, отмеченные в приложении («Доступ к данным»).", kind: "value" },
  { name: "YANDEX_CLOUD_ID", group: "yandex", label: "Cloud ID", hint: "b1g… из консоли Yandex Cloud — идентификатор облака.", kind: "value" },
  { name: "YANDEX_FOLDER_ID", group: "yandex", label: "Folder ID", hint: "b1g… каталога, в котором создан сервисный аккаунт Notification Service.", kind: "value" },
  { name: "YANDEX_SA_KEY", group: "yandex", label: "Ключ сервисного аккаунта (JSON)", hint: "Вставьте файл authorized key целиком. Многострочный JSON и скопированная одной строкой форма с \\n принимаются одинаково.", kind: "json-key" },
  { name: "YANDEX_SA_KEY_FILE", group: "yandex", label: "Путь к файлу ключа", hint: "Альтернатива вставке: путь внутри контейнера, например /var/lib/webnestdev/secrets/yandex-sa-key.json.", kind: "path" },
  { name: "YANDEX_NOTIFY_IAM_TOKEN", group: "yandex", label: "Готовый IAM-токен", hint: "Живёт около 12 часов: SMS идут, пока он свежий, потом перестают. Ключ сервисного аккаунта надёжнее и побеждает токен.", kind: "secret" },
  { name: "YANDEX_SMS_SENDER", group: "yandex", label: "Имя отправителя sms", hint: "Необязательно: по умолчанию общее имя cns.shared; своё имя работает после регистрации отправителя.", kind: "value" },
  { name: "YANDEX_NOTIFY_ENDPOINT", group: "yandex", label: "Endpoint CNS", hint: "Необязательно: https://notifications.yandexcloud.net/", kind: "url" },

  { name: "SMS_PROVIDER", group: "sms", label: "Провайдер SMS", hint: "Необязательно: yandex, smsru, smsc, exolve или smsaero. Пусто — берётся первый, у которого есть ключ.", kind: "value" },
  { name: "SMS_SENDER", group: "sms", label: "Имя отправителя", hint: "Необязательно: имя, зарегистрированное у провайдера.", kind: "value" },
  { name: "SMS_RU_API_ID", group: "sms", label: "SMS.RU API ID", hint: "Ключ из личного кабинета sms.ru.", kind: "secret" },
  { name: "SMSC_LOGIN", group: "sms", label: "SMSC логин", hint: "Логин из личного кабинета smsc.ru.", kind: "value" },
  { name: "SMSC_PASSWORD", group: "sms", label: "SMSC пароль", hint: "Пароль или API-ключ smsc.ru; работает только вместе с логином.", kind: "secret" },
  { name: "EXOLVE_API_KEY", group: "sms", label: "Exolve API-ключ", hint: "Ключ MTS Exolve.", kind: "secret" },
  { name: "SMSAERO_EMAIL", group: "sms", label: "SMS Aero email", hint: "Логин аккаунта SMS Aero.", kind: "value" },
  { name: "SMSAERO_API_KEY", group: "sms", label: "SMS Aero API-ключ", hint: "Ключ из личного кабинета SMS Aero.", kind: "secret" },
  { name: "WEBNESTDEV_SMS_TEST_MODE", group: "sms", label: "Тестовый режим", hint: "1 — коды пишутся в лог сервера и не отправляются. Пусто или 0 — обычная отправка.", kind: "flag" },

  { name: "PLATFORM_AI_BASE_URL", group: "ai", label: "AI Base URL", hint: "OpenAI-совместимый адрес модели платформы — то, чем пользуются проекты без своего провайдера.", kind: "url" },
  { name: "PLATFORM_AI_MODEL", group: "ai", label: "AI модель", hint: "Идентификатор модели для этого адреса.", kind: "value" },
  { name: "PLATFORM_AI_API_KEY", group: "ai", label: "AI ключ", hint: "Ключ провайдера модели платформы. Проекты со своим ключом его не используют.", kind: "secret" },
];

/** Names the deployment owns: they are read before the app starts or by compose, so the panel cannot apply them. */
const DEPLOY_ONLY = new Set([
  "NODE_ENV", "PORT", "WEBNESTDEV_STORAGE", "WEBNESTDEV_DATA_DIR", "DATABASE_URL", "POSTGRES_PASSWORD",
  "WEBNESTDEV_ENCRYPTION_KEY", "WEBNESTDEV_SECRETS_DIR", "SANDBOX_DIR", "WEBNESTDEV_SANDBOX_DIR",
  "WEBNESTDEV_ALLOWED_ORIGINS", "WEBNESTDEV_SITE_DOMAIN", "PREVIEW_PUBLIC_DOMAIN", "PREVIEW_TICKET_TTL_MS",
  "ACME_EMAIL", "WEBNESTDEV_IMAGE", "WEBNESTDEV_DEMO_USER", "WEBNESTDEV_DEMO_PHONE_ENABLED", "WEBNESTDEV_DEMO_PHONE",
  "WEBNESTDEV_ADMIN_EMAILS", "WEBNESTDEV_ADMIN_USER_IDS", "WEBNESTDEV_COOKIE_SECURE",
  "WEBNESTDEV_BROWSER_EXECUTABLE", "PLAYWRIGHT_BROWSERS_PATH", "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY",
]);

export type PlatformEnvSource = "panel" | "environment" | "none";
export type PlatformEnvStatus = {
  name: string;
  group: PlatformEnvGroup;
  label: string;
  hint: string;
  kind: PlatformEnvKind;
  source: PlatformEnvSource;
  /** Masked shape of the stored value ("sk-…f3a2", "строк: 23") or the plain value for non-secrets. */
  value?: string;
  updatedAt?: string;
};

type StoredEntry = { value: string; preview: string; updatedAt: string };
type StoreFile = { version: 1; values: Record<string, StoredEntry> };

const GROUP_LABEL: Record<PlatformEnvGroup, string> = { github: "GitHub", yandex: "Yandex Cloud", sms: "SMS-провайдеры", ai: "AI-провайдер платформы" };

export function platformEnvGroupLabel(group: PlatformEnvGroup) {
  return GROUP_LABEL[group];
}

let overrides = new Map<string, StoredEntry>();
let loaded = false;

function storeFile() {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "platform", "env.json");
}

function catalogEntry(name: string) {
  return PLATFORM_ENV_CATALOG.find(entry => entry.name === name);
}

/**
 * Значение для кода: сначала то, что записано в панели, потом переменная окружения. Разрешение
 * синхронное и из памяти: этими значениями пользуются и синхронные части (выбор SMS-провайдера),
 * поэтому файл читается один раз при старте, а запись обновляет кэш.
 */
export function getPlatformEnv(name: string): string | undefined {
  const stored = overrides.get(name)?.value;
  if (stored !== undefined) return stored;
  return process.env[name];
}

export function platformEnvSetByPanel(name: string) {
  return overrides.has(name);
}

/** Чтение шифрованного хранилища при старте. Ошибка ключа не роняет сервер: значения просто не применяются. */
export async function loadPlatformEnv() {
  loaded = true;
  overrides = new Map();
  let raw: string;
  try { raw = await readFile(storeFile(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[platform] не удалось прочитать хранилище ключей:", error);
    return;
  }
  let parsed: StoreFile;
  try { parsed = JSON.parse(raw) as StoreFile; }
  catch { console.error("[platform] хранилище ключей повреждено — значения панели не применены"); return; }
  for (const [name, entry] of Object.entries(parsed.values ?? {})) {
    if (!entry?.value) continue;
    try {
      overrides.set(name, { value: isEncryptedSecret(entry.value) ? decryptSecret(entry.value) : entry.value, preview: entry.preview ?? "", updatedAt: entry.updatedAt ?? "" });
    } catch (error) {
      console.error("[platform] ключ " + name + " не расшифрован (изменился WEBNESTDEV_ENCRYPTION_KEY?) — используется значение окружения:", error instanceof Error ? error.message : error);
    }
  }
  if (overrides.size) console.log("[platform] ключей из панели: " + overrides.size + " (" + [...overrides.keys()].sort().join(", ") + ")");
}

export function platformEnvLoaded() {
  return loaded;
}

async function writeStore(entries: Map<string, StoredEntry>) {
  const file = storeFile();
  await mkdir(path.dirname(file), { recursive: true });
  // На диск значения уходят только шифрованными: файл — такой же секрет, как хранилища
  // подключений, и открытый GITHUB_CLIENT_SECRET в нём был бы утечкой через бэкап.
  const payload: StoreFile = {
    version: 1,
    values: Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, { ...entry, value: encryptSecret(entry.value) }])),
  };
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

/**
 * Как показать значение в панели. Секреты и многострочные ключи — только формой: «sk-…f3a2» или
 * «строк: 23». Так видно, что ключ на месте и тот ли это файл, и ни одно значение не уезжает в
 * браузер целиком.
 */
export function previewOf(value: string) {
  const text = value.trim();
  const lines = text.split("\n").length;
  if (lines > 1) return "строк: " + lines;
  if (text.length > 12) return text.slice(0, 4) + "…" + text.slice(-4);
  return text.length ? String(text.length) + " симв." : "";
}

/** Переносы строк приводятся к \n, внешние пробелы и CRLF убираются: «неправильные переносы» — это они. */
export function normalizePastedValue(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

/** Проверка значения до записи: ошибка объясняет, что не так, вместо «сохранено, но не работает». */
export function validatePlatformValue(name: string, value: string): string | null {
  const entry = catalogEntry(name);
  if (!entry) return "Неизвестный ключ: " + name;
  const text = normalizePastedValue(value);
  if (!text) return null;
  if (entry.kind === "json-key") {
    try { parseServiceAccountKey(text); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  if (entry.kind === "url" && !/^https?:\/\/[^\s]+$/i.test(text)) return "Нужен адрес вида https://…";
  if (entry.kind === "path" && text.includes("\n")) return "Путь должен быть одной строкой";
  if (entry.kind === "flag" && !/^(0|1|true|false|yes|no|да|нет)$/i.test(text)) return "Допустимо: 1/0, true/false, yes/no";
  return null;
}

export type SkippedValue = { name: string; message: string };

/**
 * Запись значений из панели или из загруженного .env. Пустая строка удаляет значение панели и
 * возвращает ключ к переменной окружения — это и есть «вернуть как было» без правки .env на ВМ.
 *
 * Плохая строка не отменяет хорошие: загрузка целого .env применяет всё, что понимает, и
 * возвращает список пропущенного с причиной — иначе «загрузил файл, а половина не применилась»
 * выглядело бы как молчаливая потеря ключей.
 */
export async function savePlatformEnv(values: Record<string, string | undefined>) {
  const skipped: SkippedValue[] = [];
  const next = new Map(overrides);
  const saved: string[] = [];
  const cleared: string[] = [];
  for (const [rawName, rawValue] of Object.entries(values)) {
    const name = rawName.trim().toUpperCase();
    const entry = catalogEntry(name);
    if (!entry) { skipped.push({ name, message: DEPLOY_ONLY.has(name) ? "изменяется при выкладке (compose/окружение)" : "неизвестная переменная" }); continue; }
    const value = normalizePastedValue(rawValue ?? "");
    if (!value) {
      if (next.delete(name)) cleared.push(name);
      continue;
    }
    const problem = validatePlatformValue(name, value);
    if (problem) { skipped.push({ name, message: problem }); continue; }
    next.set(name, { value: entry.kind === "json-key" ? canonicalKeyJson(value) : value, preview: previewOf(value), updatedAt: new Date().toISOString() });
    saved.push(name);
  }
  if (saved.length || cleared.length) {
    await writeStore(next);
    overrides = next;
  }
  return { saved, cleared, skipped };
}

export function platformEnvStatus(): PlatformEnvStatus[] {
  return PLATFORM_ENV_CATALOG.map(entry => {
    const stored = overrides.get(entry.name);
    if (stored) {
      return {
        name: entry.name, group: entry.group, label: entry.label, hint: entry.hint, kind: entry.kind,
        source: "panel" as const,
        value: entry.kind === "secret" || entry.kind === "json-key" ? stored.preview : stored.value,
        updatedAt: stored.updatedAt,
      };
    }
    const fromEnvironment = process.env[entry.name];
    if (fromEnvironment?.trim()) {
      return {
        name: entry.name, group: entry.group, label: entry.label, hint: entry.hint, kind: entry.kind,
        source: "environment" as const,
        // Значение из окружения показывается формой даже у несекретных ключей: панель честно
        // говорит, что ключ задан при выкладке, а не выдаёт себя за источник значения.
        value: previewOf(fromEnvironment),
      };
    }
    return { name: entry.name, group: entry.group, label: entry.label, hint: entry.hint, kind: entry.kind, source: "none" as const };
  });
}

export type ParsedEnvLine = { name: string; value: string };

/**
 * Разбор .env, который человек получает от провайдера, а не пишет руками: допускаются `export`,
 * комментарии, одинарные и двойные кавычки, экранированные `\n` внутри кавычек и настоящие
 * многострочные значения в кавычках (ключ сервисного аккаунта, PEM).
 */
export function parseEnvFileContent(content: string) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const values: ParsedEnvLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    let raw = match[2];
    // Незакрытая кавычка означает, что значение продолжается на следующих строках: так выглядят
    // pretty-printed ключи и PEM, скопированные из файла целиком.
    if (raw[0] === '"' || raw[0] === "'") {
      while (!isClosedQuote(raw) && index + 1 < lines.length) { index += 1; raw += "\n" + lines[index]; }
    }
    values.push({ name: match[1], value: decodeEnvValue(raw) });
  }
  return values;
}

/** Кавычка считается закрытой, когда её парное число, а нечётных обратных слэшей перед ней нет. */
function isClosedQuote(value: string) {
  const quote = value[0];
  const text = value.trimEnd();
  return text.length > 1 && countUnescaped(text, quote) % 2 === 0;
}

function countUnescaped(value: string, char: string) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === char && !quoteIsEscaped(value, index)) count += 1;
  }
  return count;
}

function decodeEnvValue(raw: string) {
  const trimmed = raw.trim();
  const quoted = unquote(trimmed);
  if (quoted !== undefined) return quoted;
  // Незакавыченное значение: комментарий после него отбрасывается по dotenv.
  return stripComment(trimmed);
}

/**
 * Значение в кавычках. Закрывающая кавычка ищется так же, как .env читает dotenv: у одной
 * строки — первая неэкранированная, у многострочного значения — последняя (внутри pretty-printed
 * JSON таких кавычек много, и первая из них — не конец значения). Всё после неё — комментарий.
 */
function unquote(text: string) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = text.includes("\n") ? text.lastIndexOf(quote) : findClosingQuote(text, quote);
  if (end <= 0) return undefined;
  const inner = text.slice(1, end);
  if (quote === "'") return inner;
  return inner.replace(/\\(n|r|t|"|\\)/g, (_, code: string) => (code === "n" ? "\n" : code === "r" ? "\r" : code === "t" ? "\t" : code === '"' ? '"' : "\\"));
}

/** Кавычка закрывает значение, только если перед ней чётное число обратных слэшей. */
function quoteIsEscaped(text: string, index: number) {
  let slashes = 0;
  for (let back = index - 1; back >= 0 && text[back] === "\\"; back -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findClosingQuote(text: string, quote: string) {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === quote && !quoteIsEscaped(text, index)) return index;
  }
  return -1;
}

/** Комментарий — это `#` в начале строки или после пробела, а не внутри значения и не в кавычках. */
function stripComment(value: string) {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trim();
  }
  return value;
}

/**
 * Ключ сервисного аккаунта сохраняется в каноническом виде: той же формой, которую принимает
 * парсер, но с правильно экранированными переносами. Так «неправильные переносы» чинятся один раз
 * при сохранении, а не превращаются в JSON, который никто не может прочитать.
 */
function canonicalKeyJson(text: string) {
  try { return JSON.stringify(parseAuthorizedKeyJson(text), null, 2); }
  catch { return text; }
}

/** Что делать с именами, которые панель не применяет: так загруженный файл объясняется целиком. */
export function describeUnappliedName(name: string) {
  return DEPLOY_ONLY.has(name) ? "изменяется при выкладке (compose/окружение)" : "неизвестная переменная";
}

export function isDeployOnlyName(name: string) {
  return DEPLOY_ONLY.has(name);
}
