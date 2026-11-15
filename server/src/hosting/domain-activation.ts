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
  /** Для unit-тестов и предсказуемого порога показа ошибки. */
  now?: () => number;
};

const CANDIDATE_STATUSES = new Set<CustomDomain["status"]>(["configuring", "issuing_certificate"]);
/** Первые две минуты — штатное окно выпуска: панель не показывает ошибку как окончательную. */
export const CERTIFICATE_GRACE_MS = 120_000;
let inFlight: Promise<ActivationResult> | null = null;
let lastError = "";
/**
 * Номер попытки для лога. Хранится в памяти процесса: это диагностика, а не состояние домена;
 * после рестарта нумерация начинается заново, но hostname и причина остаются в каждой строке.
 */
const attempts = new Map<string, number>();

function liveSiteIds(sites: HostingSite[]): Set<string> {
  return new Set(sites
    .filter(site => site.status === "live" && Boolean(site.activeReleaseId))
    .map(site => site.id));
}

function nextAttempt(hostname: string): number {
  const attempt = (attempts.get(hostname) ?? 0) + 1;
  attempts.set(hostname, attempt);
  return attempt;
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
    const now = options.now ?? Date.now;
    let activated = 0;
    let failed = 0;

    for (const domain of candidates) {
      const startedAt = domain.certificateStartedAt ?? new Date(now()).toISOString();
      await updateDomain(domain.id, {
        status: "issuing_certificate",
        certificateStatus: "issuing",
        certificateError: "",
        certificateStartedAt: startedAt,
      }).catch(() => undefined);
      const attempt = nextAttempt(domain.hostname);
      const result = await probe(domain.hostname).catch(error => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (result.ok) {
        attempts.delete(domain.hostname);
        await updateDomain(domain.id, {
          status: "active",
          certificateStatus: "active",
          certificateError: "",
          certificateStartedAt: null,
        });
        activated++;
      } else {
        const reason = (result.error ?? "TLS-проверка не прошла").slice(0, 500);
        const elapsedMs = Math.max(0, now() - Date.parse(startedAt));
        console.warn(
          "[custom-domains] TLS-проба " + domain.hostname + ": попытка " + attempt +
            " не прошла: " + reason +
            (elapsedMs >= CERTIFICATE_GRACE_MS
              ? " (серия идёт " + Math.round(elapsedMs / 1000) + " с, панель покажет ошибку)"
              : " (штатное окно выпуска)"),
        );
        await updateDomain(domain.id, {
          status: "issuing_certificate",
          certificateStatus: "issuing",
          certificateError: reason,
          certificateStartedAt: startedAt,
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
