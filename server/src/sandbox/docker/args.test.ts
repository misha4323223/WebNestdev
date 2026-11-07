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
  runtime: "docker",
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

/**
 * Кэш npm не должен жить в /tmp: там tmpfs на 256 МБ, а дерево зависимостей на несколько сотен
 * пакетов его переполняет — npm падает с `Exit handler never called!` и оставляет node_modules
 * без `.bin`. Диск проекта больше, а `./node_modules/.cache` исключён из архивов.
 */
test("кэш npm лежит на диске проекта, а не в ограниченном /tmp", () => {
  const config = { projectId: "p1", root: "/root/p1", memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
  const args = dockerRunArgs(config, config.root, options, "npm install", "none");
  const cache = args.indexOf("npm_config_cache=/workspace/node_modules/.cache/npm");
  assert.ok(cache > 0 && args[cache - 1] === "-e", args.join(" "));
});

test("runsc добавляется флагом Docker и не появляется в обычном режиме", () => {
  const config = { projectId: "p1", root: "/root/p1", memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
  const normal = dockerRunArgs(config, config.root, options, "npm test", "none");
  assert.equal(normal.includes("--runtime=runsc"), false, "без gVisor флага быть не должно");
  const runsc = dockerRunArgs(config, config.root, { ...options, runtime: "runsc" }, "npm test", "none");
  assert.ok(runsc.includes("--runtime=runsc"), runsc.join(" "));
  assert.equal(runsc[runsc.indexOf("--runtime=runsc") - 1], "--init", "рантайм применяется к контейнеру, а не к команде");
});

test("git в контейнере не спотыкается о владельца репозитория", () => {
  const config = { projectId: "p1", root: "/root/p1", memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
  const args = dockerRunArgs(config, config.root, options, "git status --short", "none");
  const env: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-e" && typeof args[index + 1] === "string") {
      const [key, ...value] = (args[index + 1] as string).split("=");
      env[key] = value.join("=");
      index++;
    }
  }
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "safe.directory");
  assert.equal(env.GIT_CONFIG_VALUE_0, "*");
});

test("переменные egress-прокси получает только контейнер в сети, где прокси есть", () => {
  const config = { projectId: "p1", root: "/root/p1", memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
  const saved = process.env.EGRESS_MODE;
  process.env.EGRESS_MODE = "allowlist";
  const envOf = (args: string[]) => {
    const result: Record<string, string> = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== "-e" || typeof args[index + 1] !== "string") continue;
      const [key, ...value] = (args[index + 1] as string).split("=");
      result[key as string] = value.join("=");
    }
    return result;
  };
  try {
    const networked = envOf(dockerRunArgs(config, config.root, options, "npm install", "webnestdev-preview"));
    assert.match(networked.HTTPS_PROXY ?? "", /3128$/);
    assert.match(networked.npm_config_https_proxy ?? "", /3128$/);
    // bridge и none — другие сети: адрес прокси там не резолвится, и установка шла бы в пустоту.
    for (const network of ["bridge", "none"]) {
      const bare = envOf(dockerRunArgs(config, config.root, options, "npm install", network));
      assert.equal(bare.HTTPS_PROXY, undefined, network);
    }
  } finally {
    if (saved === undefined) delete process.env.EGRESS_MODE;
    else process.env.EGRESS_MODE = saved;
  }
});

test("долгое задание запускается отсоединённым, без --rm и с метками для уборки", () => {
  const config = { projectId: "p1", root: "/root/p1", memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
  const args = dockerRunArgs(config, config.root, options, "npm test", "none", "wnd-job-p1-1", [], {
    detached: true,
    labels: { "webnestdev.job": "1", "webnestdev.project": "p1" },
  });
  assert.ok(args.includes("-d") && !args.includes("--rm"), args.join(" "));
  const labels = args.flatMap((value, index) => value === "--label" ? [args[index + 1]] : []);
  assert.ok(labels.includes("webnestdev.job=1"), args.join(" "));
  assert.ok(labels.includes("webnestdev.project=p1"), args.join(" "));
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
