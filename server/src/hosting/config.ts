import path from "node:path";
import { nodeId } from "../nodes/identity.js";
import type { HostingConfig, HostingLimits } from "./types.js";

/**
 * Конфигурация хостинга читается из окружения при каждом вызове, как остальные
 * возможности платформы. Это важно для тестов и для того, чтобы выключить новые публикации
 * без пересборки образа.
 *
 * `HOSTING_ENABLED=0` не выключает Caddy: уже опубликованные сайты продолжают отдаваться,
 * иначе флаг стал бы способом уронить весь хостинг. Он запрещает только новые публикации,
 * изменение сайта из панели и регистрацию новых сайтов.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function numberEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function boolEnv(name: string) {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Домен, под которым живут сайты. Он не должен быть тем же registrable domain, что панель:
 * иначе пользовательский JavaScript на поддомене сможет ставить parent-cookie и влиять на
 * сессию панели. Проверка здесь не даёт случайно выкатить небезопасный вариант, но окончательное
 * решение — отдельный домен, а не только валидация.
 */
export function hostingPublicDomain(value = process.env.HOSTING_PUBLIC_DOMAIN ?? "host.nestdev.ru") {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.includes(":") || domain.includes("/") || domain.includes("*")) {
    throw new Error("HOSTING_PUBLIC_DOMAIN должен быть DNS-именем без схемы, порта и wildcard");
  }
  if (domain.length > 253) throw new Error("HOSTING_PUBLIC_DOMAIN длиннее 253 символов");
  const labels = domain.split(".");
  // Caddy берёт slug из `{http.request.host.labels.3}`. Для другого числа меток индекс
  // пришлось бы пересчитывать и синхронно менять Caddyfile; поэтому здесь фиксируем
  // ровно три метки, как в плане, а не оставляем ошибку на прод.
  if (labels.length !== 3) throw new Error("HOSTING_PUBLIC_DOMAIN должен содержать ровно три метки (host.example.ru)");
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error("HOSTING_PUBLIC_DOMAIN содержит некорректную DNS-метку");
    }
  }
  return domain;
}

/**
 * Префикс ключей хостинга внутри бакета `PLATFORM_S3_*`. Не `PLATFORM_S3_PREFIX`: тот
 * отделяет данные платформы от чужих объектов, а этот — релизы сайтов от архивов проектов.
 * Сегменты проверяются как сегменты ключа: `..` в префиксе означал бы запись вне своего места.
 */
export function hostingBucketPrefix(value = process.env.HOSTING_S3_PREFIX ?? "hosting") {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("HOSTING_S3_PREFIX не может быть пустым");
  for (const part of prefix.split("/")) {
    if (!part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part)) {
      throw new Error("HOSTING_S3_PREFIX содержит недопустимый сегмент: " + prefix);
    }
  }
  return prefix;
}

/**
 * auto — включать бакет, когда заданы `PLATFORM_S3_*`; 0 — всегда диск; 1 — требовать бакет.
 * Так пилот не начинает зависеть от S3 только потому, что бакет настроен для холодного яруса,
 * но и не требует второй переменной на каждом стенде.
 */
export function hostingBucketMode(value = process.env.HOSTING_S3_ENABLED ?? "auto") {
  const mode = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(mode)) return "off" as const;
  if (["1", "true", "on", "yes"].includes(mode)) return "on" as const;
  return "auto" as const;
}

export function hostingSitesDir(value = process.env.WEBNESTDEV_SITES_DIR ?? process.env.SITES_DIR ?? "/srv/sites") {
  const dir = path.resolve(value);
  if (dir === path.parse(dir).root) {
    throw new Error("WEBNESTDEV_SITES_DIR не может быть корнем файловой системы");
  }
  return dir;
}

function assertNotInside(child: string, parent: string, message: string) {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(message);
  }
}

/**
 * `SITES_DIR` обязан быть отдельным каталогом. Если он окажется внутри data, Caddy сможет
 * прочитать секреты платформы через обычный `file_server`; если data окажется внутри него,
 * резервное копирование и очистка сайтов могут затронуть аккаунты и ключи.
 */
export function assertSitesDirSeparate(sitesDir: string, dataDir = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev")) {
  const sites = path.resolve(sitesDir);
  const data = path.resolve(dataDir);
  assertNotInside(sites, data, "WEBNESTDEV_SITES_DIR не должен находиться внутри WEBNESTDEV_DATA_DIR");
  assertNotInside(data, sites, "WEBNESTDEV_DATA_DIR не должен находиться внутри WEBNESTDEV_SITES_DIR");
}

export function hostingLimits(): HostingLimits {
  return {
    maxReleaseBytes: numberEnv("HOSTING_MAX_RELEASE_BYTES", 50 * MIB, 1, 2 * GIB),
    maxFileBytes: numberEnv("HOSTING_MAX_FILE_BYTES", 25 * MIB, 1, 2 * GIB),
    maxFiles: numberEnv("HOSTING_MAX_FILES", 5_000, 1, 100_000),
    keepReleases: numberEnv("HOSTING_KEEP_RELEASES", 3, 2, 20),
    buildTimeoutMs: numberEnv("HOSTING_BUILD_TIMEOUT_MS", 600_000, 10_000, 30 * 60_000),
    maxReleaseSeconds: numberEnv("HOSTING_MAX_RELEASE_SECONDS", 600, 10, 3_600),
    buildConcurrency: numberEnv("HOSTING_BUILD_CONCURRENCY", 1, 1, 16),
    globalBytes: numberEnv("HOSTING_GLOBAL_BYTES", 15 * GIB, 1, 10_000 * GIB),
    minFreeBytes: numberEnv("HOSTING_MIN_FREE_BYTES", 5 * GIB, 0, 1_000 * GIB),
    maxSites: numberEnv("HOSTING_MAX_SITES", 0, 0, 1_000_000),
  };
}

export function hostingConfig(): HostingConfig {
  const tls = (process.env.HOSTING_TLS_MODE ?? "on_demand").trim().toLowerCase();
  return {
    enabled: boolEnv("HOSTING_ENABLED"),
    publicDomain: hostingPublicDomain(),
    tlsMode: tls === "wildcard" ? "wildcard" : "on_demand",
    sitesDir: hostingSitesDir(),
    nodeId: nodeId(),
    sharedStorage: boolEnv("HOSTING_SHARED_STORAGE"),
    limits: hostingLimits(),
  };
}

export function hostingSiteUrl(slug: string, domain = hostingPublicDomain()) {
  return "https://" + slug + "." + domain;
}

/** Одна строка для старта: видно, включён ли хостинг и где лежат релизы. */
export function describeHosting(config = hostingConfig()) {
  const limits = config.limits;
  return (
    "hosting: " +
    (config.enabled ? "включён" : "выключен (опубликованные сайты Caddy продолжает отдавать)") +
    "; домен " +
    config.publicDomain +
    "; TLS " +
    config.tlsMode +
    "; SITES_DIR " +
    config.sitesDir +
    "; узел " +
    config.nodeId +
    (config.sharedStorage ? "; общий SITES_DIR" : "") +
    "; бакет " +
    hostingBucketMode() +
    (hostingBucketMode() === "off" ? "" : " (" + hostingBucketPrefix() + ")") +
    "; релиз " +
    Math.round(limits.maxReleaseBytes / MIB) +
    " МиБ / " +
    limits.maxFiles +
    " файлов / " +
    limits.keepReleases +
    " версии"
  );
}
