import test from "node:test";
import assert from "node:assert/strict";
import { containerVanishedMessage, previewLogsOf } from "./preview-runner.js";
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
