import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { indexFileExists, isStaticBuildFresh } from "./static-plan.js";
import { readHybridConfig, type HybridConfig } from "./hybrid-config.js";

/**
 * Hybrid's static half: unlike planStaticPreview(), a node-runtime project is expected here.
 * The project explicitly declared hybrid and named the backend script, so the detector's
 * "this project starts a server" answer is not a reason to refuse.
 */
export type HybridPlan =
  | {
      ok: true;
      config: HybridConfig;
      dir: string;
      /** Something is already servable at `dir`. */
      built: boolean;
      /** A build script exists and can refresh the output. */
      build: boolean;
      /** Output exists and is newer than its sources. */
      fresh: boolean;
    }
  | { ok: false; reason: string };

export async function planHybridPreview(config: SandboxConfig): Promise<HybridPlan> {
  const read = await readHybridConfig(config.root);
  if (read.kind === "absent") return { ok: false, reason: "Проект не объявил preview.mode=\"hybrid\" ни в package.json, ни в .webnestdev/preview.json." };
  if (read.kind === "invalid") return { ok: false, reason: read.reason };

  const dir = path.resolve(config.root, read.config.staticDir);
  const built = await indexFileExists(dir);
  const fresh = built ? await isStaticBuildFresh(config.root, dir) : false;
  return {
    ok: true,
    config: read.config,
    dir,
    built,
    build: true,
    fresh,
  };
}
