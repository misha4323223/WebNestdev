import type { CustomDomain } from "./domain-types.js";

/**
 * Caddy может спросить разрешение несколько раз подряд (проверка сертификата, выпуск,
 * повтор после таймаута). Короткий кеш убирает одинаковые запросы к базе, но не мешает
 * смене статуса: positive TTL 15 секунд, negative 5 секунд. Это не источник истины —
 * только ускорение одного и того же ответа.
 */

type Entry = { expiresAt: number; domain: CustomDomain | null };

const POSITIVE_TTL_MS = 15_000;
const NEGATIVE_TTL_MS = 5_000;
const MAX_ENTRIES = 2_000;
const entries = new Map<string, Entry>();

export async function cachedCustomDomainForTls(
  hostname: string,
  load: (hostname: string) => Promise<CustomDomain | null>,
  now = Date.now(),
): Promise<CustomDomain | null> {
  const cached = entries.get(hostname);
  if (cached && cached.expiresAt > now) return cached.domain;
  if (cached) entries.delete(hostname);
  const domain = await load(hostname);
  entries.set(hostname, {
    domain,
    expiresAt: now + (domain ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  if (entries.size > MAX_ENTRIES) {
    const first = entries.keys().next();
    if (!first.done) entries.delete(first.value);
  }
  return domain;
}

export function clearCustomDomainTlsCache(): void {
  entries.clear();
}
