/**
 * Сеть в контейнере команды выключена по умолчанию (`SANDBOX_NETWORK=none`): скачивать пакеты
 * оттуда нельзя. Для агента это неочевидно — `npm install` в терминале выглядит как зависшая
 * установка, он повторяет её и ждёт таймаут, хотя нужный инструмент один: `npm.install`.
 * Поэтому отказ терминала превращается в объяснение, а не в молчаливый код выхода.
 */

/** Установка пакетов: это команды, которые без сети не работают в принципе. */
const PACKAGE_INSTALL =
  /^(?:sudo\s+)?(?:npm\s+(?:install|i|ci|add|update|exec)\b|npx\b|yarn(?:\s+(?:add|install)\b|\s*$)|pnpm\s+(?:install|i|add)\b|bun\s+(?:install|add)\b|pip3?\s+install\b|composer\s+(?:install|require)\b|poetry\s+add\b)/i;

/** Команды, которым нужен исходящий доступ, но которые не ставят зависимости. */
const NETWORK_UTILITY = /^(?:sudo\s+)?(?:curl|wget)\b|^git\s+(?:fetch|pull|push|clone|ls-remote)\b/i;

/** Как выглядит отказ из-за недоступной сети, а не из-за ошибки в проекте. */
const NETWORK_FAILURE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ERR_SOCKET_TIMEOUT)\b|getaddrinfo|Temporary failure in name resolution|Could not resolve host|Failed to fetch|socket hang up|request to .* failed/i;

export const PACKAGE_INSTALL_HINT =
  "Сеть в терминале выключена по умолчанию, поэтому `npm install` здесь не скачивает пакеты " +
  "(ENOTFOUND / EAI_AGAIN / таймаут). Это ограничение песочницы, а не ошибка проекта. " +
  "Установите зависимости через npm.install — это единственный инструмент с исходящим доступом; " +
  "preview.start тоже ставит их сам перед сборкой.";

export const NO_NETWORK_HINT =
  "Похоже, команде нужен интернет, а у терминала исходящая сеть выключена по умолчанию " +
  "(контейнер запускается с `--network none`). Это не ошибка проекта: пакеты ставит npm.install, " +
  "приложение запускает preview.start, а внешние запросы проверяются уже в работающем предпросмотре.";

/** Ставит ли команда пакеты: для неё подсказка конкретнее, чем «нужен интернет». */
export function isPackageInstall(command: string) {
  return PACKAGE_INSTALL.test(command.trim());
}

/** Нужен ли команде исходящий доступ вообще: установка, скачивание или сетевой git. */
export function commandNeedsNetwork(command: string) {
  const value = command.trim();
  return PACKAGE_INSTALL.test(value) || NETWORK_UTILITY.test(value);
}

/** Отказ похож на сетевой: имя не разрешилось, соединение не установилось, запрос не прошёл. */
export function isNetworkFailure(text: string) {
  return NETWORK_FAILURE.test(text);
}

/**
 * `hint` для результата команды: только когда команда действительно упала из-за сети. Ошибка
 * зависимостей (`ERESOLVE`), синтаксиса или теста подсказку не получает — иначе агент лечил бы
 * настоящую ошибку проекта выключенной сетью.
 */
export function networkHint(
  command: string,
  result: { ok: boolean; stdout: string; stderr: string },
): string | undefined {
  if (result.ok) return undefined;
  if (!isNetworkFailure(result.stdout + "\n" + result.stderr)) return undefined;
  return isPackageInstall(command) ? PACKAGE_INSTALL_HINT : NO_NETWORK_HINT;
}

/** То же для логов фонового задания: команда уже не связана с результатом, остаётся текст. */
export function networkHintForLogs(logs: string) {
  return isNetworkFailure(logs) ? NO_NETWORK_HINT : undefined;
}
