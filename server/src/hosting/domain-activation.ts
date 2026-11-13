import { listAllDomains, updateDomain } from "./domain-store.js";
import { probeCustomDomainTls, type TlsProbe } from "./domain-tls.js";
import { listSitesForRouting } from "./site-store.js";
import type { CustomDomain } from "./domain-types.js";
import type { HostingSite } from "./types.js";

/**
 * Доводит домен до `active` после реального TLS-рукопожатия через NLB.
 *
 * Caddy не умеет сообщать в API «сертификат выпущен»: `/api/tls-ask` только разрешает выпуск.
 * Поэтому активация — отдельная проверка с SNI пользовательского имени. Ошибка не переводит
 * домен в окончательный `error`: Let's Encrypt/Caddy могут быть временно недоступны, и
 * следующий проход повторит попытку. В `certificate_error` остаётся последняя причина.
 */

export type ActivationResult = {
  checked: number;
  activated: number;
  failed: number;
};

export type ActivationOptions = {
  probe?: TlsProbe;
};

const CANDIDATE_STATUSES = new Set<CustomDomain["status"]>(["configuring", "issuing_certificate"]);
let inFlight: Promise<ActivationResult> | null = null;
let lastError = "";

function liveSiteIds(sites: HostingSite[]): Set<string> {
  return new Set(sites
    .filter(site => site.status === "live" && Boolean(site.activeReleaseId))
    .map(site => site.id));
}

export async function activateCustomDomains(options: ActivationOptions = {}): Promise<ActivationResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const [domains, sites] = await Promise.all([
      listAllDomains(),
      listSitesForRouting(),
    ]);
    const live = liveSiteIds(sites);
    const candidates = domains.filter(domain => CANDIDATE_STATUSES.has(domain.status) && live.has(domain.siteId));
    const probe = options.probe ?? probeCustomDomainTls;
    let activated = 0;
    let failed = 0;

    for (const domain of candidates) {
      await updateDomain(domain.id, {
        status: "issuing_certificate",
        certificateStatus: "issuing",
        certificateError: "",
      }).catch(() => undefined);
      const result = await probe(domain.hostname).catch(error => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (result.ok) {
        await updateDomain(domain.id, {
          status: "active",
          certificateStatus: "active",
          certificateError: "",
        });
        activated++;
      } else {
        const reason = (result.error ?? "TLS-проверка не прошла").slice(0, 500);
        await updateDomain(domain.id, {
          certificateStatus: "issuing",
          certificateError: reason,
        });
        failed++;
      }
    }
    lastError = "";
    return { checked: candidates.length, activated, failed };
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export function requestCustomDomainActivation(reason = ""): void {
  void activateCustomDomains().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) {
      lastError = message;
      console.warn("[custom-domains] TLS activation skipped" + (reason ? " (" + reason + ")" : "") + ": " + message);
    }
  });
}

/** Возвращает остановку таймера; первый проход отложен, пока Caddy применит новый конфиг. */
export function startCustomDomainTlsActivation(): () => void {
  const first = setTimeout(() => requestCustomDomainActivation("startup"), 15_000);
  first.unref();
  const every = setInterval(() => requestCustomDomainActivation("scheduled"), 60_000);
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
