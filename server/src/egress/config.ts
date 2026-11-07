/**
 * Настройки фильтра исходящей сети для кода проекта (пункт 5.1 плана масштабирования).
 *
 * Зачем это вообще нужно. Контейнер проекта — это чужой код на нашей ВМ: он ставит пакеты,
 * ходит в API заказчика и, если ничего не ограничивать, может майнить, рассылать спам, атаковать
 * чужие адреса и обходить квоты — с нашего IP. Изоляция (gVisor) закрывает доступ к ядру, но не
 * сеть: это другой слой. Поэтому исходящий трафик идёт через прокси с allowlist, а прямой выход
 * закрывается правилами Docker на узле (deploy/scripts/vm-deploy.sh).
 *
 * Три режима:
 * - `off` — прокси не запускается, переменные в контейнеры не передаются (поведение до 5.1);
 * - `private-only` — разрешено всё публичное, запрещены приватные адреса и metadata-сервис. Это
 *   безопасный минимум и аварийный выключатель, если allowlist ломает нужный проект;
 * - `allowlist` — разрешены только перечисленные домены (по умолчанию: реестры пакетов, git-хостинги
 *   и типовые CDN).
 *
 * Опечатка в значении — ошибка, а не молчаливый возврат к `off`: иначе `EGRESS_MODE=allowlst`
 * выглядел бы как включённый фильтр, и о дыре узнали бы по счёту за трафик (так же устроен
 * SANDBOX_RUNTIME, см. sandbox/config.ts).
 */

export type EgressMode = "off" | "private-only" | "allowlist";

/**
 * Назначение токена для вопроса «чей это адрес» (routes/egress.ts).
 *
 * Живёт здесь, а не в proxy-main.ts: тот файл при импорте запускает процессы, и рождать его в
 * процессе API из-за одной строки было бы грубой ошибкой.
 */
export const EGRESS_WHOIS_PURPOSE = "egress-whois:v1";

const DEFAULT_PROXY_PORT = 3128;
const DEFAULT_HEALTH_PORT = 8790;

/** Порт и адрес, на которых слушает сам прокси внутри контейнера сервера. */
export function egressMode(env: NodeJS.ProcessEnv = process.env): EgressMode {
  const raw = (env.EGRESS_MODE ?? "").trim().toLowerCase();
  if (!raw) return (env.EGRESS_PROXY_ENABLED ?? "").trim() === "1" ? "allowlist" : "off";
  if (raw === "off" || raw === "0" || raw === "none") return "off";
  if (raw === "private-only") return "private-only";
  if (raw === "allowlist") return "allowlist";
  throw new Error('EGRESS_MODE="' + raw + '" не поддерживается: используйте off, private-only или allowlist');
}

export function egressProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return egressMode(env) !== "off";
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number((value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

export function egressProxyPort(env: NodeJS.ProcessEnv = process.env): number {
  return port(env.EGRESS_PROXY_PORT, DEFAULT_PROXY_PORT);
}

/** Health-слушатель прокси: только 127.0.0.1, наружу он не нужен (как у двери предпросмотра). */
export function egressHealthPort(env: NodeJS.ProcessEnv = process.env): number {
  return port(env.EGRESS_PROXY_HEALTH_PORT, DEFAULT_HEALTH_PORT);
}

/**
 * Адрес прокси, который получают контейнеры проектов.
 *
 * По умолчанию — имя сервиса в сети предпросмотра: прокси живёт третьим процессом в контейнере
 * сервера (как дверь в 6.1), поэтому адрес совпадает с адресом API, а имя резолвится встроенным
 * DNS Docker. `EGRESS_PROXY_URL` перекрывает его целиком — для нестандартной топологии.
 */
export function egressProxyUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.EGRESS_PROXY_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = (env.EGRESS_PROXY_HOST ?? "").trim() || "webnestdev-server";
  return "http://" + host + ":" + egressProxyPort(env);
}

/**
 * Переменные прокси для контейнера проекта. Пустой объект — фильтр выключен, контейнер видит
 * интернет напрямую, как раньше.
 *
 * `npm_config_*` дублируются намеренно: npm читает и обычные `HTTP(S)_PROXY`, но часть зависимостей
 * и часть версий CLI смотрят только на свои ключи, и тогда установка шла бы мимо прокси — то есть
 * падала бы на закрытом выходе с невнятной ошибкой соединения.
 */
export function egressProxyEnv(env: NodeJS.ProcessEnv = process.env, urlOverride?: string): Record<string, string> {
  if (!egressProxyEnabled(env)) return {};
  // Адрес по IP (egress/proxy-address.ts) приходит сюда: песочнице не нужно разрешать имя
  // сервиса, а именно этот запрос и падал с EAI_AGAIN в момент установки пакетов.
  const url = (urlOverride ?? "").trim() || egressProxyUrl(env);
  const local = "localhost,127.0.0.1,::1";
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: local,
    no_proxy: local,
    npm_config_proxy: url,
    npm_config_https_proxy: url,
  };
}

/** Строка для старта и health: что именно включено, чтобы это читалось из лога выкатки. */
export function describeEgress(env: NodeJS.ProcessEnv = process.env): string {
  const mode = egressMode(env);
  if (mode === "off") return "фильтр исходящей сети выключен (EGRESS_MODE=off)";
  const ports = String(egressProxyPort(env)) + "/" + String(egressHealthPort(env));
  const allowlist = mode === "allowlist" ? ", allowlist включён" : ", разрешено всё публичное";
  return "фильтр исходящей сети: " + mode + allowlist + ", прокси " + egressProxyUrl(env) + " (порты " + ports + ")";
}
