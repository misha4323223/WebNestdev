type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 15 * 60 * 1000;

export type AuthAction = "login" | "register" | "phone" | "phoneVerify" | "phoneDemo";

/** Попытки с одного адреса: грубая защита, не зависящая от того, какой аккаунт перебирают. */
const IP_LIMITS: Record<AuthAction, number> = {
  login: 12,
  register: 6,
  phone: 10,
  phoneVerify: 30,
  phoneDemo: 60,
};

/**
 * Попытки по одному аккаунту. Без этого распределённый перебор с разных адресов не встречал бы
 * сопротивления, а один общий счётчик на IP позволял бы блокировать вход всем сразу.
 */
const SUBJECT_LIMITS: Record<AuthAction, number> = {
  login: 8,
  register: 4,
  phone: 4,
  phoneVerify: 15,
  phoneDemo: 60,
};

function allow(key: string, limit: number) {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    if (buckets.size >= 10_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      if (buckets.size >= 10_000) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= limit) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Обе двери проверяются всегда: адрес и аккаунт. `subject` — нормализованный email или телефон;
 * он необязателен, потому что запрос без валидного тела ещё не знает, кого перебирают, и тогда
 * работает только счётчик адреса.
 */
export function checkAuthRateLimit(ip: string, action: AuthAction, subject?: string) {
  // Коды SMS дополнительно ограничены по номеру внутри phone-store (сколько отправок и попыток),
  // а здесь — счётчики адреса и аккаунта: они отвечают на «кто и кого перебирает».
  const byIp = allow("ip:" + action + ":" + (ip || "unknown"), IP_LIMITS[action]);
  if (!byIp.allowed) return { allowed: false as const, retryAfter: byIp.retryAfter };

  const normalized = subject?.trim().toLowerCase();
  if (normalized) {
    const limit = SUBJECT_LIMITS[action];
    const bySubject = allow("subject:" + action + ":" + normalized, limit);
    if (!bySubject.allowed) return { allowed: false as const, retryAfter: bySubject.retryAfter };
  }
  return { allowed: true as const };
}

/** Тесты начинают с чистых счётчиков: карта живёт вместе с процессом. */
export function clearAuthRateLimits() {
  buckets.clear();
}
