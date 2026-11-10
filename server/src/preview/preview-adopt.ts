import type { SandboxConfig } from "../sandbox/sandbox-types.js";
import { resolveSandboxHost, type SandboxHost } from "../sandbox/host.js";
import { nodeId } from "../nodes/identity.js";
import { addressOnNetworks, firstContainerAddress, previewNetworks } from "./preview-network.js";
import { previewOwnerAddressForNode } from "./preview-owner.js";
import { flushPreviewWrites, setPreview } from "./preview-store.js";
import { PREVIEW_APP_PORT, PREVIEW_LABEL, type PreviewState } from "./types.js";

/**
 * Принять уже запущенный контейнер, если общего состояния нет.
 *
 * Запуск может быть прерван после `docker run`, но до записи строки в общий реестр: агентский
 * запуск отменили, API перезапустили, запрос оборвался. Контейнер при этом живёт и помечен
 * проектом. Без этого следующий запуск видел только бронь и навсегда отвечал «уже запускается»,
 * хотя приложение уже работает. Здесь состояние собирается из самого Docker: это факт, а не
 * догадка, и владелец контейнера не меняется.
 */
export async function adoptRunningPreview(
  config: SandboxConfig,
  deps: { resolveHost?: (id: string) => Promise<SandboxHost> } = {},
): Promise<PreviewState | null> {
  const node = config.node || nodeId();
  try {
    const host = await (deps.resolveHost ?? resolveSandboxHost)(node);
    const docker = (args: string[], timeoutMs?: number) => host.docker(args, timeoutMs);
    const listed = await docker(["ps", "-aq", "--filter", "label=" + PREVIEW_LABEL + "=" + config.projectId]);
    if (listed.code !== 0) return null;
    for (const containerId of listed.stdout.split(/\s+/).filter(Boolean)) {
      const running = await docker(["inspect", "-f", "{{.State.Running}}", containerId]);
      if (running.code !== 0 || running.stdout.trim() !== "true") continue;
      const networks = host.networks ? await host.networks() : await previewNetworks(docker);
      const address =
        (networks.preview ? await addressOnNetworks(containerId, [networks.preview], docker) : "") ||
        (await firstContainerAddress(containerId, docker));
      if (!address) continue;
      const now = Date.now();
      const ownerAddress = await previewOwnerAddressForNode(node);
      const state: PreviewState = {
        mode: "container",
        containerId,
        projectId: config.projectId,
        host: address,
        port: PREVIEW_APP_PORT,
        startedAt: now,
        lastUsedAt: now,
        ready: false,
        node,
        ...(config.userId ? { ownerUserId: config.userId } : {}),
        ...(ownerAddress ? { ownerAddress } : {}),
      };
      setPreview(state);
      // Строка должна попасть в общий реестр до возврата: иначе следующая реплика снова
      // увидит только бронь и не сможет отдать ни статус, ни логи.
      await flushPreviewWrites(config.projectId);
      return state;
    }
  } catch (error) {
    console.warn(
      "[preview] не удалось принять уже запущенный контейнер " + config.projectId + ": " + describeError(error),
    );
  }
  return null;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
