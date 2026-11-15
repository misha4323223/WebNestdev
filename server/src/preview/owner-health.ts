import { connect as netConnect } from "node:net";
import { previewOwnerTarget } from "./preview-owner.js";

/**
 * Жива ли дверь ноды-владельца preview.
 *
 * Второй реплике недостаточно записи в общем реестре: там может остаться `running`, пока сама
 * нода уже упала. Статус панели читается часто, поэтому TCP-проверка короткая и кешируется на
 * несколько секунд. Это не health приложения — только ответ на вопрос «можно ли вообще достучаться
 * до владельца», чтобы панель не показывала живой preview при мёртвой ноде.
 */

export const PREVIEW_OWNER_UNAVAILABLE_HINT =
  "Нода-владелец предпросмотра недоступна. Дождитесь её восстановления и обновите статус.";

const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_TTL_MS = 3_000;
const MAX_CACHE_ENTRIES = 512;

type Probe = (ownerAddress: string, timeoutMs: number) => Promise<boolean>;

type CacheEntry = { at: number; reachable: boolean };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<boolean>>();
let probeImpl: Probe = probePreviewOwnerDoor;
let nowImpl: () => number = Date.now;

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

/** Сколько живёт результат проверки. Ноль отключает кеш для тестов/диагностики. */
export function previewOwnerHealthTtlMs(raw = process.env.PREVIEW_OWNER_HEALTH_MS): number {
  return positiveMs(raw, DEFAULT_TTL_MS);
}

function ownerKey(ownerAddress: string): string {
  const target = previewOwnerTarget(ownerAddress);
  return target ? target.host + ":" + target.port : "";
}

/**
 * Одна TCP-проверка без кеша. Нужна и статусу, и старту preview: старт не должен использовать
 * закешированный отказ, если владелец только что поднялся.
 */
export function probePreviewOwner(ownerAddress: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const target = previewOwnerTarget(ownerAddress);
  if (!target) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const socket = netConnect({ host: target.host, port: target.port });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function probePreviewOwnerDoor(ownerAddress: string, timeoutMs: number): Promise<boolean> {
  return probePreviewOwner(ownerAddress, timeoutMs);
}

/**
 * Проверка с коротким кешем. Одновременные запросы на один адрес объединяются: панель и агент
 * могут читать статус параллельно, а каждая проверка — это отдельный TCP-коннект.
 */
export async function previewOwnerReachable(
  ownerAddress: string,
  options: { timeoutMs?: number; ttlMs?: number; now?: number } = {},
): Promise<boolean> {
  const target = previewOwnerTarget(ownerAddress);
  if (!target) return false;
  const key = ownerKey(ownerAddress);
  const now = options.now ?? nowImpl();
  const ttlMs = options.ttlMs ?? previewOwnerHealthTtlMs();
  const cached = cache.get(key);
  if (cached && now - cached.at < ttlMs) return cached.reachable;

  const running = inflight.get(key);
  if (running) return running;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probe = probeImpl(ownerAddress, timeoutMs)
    .catch(() => false)
    .then(reachable => {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      cache.set(key, { at: nowImpl(), reachable });
      return reachable;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, probe);
  return probe;
}

/** Между тестами кеш не должен переезжать из одного сценария в другой. */
export function resetPreviewOwnerHealthForTests(): void {
  cache.clear();
  inflight.clear();
  probeImpl = probePreviewOwnerDoor;
  nowImpl = Date.now;
}

/** Подмена только для unit-тестов: реальный TCP-коннект в них не нужен. */
export function setPreviewOwnerHealthForTests(
  overrides: { probe?: Probe; now?: () => number } | null,
): void {
  probeImpl = overrides?.probe ?? probePreviewOwnerDoor;
  nowImpl = overrides?.now ?? Date.now;
  cache.clear();
  inflight.clear();
}
