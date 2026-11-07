import os from "node:os";
import { isIPv4 } from "node:net";
import { dockerExec } from "../preview/docker-exec.js";
import { egressProxyEnabled, egressProxyPort, egressProxyUrl } from "./config.js";
import { proxyReachableFrom } from "./network.js";

/**
 * Адрес прокси для контейнеров проекта — по IP, а не по имени сервиса.
 *
 * Почему не хватает имени. `EGRESS_PROXY_URL` по умолчанию указывает на `webnestdev-server`:
 * имя резолвит встроенный DNS Docker, и обычно этого достаточно. Но в момент установки пакетов
 * `npm` разрешает именно хост прокси, и на нагруженной песочнице (gVisor, десятки параллельных
 * соединений) этот единственный запрос может истечь — `getaddrinfo EAI_AGAIN webnestdev-server`.
 * Установка тогда падает, хотя прокси жив и пакеты через него идут: проверка egress при выкатке
 * проходит, а конкретный `npm install` — нет. IP убирает запрос вовсе: сервер знает свой адрес в
 * сети предпросмотра, и контейнер соединяется с ним напрямую.
 *
 * Адрес берётся из собственных интерфейсов процесса, а не из DNS: нужно ровно то, что видит
 * контейнер, стоящий в той же сети. Подсеть читается у самой сети (`docker network inspect`),
 * поэтому адрес из соседней сети (`webnestdev` с базой) не выберется по ошибке.
 */

export type ProxyAddressDeps = {
  /** Свои IPv4-адреса; по умолчанию — интерфейсы процесса. */
  addresses?: () => string[];
  /** Подсети сети в JSON; по умолчанию — `docker network inspect`. */
  inspect?: (network: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

/** Подсети кешируются: адрес меняется только с перезапуском контейнера сервера. */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { url: string; until: number }>();
let loggedUrl = "";

/** Для тестов: кеш живёт на уровне модуля, а сети в тестах разные. */
export function clearProxyAddressCache() {
  cache.clear();
  loggedUrl = "";
}

function ownAddresses() {
  const addresses: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      const family = entry.family as unknown as string | number;
      if ((family === "IPv4" || family === 4) && isIPv4(entry.address)) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

/** `172.31.0.7` внутри `172.31.0.0/24`? Только IPv4 и только корректная маска. */
export function ipv4InCidr(address: string, cidr: string) {
  if (!isIPv4(address)) return false;
  const [base, bitsRaw] = cidr.trim().split("/");
  const bits = Number(bitsRaw);
  if (!base || !isIPv4(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toNumber = (value: string) => value.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  // 2**32 не помещается в 32-битные побитовые операции, поэтому сравниваем через деление.
  const size = 2 ** (32 - bits);
  return Math.floor(toNumber(address) / size) === Math.floor(toNumber(base) / size);
}

/** Хост из адреса прокси; пустая строка — адрес без схемы или не URL. */
function proxyHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function parseSubnets(json: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(entry => (entry && typeof entry === "object" ? (entry as { Subnet?: unknown }).Subnet : ""))
    .filter((subnet): subnet is string => typeof subnet === "string" && subnet.includes("/"));
}

async function networkSubnetJson(network: string) {
  const result = await dockerExec(["network", "inspect", "-f", "{{json .IPAM.Config}}", network], 5000);
  return result.code === 0 ? result.stdout : "";
}

/**
 * Адрес прокси, достижимый из контейнера в этой сети; пустая строка — прокси не нужен
 * (`none`, `bridge`, фильтр выключен). Ошибка чтения сети — не повод ломать запуск: возвращается
 * прежний адрес по имени, и установка ведёт себя как до этой правки.
 */
export async function proxyUrlForNetwork(network: string, deps: ProxyAddressDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (!proxyReachableFrom(network) || !egressProxyEnabled(env)) return "";
  const fallback = egressProxyUrl(env);
  // Compose всегда выставляет `EGRESS_PROXY_URL` (через `${…:-…}`), и там лежит имя сервиса.
  // Это не выбор оператора: иначе вычисление IP отключалось бы на проде всегда. Своим считаем
  // только адрес на другом хосте; имя по умолчанию (EGRESS_PROXY_HOST или `webnestdev-server`)
  // означает «как настроено платформой» и заменяется IP.
  const defaultHost = (env.EGRESS_PROXY_HOST ?? "").trim() || "webnestdev-server";
  const explicit = (env.EGRESS_PROXY_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit && proxyHost(explicit) !== defaultHost) return explicit;

  const now = deps.now ?? Date.now;
  const cached = cache.get(network);
  if (cached && cached.until > now()) return cached.url;

  const inspect = deps.inspect ?? networkSubnetJson;
  let rawSubnets = "";
  try {
    rawSubnets = await inspect(network);
  } catch {
    rawSubnets = "";
  }
  const subnets = parseSubnets(rawSubnets);
  const address = (deps.addresses ?? ownAddresses)().find(own =>
    subnets.some(subnet => ipv4InCidr(own, subnet)),
  );
  if (!address) {
    // Сеть не прочиталась или своего адреса в ней нет (например, песочница на другой машине):
    // остаётся имя сервиса, как раньше.
    return fallback;
  }
  const url = "http://" + address + ":" + egressProxyPort(env);
  cache.set(network, { url, until: now() + CACHE_MS });
  if (loggedUrl !== url) {
    loggedUrl = url;
    // Одна строка на изменение: по ней в логе выкатки видно, что установка больше не зависит от DNS.
    console.log("[egress] адрес прокси для контейнеров проекта: " + url + " (IP в сети " + network + ")");
  }
  return url;
}
