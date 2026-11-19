import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostingSeoDir } from "../paths.js";
import type { HostingResolvedMode } from "../types.js";

/**
 * Настройки SEO живут рядом с overlay, а не внутри релиза: они принадлежат сайту и должны
 * переживать публикацию и rollback. Caddy читает их при генерации конфига; сам файл не
 * отдаётся Caddy как файл сайта — Caddy открывает только явно перечисленные overlay-файлы.
 */

export type HostingTrailingSlash = "always" | "never" | "ignore";

export type HostingSeoSettings = {
  trailingSlash: HostingTrailingSlash;
  /** HTML-файл подтверждения Google Search Console, если пользователь его включил. */
  googleVerification?: string;
  /** Необязательный токен Яндекс.Вебмастера для будущей проверки. */
  yandexVerification?: string;
};

export const DEFAULT_SEO_SETTINGS: HostingSeoSettings = {
  trailingSlash: "ignore",
};

const SETTINGS_FILE = "settings.json";
const MAX_GOOGLE_TOKEN = 128;
const MAX_YANDEX_TOKEN = 128;

export function seoSettingsPath(slug: string) {
  return path.join(hostingSeoDir(slug), SETTINGS_FILE);
}

export function defaultTrailingSlash(mode: HostingResolvedMode): HostingTrailingSlash {
  // Статика и hybrid имеют реальные index.html в каталогах, поэтому `/about/` — естественный
  // канонический адрес. SPA не имеет файлов на маршрутах клиента, и принудительный слеш менял
  // бы адрес приложения без пользы; для неё политика по умолчанию — не вмешиваться.
  return mode === "spa" ? "ignore" : "always";
}

export function normalizeTrailingSlash(value: unknown, mode: HostingResolvedMode = "spa"): HostingTrailingSlash {
  return value === "always" || value === "never" || value === "ignore"
    ? value
    : defaultTrailingSlash(mode);
}

function normalizeToken(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  // Google принимает имя файла вида google<hex>.html; не даём записать путь или HTML.
  if (!token || token.length > max || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  return token;
}

export function normalizeSeoSettings(value: unknown, mode: HostingResolvedMode = "spa"): HostingSeoSettings {
  if (!value || typeof value !== "object") return { trailingSlash: defaultTrailingSlash(mode) };
  const raw = value as Record<string, unknown>;
  return {
    trailingSlash: normalizeTrailingSlash(raw.trailingSlash, mode),
    ...(normalizeToken(raw.googleVerification, MAX_GOOGLE_TOKEN)
      ? { googleVerification: normalizeToken(raw.googleVerification, MAX_GOOGLE_TOKEN) }
      : {}),
    ...(normalizeToken(raw.yandexVerification, MAX_YANDEX_TOKEN)
      ? { yandexVerification: normalizeToken(raw.yandexVerification, MAX_YANDEX_TOKEN) }
      : {}),
  };
}

export async function readSeoSettings(slug: string, mode: HostingResolvedMode = "spa"): Promise<HostingSeoSettings> {
  try {
    const parsed = JSON.parse(await readFile(seoSettingsPath(slug), "utf8")) as unknown;
    return normalizeSeoSettings(parsed, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { trailingSlash: defaultTrailingSlash(mode) };
    }
    return { trailingSlash: defaultTrailingSlash(mode) };
  }
}

export async function writeSeoSettings(slug: string, settings: HostingSeoSettings): Promise<HostingSeoSettings> {
  const normalized = normalizeSeoSettings(settings);
  const dir = hostingSeoDir(slug);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, SETTINGS_FILE);
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(normalized), { encoding: "utf8", mode: 0o644 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return normalized;
}

/** Google проверяет HTML-файл с точным именем `google<token>.html`. */
export function googleVerificationFile(token: string) {
  return "google" + token + ".html";
}

export function googleVerificationBody(token: string) {
  return "google-site-verification: " + googleVerificationFile(token) + "\n";
}
