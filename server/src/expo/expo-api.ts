import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox, type SandboxRunOptions } from "../sandbox-worker.js";
import { getServiceConnection } from "../services/connections.js";
import { assertPublicUrl, requestPage } from "../web/read-url.js";

/**
 * EAS Build — единственная часть Expo, которая может работать из платформы: сборка идёт на
 * серверах Expo, а локально нужен только токен и проект. Expo Go (QR-превью) требует, чтобы
 * телефон достучался до dev-сервера, а у песочницы нет входящего адреса — поэтому его здесь нет.
 *
 * Токен не попадает ни в команду оболочки, ни в файл проекта: он уходит в окружение одного
 * контейнера через `env`. Наружу значения тоже не возвращаются — только подпись аккаунта.
 */

export const EXPO_SERVICE_ID = "expo";
export const EAS_CLI = "eas-cli@25.3.0";
const MAX_TOKEN_LENGTH = 2048;
const DEFAULT_BUILD_TIMEOUT_MS = 12 * 60_000;
const MAX_LOG_CHARS = 12_000;

export type ExpoConnection = {
  token: string;
  account: string;
  updatedAt: string;
};

export type ExpoProject = {
  directory: string;
  isExpo: boolean;
  hasEasJson: boolean;
  projectId: string;
  slug: string;
  owner: string;
  profiles: string[];
  appConfigFile: string | null;
};

export type EasBuild = {
  id: string;
  status?: string;
  platform?: string;
  buildProfile?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  distribution?: string;
  appIdentifier?: string;
  appVersion?: string;
  appBuildVersion?: string;
  error?: { errorCode?: string; message?: string; docsUrl?: string } | null;
  artifacts?: {
    buildUrl?: string | null;
    applicationArchiveUrl?: string | null;
    buildArtifactsUrl?: string | null;
    xcodeBuildLogsUrl?: string | null;
  } | null;
  logFiles?: string[];
  app?: {
    id?: string;
    name?: string;
    slug?: string;
    ownerAccount?: { id?: string; name?: string } | null;
  } | null;
  url?: string;
};

export type ExpoBuildSummary = ReturnType<typeof buildSummary>;

function tokenLooksValid(token: string) {
  return token.length >= 8 && token.length <= MAX_TOKEN_LENGTH && !/[\s\x00-\x1f\x7f]/.test(token);
}

/**
 * Подключение Expo лежит в том же зашифрованном хранилище интеграций, что и облака. Секрет
 * расшифровывается только на сервере и только на время вызова EAS.
 */
export async function getExpoConnection(userId: string): Promise<ExpoConnection | null> {
  const connection = await getServiceConnection(userId, EXPO_SERVICE_ID);
  if (!connection) return null;
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(connection.secret) as Record<string, unknown>;
  } catch {
    throw new Error("Сохранённый токен Expo повреждён: откройте «Интеграции» и подключите Expo заново");
  }
  const token = typeof fields.token === "string" ? fields.token.trim() : "";
  if (!tokenLooksValid(token)) {
    throw new Error("Сохранённый токен Expo пуст или содержит недопустимые символы: подключите Expo заново");
  }
  return { token, account: connection.account, updatedAt: connection.updatedAt };
}

export function redactExpoToken(text: string, token: string) {
  if (!token) return text;
  return text.split(token).join("[expo token]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Разбор app.json и статической части app.config.* без выполнения пользовательского кода. */
async function readConfig(directory: string) {
  const appJson = await readFile(path.join(directory, "app.json"), "utf8").catch(() => "");
  const appConfigJs = await readFile(path.join(directory, "app.config.js"), "utf8").catch(() => "");
  const appConfigTs = await readFile(path.join(directory, "app.config.ts"), "utf8").catch(() => "");
  const packageJson = await readFile(path.join(directory, "package.json"), "utf8").catch(() => "");
  const easJson = await readFile(path.join(directory, "eas.json"), "utf8").catch(() => "");

  let config: Record<string, unknown> | null = null;
  if (appJson) {
    try {
      const parsed = JSON.parse(appJson) as Record<string, unknown>;
      config = asRecord(parsed.expo) ?? parsed;
    } catch {
      config = null;
    }
  }

  const source = appConfigJs || appConfigTs;
  const dynamicProjectId = source.match(/projectId\s*:\s*["']([0-9a-fA-F-]{8,64})["']/)?.[1] ?? "";
  const dynamicSlug = source.match(/slug\s*:\s*["']([^"']{1,120})["']/)?.[1] ?? "";
  const dynamicOwner = source.match(/owner\s*:\s*["']([^"']{1,120})["']/)?.[1] ?? "";

  let packageExpo = false;
  try {
    const pkg = JSON.parse(packageJson) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    packageExpo = Boolean(pkg.dependencies?.expo || pkg.devDependencies?.expo);
  } catch {
    packageExpo = false;
  }

  let profiles: string[] = [];
  let hasEasJson = false;
  if (easJson) {
    try {
      const parsed = JSON.parse(easJson) as { build?: Record<string, unknown> };
      profiles = Object.keys(parsed.build ?? {});
      hasEasJson = true;
    } catch {
      hasEasJson = true;
    }
  }

  const extra = asRecord(config?.extra);
  const eas = asRecord(extra?.eas);
  return {
    config,
    packageExpo,
    projectId: asString(eas?.projectId) || dynamicProjectId,
    slug: asString(config?.slug) || dynamicSlug,
    owner: asString(config?.owner) || dynamicOwner,
    profiles,
    hasEasJson,
    appConfigFile: appJson ? "app.json" : appConfigTs ? "app.config.ts" : appConfigJs ? "app.config.js" : null,
  };
}

export async function inspectExpoProject(root: string, relativeCwd = ""): Promise<ExpoProject> {
  const directory = await resolveInsideSandbox(root, path.join(root, relativeCwd));
  const info = await readConfig(directory);
  return {
    directory,
    isExpo: info.packageExpo || Boolean(info.config) || Boolean(info.projectId),
    hasEasJson: info.hasEasJson,
    projectId: info.projectId,
    slug: info.slug,
    owner: info.owner,
    profiles: info.profiles,
    appConfigFile: info.appConfigFile,
  };
}

/** Команда без пользовательских аргументов: значения, которые ввёл человек, идут в env. */
export async function runEas(
  sandbox: SandboxConfig,
  cwd: string,
  token: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
) {
  const command = "npx --yes " + EAS_CLI + " " + args.join(" ");
  const options: SandboxRunOptions = {
    network: "bridge",
    maskSecretEnvFiles: true,
    timeoutMs,
    // Собираем текущее дерево, а не последний коммит: агент часто меняет файлы перед сборкой,
    // и «правильная» сборка старого коммита была бы худшим из возможных результатов.
    env: { EXPO_TOKEN: token, EAS_NO_VCS: "1", ...env },
  };
  const raw = await runInSandbox(sandbox, command, cwd, options);
  return {
    ...raw,
    stdout: redactExpoToken(raw.stdout, token),
    stderr: redactExpoToken(raw.stderr, token),
  };
}

/** JSON от eas-cli: иногда это один объект, иногда массив (--platform all). */
export function parseEasJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("EAS CLI не вернул JSON");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // В stdout могут попасть предупреждения npx; берём самый внешний JSON-фрагмент.
    const start = text.search(/[\[{]/);
    if (start < 0) throw new Error("EAS CLI вернул не JSON: " + text.slice(-400));
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end <= start) throw new Error("EAS CLI вернул не JSON: " + text.slice(-400));
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      throw new Error("EAS CLI вернул не JSON: " + text.slice(-400));
    }
  }
}

function buildUrl(build: EasBuild) {
  const id = asString(build.id);
  const owner = asString(build.app?.ownerAccount?.name);
  const slug = asString(build.app?.slug);
  if (id && owner && slug) {
    return "https://expo.dev/accounts/" + encodeURIComponent(owner) + "/projects/" + encodeURIComponent(slug) + "/builds/" + encodeURIComponent(id);
  }
  return id ? "https://expo.dev/builds/" + encodeURIComponent(id) : "";
}

export function firstBuild(value: unknown): EasBuild | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const build = asRecord(item);
      if (build && asString(build.id)) return build as unknown as EasBuild;
    }
    return null;
  }
  const build = asRecord(value);
  if (build && asString(build.id)) return build as unknown as EasBuild;
  // `eas init --json` и некоторые ошибки заворачивают результат в data/result.
  const nested = asRecord(build?.data) ?? asRecord(build?.result);
  if (nested && asString(nested.id)) return nested as unknown as EasBuild;
  return null;
}

export function allBuilds(value: unknown): EasBuild[] {
  const root = asRecord(value);
  const nested = Array.isArray(root?.builds) ? root.builds : Array.isArray(value) ? value : null;
  if (nested) return nested.flatMap(item => {
    const build = asRecord(item);
    return build && asString(build.id) ? [build as unknown as EasBuild] : [];
  });
  const one = firstBuild(value);
  return one ? [one] : [];
}

/**
 * Модель получает только то, что нужно для решения. Подписанные ссылки на артефакты и файлы лога
 * сюда намеренно не попадают: их можно скачать без токена, а ссылка на страницу сборки уже
 * открывает всё нужное в браузере. Файлы лога читает только сервер (readBuildLog).
 */
export function buildSummary(build: EasBuild) {
  return {
    id: build.id,
    status: build.status ?? null,
    platform: build.platform ?? null,
    profile: build.buildProfile ?? null,
    message: build.message ?? null,
    createdAt: build.createdAt ?? null,
    completedAt: build.completedAt ?? null,
    distribution: build.distribution ?? null,
    appIdentifier: build.appIdentifier ?? null,
    appVersion: build.appVersion ?? null,
    appBuildVersion: build.appBuildVersion ?? null,
    error: build.error ?? null,
    app: build.app ? { name: build.app.name ?? null, slug: build.app.slug ?? null, owner: build.app.ownerAccount?.name ?? null } : null,
    artifacts: {
      build: Boolean(build.artifacts?.buildUrl),
      applicationArchive: Boolean(build.artifacts?.applicationArchiveUrl),
      buildArtifacts: Boolean(build.artifacts?.buildArtifactsUrl),
    },
    url: buildUrl(build),
  };
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Хвост лога сборки. Ссылки приходят из доверенного ответа EAS, но адрес всё равно проверяется
 * на публичность: читать внутренние адреса по чужой ссылке сервер не должен.
 */
export async function readBuildLog(url: string, maxChars = MAX_LOG_CHARS) {
  let checked: Awaited<ReturnType<typeof assertPublicUrl>>;
  try {
    checked = await assertPublicUrl(url);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    // Тот же транспорт, что у `web.read`: соединение идёт на проверенный адрес, поэтому подмена
    // DNS между проверкой и запросом не работает, а редирект не уводит во внутреннюю сеть — его
    // здесь не проходят вовсе, а показывают как статус ответа.
    const response = await requestPage(checked.url, checked.addresses, controller.signal, { maxBytes: 2_000_000, keep: "tail" });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, text: "", truncated: false, error: "Лог ответил HTTP " + response.status };
    }
    const full = stripAnsi(response.body);
    const limit = Math.max(1000, Math.min(MAX_LOG_CHARS, maxChars));
    const truncated = full.length > limit;
    return {
      ok: true,
      status: response.status,
      text: truncated ? full.slice(-limit) : full,
      truncated,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      truncated: false,
      error: error instanceof Error && error.name === "AbortError" ? "Лог не ответил за 20 секунд" : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
