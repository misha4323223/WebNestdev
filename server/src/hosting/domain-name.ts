import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";
import { getDomain, parse } from "tldts";
import { HostingError } from "./types.js";
import type {
  CustomDomainKind,
  NormalizeCustomDomainOptions,
  NormalizedCustomDomain,
  NormalizedCustomDomainGroup,
} from "./domain-types.js";

/**
 * Приводит ввод клиента к безопасному DNS-имени.
 *
 * Здесь нет попытки «угадать» домен из URL: API принимает только hostname. Это лучше для
 * безопасности и понятнее в UI — пользователь вставляет `example.ru`, а не ссылку.
 * Punycode используется и для проверки, и в DNS/TLS; Unicode остаётся только для показа.
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SPECIAL_USE = new Set(["localhost", "local", "internal", "invalid"]);
const DEFAULT_RESERVED = ["nestdev.ru", "host.nestdev.ru", "preview.nestdev.ru", "custom.nestdev.ru"];

function invalid(message: string): never {
  throw new HostingError("DOMAIN_INVALID", message, 400);
}

function assertLabel(label: string) {
  if (!label || label.length > 63 || !LABEL_RE.test(label)) {
    invalid("Домен содержит некорректную DNS-метку");
  }
}

function assertNotReserved(hostname: string, reserved: string[]) {
  for (const domain of reserved) {
    const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
    if (!normalized) continue;
    if (hostname === normalized || hostname.endsWith("." + normalized)) {
      invalid("Домены платформы нельзя подключать как свой");
    }
  }
}

export function normalizeCustomDomainGroup(
  rawInput: string,
  options: NormalizeCustomDomainOptions = {},
): NormalizedCustomDomainGroup {
  const raw = String(rawInput ?? "").trim();
  if (!raw) invalid("Введите домен");
  if (/[\s/\\@:*?#]/.test(raw)) {
    invalid("Укажите только домен без схемы, порта, пути и wildcard");
  }

  const withoutDot = raw.replace(/\.$/, "").toLowerCase();
  if (!withoutDot || withoutDot.length > 253) invalid("Домен должен быть не длиннее 253 символов");
  if (isIP(withoutDot)) invalid("IP-адрес нельзя подключить как домен");

  const ascii = domainToASCII(withoutDot);
  if (!ascii) invalid("Домен не читается как DNS-имя");
  if (ascii !== withoutDot && !ascii.includes("xn--")) {
    invalid("Домен содержит недопустимые символы");
  }
  if (ascii.length > 253) invalid("Домен должен быть не длиннее 253 символов");
  // TXT-запись добавляет `_nestdev-verify.` к каждому имени; итоговое имя тоже должно
  // помещаться в DNS-лимит 253 символа, иначе проверка владения станет невозможной.
  if (ascii.length + "_nestdev-verify.".length > 253) {
    invalid("Домен слишком длинный для TXT-проверки");
  }
  const labels = ascii.split(".");
  if (labels.length < 2) invalid("Нужен домен второго уровня, например example.ru");
  labels.forEach(assertLabel);
  if (SPECIAL_USE.has(labels[labels.length - 1] ?? "")) {
    invalid("Служебные домены нельзя подключать");
  }

  const parsed = parse(ascii);
  const rootDomain = getDomain(ascii);
  if (!rootDomain || !parsed.publicSuffix || ascii === parsed.publicSuffix) {
    invalid("Это публичный суффикс, а не домен клиента");
  }
  assertNotReserved(ascii, [...DEFAULT_RESERVED, ...(options.reservedDomains ?? [])]);
  assertNotReserved(rootDomain, [...DEFAULT_RESERVED, ...(options.reservedDomains ?? [])]);

  const kindFor = (hostname: string): CustomDomainKind => {
    if (hostname === rootDomain) return "apex";
    if (hostname === "www." + rootDomain) return "www";
    return "subdomain";
  };

  const requested = ascii;
  const requestedKind = kindFor(requested);
  const shouldAddWww = options.includeWww !== false && (requestedKind === "apex" || requestedKind === "www");
  const hostnames = shouldAddWww
    ? [...new Set([rootDomain, "www." + rootDomain])]
    : [requested];

  return {
    rootDomain,
    hostnames: hostnames.map(hostname => ({
      hostname,
      displayHostname: domainToUnicode(hostname) || hostname,
      kind: kindFor(hostname),
    })),
  };
}

/** Проверка уже сохранённого/пришедшего от Caddy имени без создания группы. */
export function isCustomDomainHostname(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || isIP(host)) return false;
  const ascii = domainToASCII(host);
  if (!ascii || !getDomain(ascii)) return false;
  return ascii.split(".").every(label => Boolean(label) && label.length <= 63 && LABEL_RE.test(label));
}

export function normalizeHostnameLookup(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!isCustomDomainHostname(host)) return null;
  return domainToASCII(host) || null;
}

export function customDomainTxtValue(token: string): string {
  return "nestdev-verify=" + token;
}

export function domainKindLabel(kind: CustomDomainKind): string {
  if (kind === "apex") return "Основной домен";
  if (kind === "www") return "www";
  return "Поддомен";
}
