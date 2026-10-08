type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 15 * 60 * 1000;

function allow(key: string, limit: number) {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= limit) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

export function checkAuthRateLimit(ip: string, action: "login" | "register") {
  const limit = action === "login" ? 12 : 6;
  const result = allow(action + ":" + ip, limit);
  if (!result.allowed) {
    return { allowed: false as const, retryAfter: result.retryAfter };
  }
  return { allowed: true as const };
}
