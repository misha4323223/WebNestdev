import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from "node:tls";
import { isIP } from "node:net";
import { assertPublicUrl, WebReadError } from "../web/read-url.js";
import { registerTool } from "../tool-registry.js";

/**
 * Живая проверка после развёртывания.
 *
 * `deploy.status` читает план, `domain.check` смотрит регистрацию, `project.verify` — локальный
 * предпросмотр. Ни один из них не отвечает на вопрос «сайт по публичному адресу уже работает?».
 * После DNS, reverse proxy и сертификата остаётся ровно этот шаг, и без него агент объявляет
 * деплой готовым по зелёному шагу плана.
 *
 * Проверка идёт через тот же фильтр адресов, что `web.read`: только http(s), только порты 80/443,
 * только публичные адреса. Это не полноценный браузер — статус, цепочка редиректов, сертификат,
 * HSTS и www/апекс; содержимое страницы здесь не нужно.
 */

const HTTP_TIMEOUT_MS = 10_000;
const TLS_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type TlsInfo = {
  ok: boolean;
  trusted: boolean;
  hostnameValid: boolean;
  issuer: string;
  subject: string;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  error: string | null;
};

type Hop = { url: string; status: number; location: string | null };

export type WwwInfo = {
  url: string;
  status?: number;
  finalUrl?: string;
  redirectsTo?: "apex" | "www" | "other" | null;
  error?: string;
};

/** Приводит ввод к HTTPS: проверяется именно защищённый адрес, а не то, что открыл пользователь. */
export function normalizeSiteUrl(raw: string): URL {
  const value = raw.trim();
  if (!value) throw new Error("Укажите адрес сайта, например https://example.ru");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : "https://" + value;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Это не адрес сайта: " + value.slice(0, 120));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Проверяются только http и https, а не " + url.protocol);
  }
  // Даже если пользователь дал http, проверяем HTTPS: смысл шага — работает ли защищённый сайт.
  if (url.protocol === "http:" && url.port === "80") url.port = "";
  url.protocol = "https:";
  url.hash = "";
  return url;
}

/** Куда пришёл второй адрес: остался собой, перешёл на входной хост или ушёл на третий. */
export function redirectDirection(inputHost: string, otherHost: string, finalHost: string): "apex" | "www" | "other" | null {
  if (finalHost === otherHost) return null;
  if (finalHost === inputHost) return inputHost.startsWith("www.") ? "www" : "apex";
  return "other";
}

export function deployCheckSummary(input: { status: number; secure: boolean; tls: TlsInfo; www?: WwwInfo | null }) {
  const parts = ["HTTPS отвечает " + input.status];
  if (!input.secure) parts.push("в цепочке есть редирект на http");
  if (input.tls.ok) {
    parts.push("сертификат " + input.tls.issuer + " до " + dateLabel(input.tls.validTo) +
      (input.tls.daysLeft === null ? "" : " (ещё " + Math.max(0, input.tls.daysLeft) + " дн.)"));
  } else {
    parts.push("сертификат: " + (input.tls.error ?? "проверка не прошла"));
  }
  if (input.www) {
    if (input.www.error) parts.push("www: " + input.www.error);
    else if (input.www.redirectsTo === "apex") parts.push("www → апекс");
    else if (input.www.redirectsTo === "www") parts.push("апекс → www");
    else if (input.www.redirectsTo === "other") parts.push("www ведёт на " + (input.www.finalUrl ?? "другой адрес"));
  }
  return parts.join("; ");
}

registerTool({
  name: "deploy.check",
  description:
    "Check a deployed public site over HTTPS — the step after DNS, a reverse proxy or a certificate is set up. Input: {url:string}, a domain or full URL. " +
    "Returns the final HTTP status and redirect chain, the TLS certificate (issuer, validity, days left, trust and hostname match), HSTS, and whether www and the apex redirect to each other. " +
    "Use it after deploy.plan steps are marked done, when the user asks whether the site is live or HTTPS works, and before claiming that a deployment is reachable. " +
    "Only public http(s) hosts on ports 80/443 are checked; the page body is not read.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "Домен или адрес, например example.ru или https://example.ru/about" },
    },
  },
  execute: async (input) => {
    const raw = typeof (input as { url?: unknown } | null)?.url === "string" ? (input as { url: string }).url : "";
    try {
      const url = normalizeSiteUrl(raw);
      const checked = await assertPublicUrl(url.href);
      const target = checked.url;
      const chain = await fetchChain(target);
      const tls = await readCertificate(target.hostname, checked.addresses);
      const www = await checkWww(target);
      const ok = tls.ok && chain.status >= 200 && chain.status < 400 && chain.secure;
      const summary = deployCheckSummary({ status: chain.status, secure: chain.secure, tls, www });
      return {
        ok,
        url: target.href,
        status: chain.status,
        finalUrl: chain.finalUrl.href,
        secure: chain.secure,
        redirects: chain.hops,
        hsts: chain.hsts,
        tls,
        ...(www ? { www } : {}),
        summary,
        nextAction: ok
          ? "Сайт отвечает по HTTPS. Если это первый деплой, проверьте один внутренний маршрут и форму, которая действительно отправляет данные."
          : "Проверьте DNS (A/AAAA), reverse proxy на 443 и выпуск сертификата; после исправления повторите deploy.check.",
      };
    } catch (error) {
      const reason = error instanceof WebReadError
        ? { code: error.code, error: error.message }
        : { code: "unavailable", error: error instanceof Error ? error.message : String(error) };
      return {
        ok: false,
        url: raw,
        ...reason,
        nextAction: "Проверьте адрес, DNS и доступность сайта снаружи; после исправления повторите deploy.check.",
      };
    }
  },
});

async function fetchChain(start: URL) {
  let current = start;
  const hops: Hop[] = [];
  for (let index = 0; index <= MAX_REDIRECTS; index++) {
    const checked = await assertPublicUrl(current.href);
    current = checked.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
        signal: controller.signal,
      });
      const rawLocation = response.headers.get("location");
      const location = rawLocation ? new URL(rawLocation, current).href : null;
      hops.push({ url: current.href, status: response.status, location });
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location);
        continue;
      }
      const secure = current.protocol === "https:" && hops.every(hop => new URL(hop.url).protocol === "https:");
      return {
        hops,
        finalUrl: current,
        status: response.status,
        secure,
        hsts: response.headers.get("strict-transport-security"),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Слишком много перенаправлений: больше " + MAX_REDIRECTS);
}

async function readCertificate(hostname: string, addresses: string[]): Promise<TlsInfo> {
  let lastError = "";
  for (const address of addresses.slice(0, 3)) {
    try {
      return await readCertificateFrom(address, hostname);
    } catch (error) {
      // Один недоступный адрес из нескольких — не повод говорить, что сертификата нет;
      // последняя причина всё же возвращается, иначе диагноз не с чем связать.
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ok: false,
    trusted: false,
    hostnameValid: false,
    issuer: "неизвестен",
    subject: hostname,
    validFrom: null,
    validTo: null,
    daysLeft: null,
    error: lastError || "не удалось получить сертификат",
  };
}

function readCertificateFrom(address: string, hostname: string): Promise<TlsInfo> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: address,
      port: 443,
      servername: isIP(hostname) ? undefined : hostname,
      // Цепочку проверяем сами: иначе самоподписанный сертификат обрывает соединение и не даёт
      // прочитать причину, которую пользователю и нужно показать.
      rejectUnauthorized: false,
    });
    let settled = false;
    const finish = (error?: Error, value?: TlsInfo) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value as TlsInfo);
    };
    socket.setTimeout(TLS_TIMEOUT_MS, () => finish(new Error("TLS не ответил за " + TLS_TIMEOUT_MS / 1000 + " с")));
    socket.once("error", error => finish(error));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      if (!certificate || !certificate.valid_to) {
        finish(new Error("сертификат не получен"));
        return;
      }
      const hostnameError = checkServerIdentity(hostname, certificate);
      const validTo = new Date(certificate.valid_to);
      const validFrom = certificate.valid_from ? new Date(certificate.valid_from) : null;
      const daysLeft = Number.isNaN(validTo.getTime())
        ? null
        : Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
      const authorizationError = socket.authorizationError;
      const authorizationText = authorizationError instanceof Error
        ? authorizationError.message
        : authorizationError
          ? String(authorizationError)
          : null;
      const trusted = socket.authorized === true;
      const expired = !Number.isNaN(validTo.getTime()) && validTo.getTime() <= Date.now();
      const error = hostnameError?.message ?? authorizationText ?? (expired ? "срок действия истёк" : null);
      finish(undefined, {
        ok: trusted && !hostnameError && !expired,
        trusted,
        hostnameValid: !hostnameError,
        issuer: certificateName(certificate.issuer),
        subject: certificateName(certificate.subject) || hostname,
        validFrom: validFrom && !Number.isNaN(validFrom.getTime()) ? validFrom.toISOString() : null,
        validTo: Number.isNaN(validTo.getTime()) ? null : validTo.toISOString(),
        daysLeft,
        error,
      });
    });
  });
}

async function checkWww(url: URL): Promise<WwwInfo | null> {
  const hostname = url.hostname;
  if (!hostname || isIP(hostname.replace(/^\[|\]$/g, ""))) return null;
  const other = hostname.startsWith("www.") ? hostname.slice(4) : "www." + hostname;
  if (!other) return null;
  const otherUrl = new URL(url.href);
  otherUrl.hostname = other;
  try {
    const chain = await fetchChain(otherUrl);
    // Смотрим, куда пришёл второй адрес: остался собой — редиректа нет; пришёл на входной
    // хост — это переход на апекс или на www; ушёл на третий — так и говорим.
    const redirectsTo = redirectDirection(hostname, other, chain.finalUrl.hostname);
    return {
      url: otherUrl.href,
      status: chain.status,
      finalUrl: chain.finalUrl.href,
      redirectsTo,
    };
  } catch (error) {
    return {
      url: otherUrl.href,
      error: error instanceof WebReadError ? error.message : error instanceof Error ? error.message : String(error),
    };
  }
}

function certificateName(value: PeerCertificate["issuer"]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as unknown as Record<string, unknown>;
  for (const key of ["O", "CN", "OU"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return "";
}

function dateLabel(value: string | null): string {
  if (!value) return "срок неизвестен";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}
