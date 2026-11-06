import { egressHealthPort, egressMode, egressProxyUrl, type EgressMode } from "./config.js";

/**
 * Состояние egress-прокси для `/api/health` (пункт 5.1 плана масштабирования).
 *
 * Прокси — отдельный процесс, и без этого поля «панель жива, а установка пакетов перестала
 * работать» снова начиналось бы с захода на ВМ. Отвечаем тем же, что видит выкатка: режим, адрес,
 * сколько соединений держится и сколько запросов отклонено, с примерами отказов.
 */

export type EgressProxyHealth = {
  ok: boolean;
  mode?: string;
  connections?: number;
  allowlist?: number;
  denied?: number;
  allowed?: number;
  bytesDown?: number;
  denies?: unknown[];
  error?: string;
};

export async function probeEgressProxy(timeoutMs = 500): Promise<EgressProxyHealth> {
  const url = "http://127.0.0.1:" + String(egressHealthPort()) + "/__health";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, error: "health ответил " + String(response.status) };
    const body = (await response.json()) as {
      ok?: unknown;
      mode?: unknown;
      connections?: unknown;
      allowlist?: unknown;
      stats?: { denied?: unknown; allowed?: unknown; bytesDown?: unknown; denies?: unknown };
    };
    return {
      ok: body.ok === true,
      mode: typeof body.mode === "string" ? body.mode : undefined,
      connections: typeof body.connections === "number" ? body.connections : undefined,
      allowlist: typeof body.allowlist === "number" ? body.allowlist : undefined,
      denied: typeof body.stats?.denied === "number" ? body.stats.denied : undefined,
      allowed: typeof body.stats?.allowed === "number" ? body.stats.allowed : undefined,
      bytesDown: typeof body.stats?.bytesDown === "number" ? body.stats.bytesDown : undefined,
      denies: Array.isArray(body.stats?.denies) ? body.stats.denies : undefined,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type EgressInfo = {
  mode: EgressMode | string;
  url?: string;
  listener?: "in-process" | "separate";
  health?: EgressProxyHealth;
};

/** Что включено и где живёт прокси: та же строка на старте, в health и в логе выкатки. */
export async function egressInfo(env: NodeJS.ProcessEnv = process.env): Promise<EgressInfo> {
  const mode = egressMode(env);
  if (mode === "off") return { mode };
  const separate = (env.EGRESS_PROXY_SEPARATE ?? "").trim() === "1";
  if (!separate) return { mode, url: egressProxyUrl(env), listener: "in-process" };
  return { mode, url: egressProxyUrl(env), listener: "separate", health: await probeEgressProxy() };
}
