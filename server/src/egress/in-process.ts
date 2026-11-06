import { listPreviews } from "../preview/preview-store.js";
import { checkEgress, egressAllowlist } from "./allowlist.js";
import { egressMode, egressProxyPort } from "./config.js";
import { startEgressProxy, type EgressProxy } from "./proxy.js";

/**
 * Egress-прокси внутри процесса API — запасной путь, когда супервизора нет.
 *
 * В контейнере (production) прокси поднимает супервизор отдельным процессом
 * (`EGRESS_PROXY_SEPARATE=1`, см. server/preview-door-run.sh) по той же причине, что и дверь в 6.1:
 * чужие соединения не должны занимать память процесса, который обслуживает панель. Но режим
 * `EGRESS_MODE` может быть включён и там, где супервизора нет (разработка, запуск без Docker):
 * контейнеры получили бы адрес прокси, которого никто не слушает, и установка пакетов падала бы
 * на отказе соединения. Поэтому здесь — тот же прокси, в этом процессе, с прямой привязкой адреса
 * к проекту (без внутреннего HTTP-маршрута).
 */
export async function startInProcessEgressProxy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ started: boolean; port?: number; reason?: string; proxy?: EgressProxy }> {
  const mode = egressMode(env);
  if (mode === "off") return { started: false, reason: "EGRESS_MODE=off" };
  if ((env.EGRESS_PROXY_SEPARATE ?? "").trim() === "1") {
    return { started: false, reason: "прокси вынесен отдельным процессом (EGRESS_PROXY_SEPARATE=1)" };
  }
  const port = egressProxyPort(env);
  const allowlist = egressAllowlist(env.EGRESS_ALLOWLIST);
  const proxy = startEgressProxy({
    check: (host, targetPort, address) => checkEgress(host, targetPort, address, { mode, allowlist }),
    identify: async address => listPreviews().find(state => state.host === address)?.projectId ?? null,
    onDeny: entry => console.warn("[egress] отказ: " + JSON.stringify(entry)),
  });
  try {
    await new Promise<void>((ready, fail) => {
      proxy.server.once("error", fail);
      proxy.server.listen(port, "0.0.0.0", () => ready());
    });
  } catch (error) {
    const reason = "не удалось занять порт " + String(port) + ": " + (error instanceof Error ? error.message : String(error));
    await proxy.close().catch(() => undefined);
    return { started: false, reason };
  }
  return { started: true, port, proxy };
}
