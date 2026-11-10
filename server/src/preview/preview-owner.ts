import { networkInterfaces } from "node:os";
import { nodeAddress, nodeId } from "../nodes/identity.js";
import { getNode } from "../nodes/node-store.js";

const DEFAULT_PREVIEW_PORT = 8788;

/** Порт двери публичных предпросмотров (тот же, что слушает `preview-host-server`). */
export function previewDoorPort(): number {
  const raw = Number(process.env.PREVIEW_HOST_PORT);
  return Number.isFinite(raw) && raw > 0 && raw < 65_536 ? Math.floor(raw) : DEFAULT_PREVIEW_PORT;
}

/** Имя хоста из адреса runner'а или двери: принимает `host:port` и `http://host:port`. */
function hostOf(address: string): string {
  const raw = address.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : "http://" + raw);
    return url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw.split(":")[0] ?? "";
  }
}

/** Внешний IPv4 основного интерфейса — запасной адрес, если runner-адрес не задан. */
function firstExternalHost(): string {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) candidates.push({ name, address: address.address });
    }
  }
  // docker0/br-* — не адрес машины в приватной сети: по нему вторая реплика не достучится.
  return (candidates.find(item => /^(eth|ens|enp)/.test(item.name)) ?? candidates[0])?.address ?? "";
}

/** Приватный адрес двери этого API-процесса; пусто — у узла нет адреса (dev/одиночная ВМ). */
export function localPreviewOwnerAddress(): string {
  const host = hostOf(nodeAddress()) || firstExternalHost();
  return host ? host + ":" + previewDoorPort() : "";
}

let localHostsCache: Set<string> | null = null;

/** Все адреса, по которым дверь на этой машине — «своя»: env, интерфейсы и петля. */
function localHosts(): Set<string> {
  if (localHostsCache) return localHostsCache;
  const hosts = new Set(["127.0.0.1", "::1"]);
  const configured = hostOf(nodeAddress());
  if (configured) hosts.add(configured);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4") hosts.add(address.address);
    }
  }
  localHostsCache = hosts;
  return hosts;
}

/** `host:port` в одном виде: без схемы, лишних слэшей и с портом по умолчанию. */
export function normalizePreviewOwnerAddress(owner: string | undefined): string {
  const target = previewOwnerTarget(owner ?? "");
  return target ? target.host + ":" + target.port : "";
}

/** Разбирает адрес двери; null — это не адрес двери предпросмотра. */
export function previewOwnerTarget(owner: string): { host: string; port: number } | null {
  const raw = owner.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : "http://" + raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port ? Number(url.port) : DEFAULT_PREVIEW_PORT;
    return host && Number.isInteger(port) && port > 0 && port < 65_536 ? { host, port } : null;
  } catch {
    return null;
  }
}

/**
 * Принадлежит ли preview этой двери. Пустой owner — старые строки: их обслуживает локальная
 * дверь, как раньше, иначе после выкатки уже запущенные preview стали бы недоступны.
 */
export function isLocalPreviewOwner(owner: string | undefined): boolean {
  if (!owner?.trim()) return true;
  const target = previewOwnerTarget(owner);
  // Проверяем не только env: дверь на своей машине должна узнавать свой адрес, даже если
  // WEBNESTDEV_NODE_ADDRESS ещё не задан. Иначе она отправила бы запрос сама себе по кругу.
  return Boolean(target && target.port === previewDoorPort() && localHosts().has(target.host));
}

/**
 * Дверь, которая умеет отдать preview. Для контейнера лучше дверь его узла: она видит контейнер
 * напрямую (или через relay своего runner'а), даже если preview запустил API другой реплики.
 * Для static это всегда дверь процесса, который держит слушатель, — её передаёт static-preview.
 */
export async function previewOwnerAddressForNode(node: string | undefined): Promise<string> {
  if (!node || node === nodeId()) return localPreviewOwnerAddress();
  const record = await getNode(node).catch(() => null);
  const host = hostOf(record?.address ?? "");
  return host ? host + ":" + previewDoorPort() : localPreviewOwnerAddress();
}
