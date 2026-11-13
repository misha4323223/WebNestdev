import { renderCustomDomainsCaddy } from "./caddy-config.js";
import { writeCustomDomainsCaddy, customDomainsCaddyPath } from "./caddy-config-writer.js";
import { buildCustomDomainRoutes } from "./caddy-routes.js";
import { listAllDomains } from "./domain-store.js";
import { listSitesForRouting } from "./site-store.js";

/**
 * Пересборка файла custom domains.
 *
 * Запускается после изменений домена и раз в 30 секунд: публикация, снятие сайта и перенос
 * владельца меняют маршруты, но не проходят через доменный API. Периодический проход также
 * подхватывает изменения, сделанные другой репликой API.
 *
 * Один процесс не должен запускать две записи одновременно: иначе более старый снимок мог
 * бы перезаписать более новый. В пределах процесса запросы объединяются.
 */

export type CustomDomainCaddyRefresh = {
  file: string;
  changed: boolean;
  sha256: string;
  routes: number;
};

let inFlight: Promise<CustomDomainCaddyRefresh> | null = null;
let lastResult: CustomDomainCaddyRefresh | null = null;
let lastError = "";

export async function refreshCustomDomainsCaddy(): Promise<CustomDomainCaddyRefresh> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const [domains, sites] = await Promise.all([
      listAllDomains(),
      listSitesForRouting(),
    ]);
    const routes = buildCustomDomainRoutes({ domains, sites });
    const content = renderCustomDomainsCaddy(routes);
    const written = await writeCustomDomainsCaddy(content);
    const result = { ...written, routes: routes.length };
    lastResult = result;
    lastError = "";
    return result;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Не бросает в обработчик запроса: маршрут уже сохранён, конфиг догонит следующий проход. */
export function requestCustomDomainCaddyRefresh(reason = ""): void {
  void refreshCustomDomainsCaddy().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    // Одинаковая ошибка (например, каталог ещё не смонтирован) не должна заполнять журнал
    // каждые 30 секунд. Новый текст ошибки печатается сразу.
    if (message !== lastError) {
      lastError = message;
      console.warn("[custom-domains] caddy config refresh skipped" + (reason ? " (" + reason + ")" : "") + ": " + message);
    }
  });
}

export function lastCustomDomainCaddyRefresh(): CustomDomainCaddyRefresh | null {
  return lastResult;
}

/** Возвращает остановку таймера; вызывается из onClose сервера. */
export function startCustomDomainCaddyRefresh(): () => void {
  requestCustomDomainCaddyRefresh("startup");
  const configured = Number(process.env.CUSTOM_DOMAINS_CADDY_REFRESH_MS ?? 30_000);
  const every = Number.isFinite(configured) && configured >= 5_000 ? configured : 30_000;
  const timer = setInterval(() => requestCustomDomainCaddyRefresh("scheduled"), every);
  timer.unref();
  return () => clearInterval(timer);
}

export function describeCustomDomainCaddy(): string {
  return "custom domains: " + customDomainsCaddyPath() +
    (lastResult ? "; маршрутов " + lastResult.routes + "; " + lastResult.sha256.slice(0, 12) : "");
}
