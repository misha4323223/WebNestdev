/**
 * Локальное зеркало реестра npm на каждой ноде.
 *
 * Зачем: установка зависимостей — единственный шаг платформы, который ходит в интернет.
 * Сеть и реестр — самая непредсказуемая часть времени первой сборки: медленный ответ,
 * обрыв, `EAI_AGAIN` на прокси превращаются в «предпросмотр не запускается». Зеркало
 * живёт на той же машине, что и песочница, и наполняется один раз; проекту остаётся
 * распаковать то, что уже лежит на диске.
 *
 * Почему не «общий кэш npm для всех проектов»: `npm_config_cache` требует записи
 * (`_cacache/tmp`, `index-v5`), а общий каталог, в который пишут все песочницы (uid 1000),
 * позволяет одному проекту подменить пакет другому. Здесь песочницы в зеркало только
 * читают по HTTP, пишет в него один доверенный процесс.
 *
 * Тарифная нейтральность: установка нужна на всех тарифах — сборка статики на «Старте»,
 * функции на «Плюсе», контейнерный предпросмотр на «Премиуме». Модуль ничего не знает
 * про тарифы и не может расширить возможности проекта: он меняет только адрес реестра.
 *
 * Отказ зеркала не должен ломать установку: если оно не задано или не отвечает, установка
 * идёт как раньше — в публичный реестр через egress-прокси. Оптимизация не имеет права
 * становиться причиной ошибки.
 */

/** Сколько ждём ответ на `/-/ping`, прежде чем считать зеркало недоступным. */
const PROBE_TIMEOUT_MS = 1_200;
/** Сколько доверяем удачному ответу; проверка идёт не чаще, чем на этом интервале. */
const HEALTHY_TTL_MS = 60_000;
/** Неудачу помним меньше, чтобы поднявшееся зеркало заработало само. */
const UNHEALTHY_TTL_MS = 15_000;

/** Адрес зеркала из окружения; `null` — зеркало не задано или адрес некорректен. */
export function npmRegistryUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.WEBNESTDEV_NPM_REGISTRY?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Хвостовой слеш ломает `npm_config_registry`: npm приклеивает путь к адресу как есть.
  return (parsed.origin + parsed.pathname).replace(/\/+$/, "");
}

type Health = { url: string; ok: boolean; at: number };
let health: Health | null = null;

/** Сбросить запомненное состояние проверки: нужно тестам и ручной диагностике. */
export function resetNpmRegistryHealth(): void {
  health = null;
}

export type RegistryProbe = (url: string, timeoutMs: number) => Promise<boolean>;

/** Жив ли реестр по адресу. `/-/ping` — конвенция зеркал; 404 тоже значит «жив». */
export async function probeNpmRegistry(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url + "/-/ping", { signal: controller.signal, redirect: "follow" });
    return response.ok || response.status === 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function npmRegistryReachable(
  url: string,
  options: { now?: number; probe?: RegistryProbe } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  if (health && health.url === url) {
    const ttl = health.ok ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS;
    if (now - health.at < ttl) return health.ok;
  }
  const probe = options.probe ?? probeNpmRegistry;
  const ok = await probe(url, PROBE_TIMEOUT_MS).catch(() => false);
  health = { url, ok, at: now };
  return ok;
}

/**
 * Переменные окружения для установки. Пустой объект — обычный путь через публичный реестр:
 * так выключенное или упавшее зеркало не меняет поведение платформы.
 */
export async function npmInstallEnv(
  options: { env?: NodeJS.ProcessEnv; now?: number; probe?: RegistryProbe } = {},
): Promise<Record<string, string>> {
  const url = npmRegistryUrl(options.env ?? process.env);
  if (!url) return {};
  if (!(await npmRegistryReachable(url, options))) return {};
  return { npm_config_registry: url };
}
