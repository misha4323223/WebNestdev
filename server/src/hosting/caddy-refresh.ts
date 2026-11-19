import path from "node:path";
import { renderCustomDomainsCaddy } from "./caddy-config.js";
import {
  writeCustomDomainsCaddy,
  writeHostingModesCaddy,
  writeHostingRedirectsCaddy,
  customDomainsCaddyPath,
  hostingModesCaddyPath,
  hostingRedirectsCaddyPath,
} from "./caddy-config-writer.js";
import { buildHostingModeRoutes, renderHostingModesCaddy } from "./caddy-modes.js";
import { buildCustomDomainRoutes } from "./caddy-routes.js";
import { hostingPublicDomain, hostingSiteUrl } from "./config.js";
import { listAllDomains } from "./domain-store.js";
import { hostingCurrentLink } from "./paths.js";
import { readRedirectsFromRelease, renderRedirectsCaddy, type HostingRedirectRule } from "./seo/redirects.js";
import { readSeoSettings, type HostingSeoSettings } from "./seo/settings.js";
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
  modesFile: string;
  modesChanged: boolean;
  modes: number;
  redirectsFile: string;
  redirectsChanged: boolean;
  redirects: number;
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
    // `_redirects` и политика слеша живут в каталоге сайта. Читаем их перед генерацией:
    // Caddy не умеет разбирать пользовательский файл, а хранить копию в БД — значит
    // рассинхронизировать её с релизом при rollback.
    const seoSettings = new Map<string, HostingSeoSettings>();
    const redirectsBySite = new Map<string, readonly HostingRedirectRule[]>();
    await Promise.all(sites.map(async site => {
      const mode = site.effectiveRoutingMode ?? "spa";
      const settings = await readSeoSettings(site.slug, mode);
      seoSettings.set(site.id, settings);
      if (site.status !== "live" || !site.activeReleaseId) return;
      const redirects = await readRedirectsFromRelease(path.join(hostingCurrentLink(site.slug)));
      if (redirects.rules.length) redirectsBySite.set(site.id, redirects.rules);
    }));
    const routes = buildCustomDomainRoutes({ domains, sites, seoSettings, redirectsBySite });
    const content = renderCustomDomainsCaddy(routes);
    const written = await writeCustomDomainsCaddy(content);
    const modeRoutes = buildHostingModeRoutes({ sites, domains, publicDomain: hostingPublicDomain(), seoSettings });
    const modesContent = renderHostingModesCaddy(modeRoutes);
    const modesWritten = await writeHostingModesCaddy(modesContent);
    const platformRedirects = sites
      .filter(site => site.status === "live" && site.activeReleaseId)
      .map(site => ({
        hostname: hostingSiteUrl(site.slug, hostingPublicDomain()).replace(/^https:\/\//, ""),
        rules: redirectsBySite.get(site.id) ?? [],
      }))
      .filter(route => route.rules.length > 0);
    const redirectsContent = renderRedirectsCaddy(platformRedirects);
    const redirectsWritten = await writeHostingRedirectsCaddy(redirectsContent);
    const result = {
      ...written,
      routes: routes.length,
      modesFile: modesWritten.file,
      modesChanged: modesWritten.changed,
      modes: modeRoutes.length,
      redirectsFile: redirectsWritten.file,
      redirectsChanged: redirectsWritten.changed,
      redirects: platformRedirects.reduce((sum, route) => sum + route.rules.length, 0),
    };
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
    (lastResult
      ? "; маршрутов " + lastResult.routes +
        "; режимов " + lastResult.modes +
        "; " + lastResult.sha256.slice(0, 12)
      : "") +
    "; modes: " + hostingModesCaddyPath() +
    "; redirects: " + hostingRedirectsCaddyPath() +
    (lastResult ? " (" + lastResult.redirects + ")" : "");
}
