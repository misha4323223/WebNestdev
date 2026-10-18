import test from "node:test";
import assert from "node:assert/strict";
import { dockerRunArgs } from "./args.js";
import type { DockerSandboxOptions } from "./types.js";

const options: DockerSandboxOptions = {
  image: "node:22-bookworm-slim",
  memory: "256m",
  cpus: "1",
  pids: "128",
  network: "none",
  maxOutput: 200_000,
};

test("секретный файл монтируется после рабочей области, поверх своего пути", () => {
  const config = {
    projectId: "p1",
    root: "/server/sandboxes/p1",
    hostRoot: "/host/sandboxes/p1",
    memoryMb: 256,
    cpuLimit: 1,
    timeoutMs: 1000,
  };
  const secretMount = "-v";
  const args = dockerRunArgs(
    config,
    config.root,
    options,
    "npm run build",
    "none",
    "wnd-cmd-p1",
    [secretMount, "/host/runtime/p1/.env.local:/workspace/.env.local:ro"],
  );
  const workspace = args.indexOf("/host/sandboxes/p1:/workspace");
  const secret = args.indexOf("/host/runtime/p1/.env.local:/workspace/.env.local:ro");
  assert.ok(workspace >= 0, "рабочая область должна быть смонтирована");
  assert.ok(secret > workspace, "секрет должен монтироваться после рабочей области");
  // Двоеточия в mount-строке не должны склеиваться с -w: Docker получает ровно один аргумент.
  assert.equal(args[secret - 1], secretMount);
  assert.equal(args[secret + 1], "-w");
});
