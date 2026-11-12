import test from "node:test";
import assert from "node:assert/strict";
import { containerVanishedMessage, previewLogsOf, previewProcessArgs, previewWatchEnv } from "./preview-runner.js";
import type { SandboxConfig } from "../sandbox/sandbox-types.js";
import type { DockerExecResult } from "./types.js";

/**
 * Ответ Docker на контейнер, которого уже нет. Ровно он раньше подставлялся вместо вывода
 * приложения и попадал в панель как «логи» и как причина отказа запуска.
 */
const missing: DockerExecResult = {
  code: 1,
  stdout: "",
  stderr: "Error response from daemon: No such container: 6714136cabb0477f991fd20634e08725c9fb13faf62828e53b29fe95c0857f33\n",
};

const runtimeConfig: SandboxConfig = {
  projectId: "preview-runner-test",
  root: "/srv/projects/preview-runner-test",
  hostRoot: "/host/projects/preview-runner-test",
  memoryMb: 512,
  cpuLimit: 0.5,
  timeoutMs: 10_000,
};

test("a hybrid backend gets its own label, PORT/HOST contract and no dev-server port flags", () => {
  const args = previewProcessArgs({
    config: runtimeConfig,
    options: {
      command: "npm run start:preview-api",
      mode: "hybrid",
      port: 3100,
      persistState: false,
      ensureDependencies: false,
      env: { NODE_ENV: "production", PORT: "9999", HOST: "127.0.0.1", FEATURE: "on" },
    },
    image: "sandbox-image",
    network: "preview-net",
    secretMounts: ["-v", "/secret/.env:/workspace/.env:ro"],
  });

  assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
  assert.ok(args.includes("webnestdev.preview.kind=hybrid"));
  assert.deepEqual(args.slice(-4), ["sandbox-image", "/bin/sh", "-lc", "npm run start:preview-api"]);
  assert.ok(args.includes("PORT=3100"));
  assert.ok(args.includes("HOST=0.0.0.0"));
  assert.ok(args.includes("FEATURE=on"));
  assert.ok(!args.includes("PORT=9999"), "backendEnv must not override the platform port");
  assert.ok(!args.includes("HOST=127.0.0.1"), "backendEnv must not override the platform host");
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("preview-net"));
  assert.ok(args.includes("/secret/.env:/workspace/.env:ro"));
});

test("a container preview keeps its dev-server command shape without hybrid labels or flags", () => {
  const args = previewProcessArgs({
    config: runtimeConfig,
    options: {
      command: "npm run dev -- --host 0.0.0.0 --port 3000",
      mode: "container",
      persistState: true,
      ensureDependencies: true,
    },
    image: "sandbox-image",
    network: "preview-net",
    secretMounts: [],
  });

  assert.ok(!args.includes("webnestdev.preview.kind=hybrid"));
  assert.ok(!args.some(value => value === "PORT=3000" || value === "HOST=0.0.0.0"));
  assert.deepEqual(args.slice(-4), ["sandbox-image", "/bin/sh", "-lc", "npm run dev -- --host 0.0.0.0 --port 3000"]);
});

test("runsc previews poll the bind mount; runc keeps the native watcher", () => {
  assert.deepEqual(previewWatchEnv("runsc"), ["CHOKIDAR_USEPOLLING=1", "CHOKIDAR_INTERVAL=300"]);
  assert.deepEqual(previewWatchEnv("docker"), []);
});

test("logs of a container Docker no longer knows are marked missing, not returned as app output", async () => {
  const result = await previewLogsOf("6714136cabb0", async () => missing);
  assert.deepEqual(result, { logs: "", missing: true });
});

test("app logs are joined without carriage returns", async () => {
  const result = await previewLogsOf("c1", async args => {
    assert.deepEqual(args, ["logs", "--tail", "120", "c1"]);
    return { code: 0, stdout: "VITE v5 ready\r\n", stderr: "  local: http://localhost:3000\r\n" };
  });
  assert.equal(result.missing, false);
  assert.equal(result.logs, "VITE v5 ready\nlocal: http://localhost:3000");
});

test("a vanished container is explained in Russian instead of Docker's error text", () => {
  const message = containerVanishedMessage("6714136cabb0477f991fd20634e08725c9fb13faf62828e53b29fe95c0857f33");
  assert.match(message, /^Контейнер предпросмотра исчез/);
  assert.match(message, /6714136cabb0/);
  assert.doesNotMatch(message, /No such container/);
});
