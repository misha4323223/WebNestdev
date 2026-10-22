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

/**
 * Команда приходит из модели, поэтому контейнер не должен уметь повышать права: без сброса
 * capabilities и `no-new-privileges` uid 1000 остаётся единственной защитой, а её мало.
 */
test("контейнер команды запускается без capabilities и без повышения прав", () => {
  const config = { projectId: "p1", root: "/root/p1", memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
  const args = dockerRunArgs(config, config.root, options, "npm test", "none");
  assert.ok(args.includes("--cap-drop") && args[args.indexOf("--cap-drop") + 1] === "ALL", args.join(" "));
  assert.ok(args.includes("no-new-privileges:true"), args.join(" "));
  assert.ok(args.includes("--read-only"), args.join(" "));
  assert.ok(args.includes("--user") && args[args.indexOf("--user") + 1] === "1000:1000", args.join(" "));
});

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
