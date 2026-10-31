import { nodeId } from "../nodes/identity.js";
import { sandboxHostRootDir, sandboxRootDir } from "../sandbox/config.js";
import { runDockerCli } from "../sandbox/docker/cli.js";
import { PREVIEW_LABEL } from "../preview/types.js";
import { createPreviewRelayManager } from "./preview-relay.js";
import { createRunnerServer } from "./server.js";

const token = process.env.RUNNER_TOKEN?.trim() ?? "";
if (token.length < 32) {
  throw new Error(
    "RUNNER_TOKEN обязателен и должен быть не короче 32 символов: это единственная граница " +
      "между API и runner в приватной сети",
  );
}
const bind = process.env.RUNNER_BIND?.trim() || "127.0.0.1";
const port = Number(process.env.RUNNER_PORT ?? 8790);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("RUNNER_PORT должен быть числом от 1 до 65535");
}

const relay = createPreviewRelayManager();
const server = createRunnerServer({ token, relay });

server.requestTimeout = 10 * 60_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

server.listen({ host: bind, port }, () => {
  // Never print the token or any secret. The node id, bind and shared path are enough to
  // verify that the runner joined the right private network and mounted the right workspace.
  console.log(
    "[runner] node=" + nodeId() + " bind=" + bind + ":" + port +
      " workspace=" + sandboxRootDir() + " hostWorkspace=" + sandboxHostRootDir(),
  );
  void reapRunnerContainers();
});

/**
 * Containers outlive the API process that owned them, and a runner has no in-memory preview/job
 * map to recover. Reaping labelled previews and jobs on runner boot is what keeps a restarted
 * node from accumulating orphan dev servers; it is separate from the API's own reap, which
 * only knows the API host.
 */
async function reapRunnerContainers() {
  if (process.env.RUNNER_REAP_ON_START === "0") return;
  try {
    const previews = await runDockerCli(["ps", "-aq", "--filter", "label=" + PREVIEW_LABEL], 10_000);
    const previewIds = previews.code === 0 ? previews.stdout.split(/\s+/).filter(Boolean) : [];
    if (previewIds.length) await runDockerCli(["rm", "-f", ...previewIds], 30_000);
    const jobs = await runDockerCli(["ps", "-aq", "--filter", "label=webnestdev.job=1"], 10_000);
    const jobIds = jobs.code === 0 ? jobs.stdout.split(/\s+/).filter(Boolean) : [];
    if (jobIds.length) await runDockerCli(["rm", "-f", ...jobIds], 30_000);
    if (previewIds.length || jobIds.length) {
      console.log("[runner] убрано осиротевших контейнеров: preview=" + previewIds.length + " job=" + jobIds.length);
    }
  } catch (error) {
    console.warn("[runner] уборка осиротевших контейнеров пропущена: " + (error instanceof Error ? error.message : String(error)));
  }
}

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log("[runner] остановка по " + signal);
  await relay.closeAll().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
