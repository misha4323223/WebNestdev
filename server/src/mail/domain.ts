import { resolveCname, resolveTxt } from "node:dns/promises";

/**
 * Проверка домена отправителя по DNS.
 *
 * Postbox не отправляет письма от имени домена без DKIM, а без SPF и DMARC они всё чаще уходят в
 * спам. Это требование сервиса, а не совет: админка должна сказать «домен подтверждён» или
 * «нет», и сказать это по настоящим DNS-записям, а не по факту «адрес отправителя заполнен».
 *
 * Селекторы DKIM берутся из POSTBOX_DKIM_SELECTORS, потому что имена селекторов Postbox
 * показывает на странице адреса, и угадывать их нельзя: неверное имя выглядело бы как «DKIM не
 * настроен» и поднимало ложную тревогу. При пустом списке DKIM помечается как «не проверено».
 *
 * Результат кэшируется на минуту: overview и preview вызываются подряд, а DNS-запросы — не
 * то, что стоит делать на каждое открытие экрана.
 */

const LOOKUP_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 60_000;

export type DnsStatus = "ok" | "missing" | "unknown";

export type MailDomainCheck = {
  domain: string;
  /** Были ли вообще DNS-запросы: при пустом списке селекторов DKIM не проверялся. */
  checked: boolean;
  /** Итог для админки: DKIM найден и SPF разрешает Postbox. */
  verified: boolean;
  dkim: {
    status: DnsStatus;
    selectors: Array<{ selector: string; name: string; found: boolean; target: string }>;
    hint: string;
  };
  spf: { status: DnsStatus; record: string; hint: string };
  dmarc: { status: DnsStatus; record: string; hint: string };
  hint: string;
};

export type DnsLookup = {
  cname: (name: string) => Promise<string[]>;
  txt: (name: string) => Promise<string[][]>;
};

const defaultLookup: DnsLookup = {
  cname: async name => resolveCname(name),
  txt: async name => resolveTxt(name),
};

/** Запись, которой нет, — это ответ «нет», а не сбой проверки: NXDOMAIN приходит ошибкой. */
function emptyOnError<T>(promise: Promise<T>, fallback: T, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>(resolve => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export const POSTBOX_SPF_INCLUDE = "include:spf.postbox.yandexcloud.net";

function domainOf(address: string) {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase();
}

function spfRecords(records: string[][]) {
  return records.map(parts => parts.join("")).filter(value => /^v=spf1\b/i.test(value.trim()));
}

let cache: { key: string; at: number; value: MailDomainCheck } | null = null;

/** Тесты начинают с чистого кэша: иначе первый результат отвечал бы за весь процесс. */
export function resetMailDomainCache() {
  cache = null;
}

export async function checkMailDomain(
  sender: string,
  selectors: string[],
  lookup: DnsLookup = defaultLookup,
  now: () => number = Date.now,
): Promise<MailDomainCheck> {
  const domain = domainOf(sender);
  const key = domain + "|" + selectors.join(",");
  if (cache && cache.key === key && cache.at + CACHE_TTL_MS > now()) return cache.value;

  const value = await lookupDomain(domain, selectors, lookup);
  cache = { key, at: now(), value };
  return value;
}

async function lookupDomain(domain: string, selectors: string[], lookup: DnsLookup): Promise<MailDomainCheck> {
  if (!domain) {
    return {
      domain: "",
      checked: false,
      verified: false,
      dkim: { status: "unknown", selectors: [], hint: "адрес отправителя не задан" },
      spf: { status: "unknown", record: "", hint: "адрес отправителя не задан" },
      dmarc: { status: "unknown", record: "", hint: "адрес отправителя не задан" },
      hint: "Сначала задайте POSTBOX_SENDER — без адреса отправителя проверять нечего.",
    };
  }

  const selectorList = selectors.map(selector => selector.trim()).filter(Boolean);
  const dkimResults: Array<{ selector: string; name: string; found: boolean; target: string }> = [];
  for (const selector of selectorList) {
    const name = selector + "._domainkey." + domain;
    const targets = await emptyOnError(lookup.cname(name), [] as string[]);
    dkimResults.push({ selector, name, found: targets.length > 0, target: targets[0] ?? "" });
  }

  const txt = await emptyOnError(lookup.txt(domain), [] as string[][]);
  const spf = spfRecords(txt)[0] ?? "";
  const dmarcTxt = await emptyOnError(lookup.txt("_dmarc." + domain), [] as string[][]);
  const dmarc = dmarcTxt.map(parts => parts.join("")).find(value => /^v=DMARC1\b/i.test(value.trim())) ?? "";

  const dkimOk = dkimResults.some(item => item.found);
  const spfOk = spf.toLowerCase().includes(POSTBOX_SPF_INCLUDE);
  const dkimStatus: DnsStatus = selectorList.length === 0 ? "unknown" : dkimOk ? "ok" : "missing";

  const hints: string[] = [];
  if (selectorList.length === 0) {
    hints.push("Селекторы DKIM не заданы (POSTBOX_DKIM_SELECTORS): имена видны на странице адреса в Postbox — без них DKIM не проверяется.");
  } else if (!dkimOk) {
    hints.push("Нет CNAME DKIM для селекторов " + selectorList.join(", ") + ". Добавьте обе CNAME-записи со страницы адреса в Postbox.");
  }
  if (!spf) hints.push("Нет SPF-записи: добавьте TXT " + domain + " = \"v=spf1 " + POSTBOX_SPF_INCLUDE + " ~all\".");
  else if (!spfOk) hints.push("SPF не разрешает Postbox: добавьте " + POSTBOX_SPF_INCLUDE + " в существующую запись перед all. Второй SPF-записи быть не должно.");
  if (!dmarc) hints.push("Нет DMARC-записи (не обязательно, но улучшает доставляемость): TXT _dmarc." + domain + " = \"v=DMARC1;p=none\".");

  const result: MailDomainCheck = {
    domain,
    checked: selectorList.length > 0,
    verified: dkimOk && spfOk,
    dkim: { status: dkimStatus, selectors: dkimResults, hint: dkimStatus === "unknown" ? hints[0] ?? "" : "" },
    spf: { status: spfOk ? "ok" : "missing", record: spf, hint: spfOk ? "" : "SPF не разрешает отправку через Postbox" },
    dmarc: { status: dmarc ? "ok" : "missing", record: dmarc, hint: dmarc ? "" : "DMARC не настроен" },
    hint: hints.join(" "),
  };
  return result;
}
