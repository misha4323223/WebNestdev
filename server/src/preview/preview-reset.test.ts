import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxHost } from "../sandbox/host.js";
import { resetProjectPreview } from "./preview-reset.js";

function fakeHost(input: {
  ids?: string[];
  listFails?: boolean;
  removeFails?: boolean;
}): SandboxHost {
  return {
    id: "local",
    status: async () => ({ mode: "docker", available: true }),
    runCommand: async () => ({ ok: true, exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false }),
    docker: async args => {
      if (args[0] === "ps") {
        if (input.listFails) return { code: 1, stdout: "", stderr: "daemon недоступен" };
        return { code: 0, stdout: (input.ids ?? []).join("\n"), stderr: "" };
      }
      if (args[0] === "rm") {
        if (input.removeFails) return { code: 1, stdout: "", stderr: "контейнер занят" };
        return { code: 0, stdout: args[2] + "\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

test("сброс удаляет контейнеры, состояние, бронь и env-файлы", async () => {
  const events: string[] = [];
  const result = await resetProjectPreview("project-a", ["local", "local"], {
    resolveHost: async () => fakeHost({ ids: ["container-1", "container-2"] }),
    stopStatic: async projectId => { events.push("static:" + projectId); },
    removeState: projectId => { events.push("state:" + projectId); },
    flushWrites: async projectId => { events.push("flush:" + projectId); },
    clearReservation: async projectId => { events.push("reservation:" + projectId); return true; },
    clearSecrets: async projectId => { events.push("secrets:" + projectId); },
  });

  assert.deepEqual(result.removedContainers, ["container-1", "container-2"]);
  assert.deepEqual(result.remainingContainers, []);
  assert.equal(result.reservationCleared, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(events, [
    "static:project-a",
    "state:project-a",
    "flush:project-a",
    "reservation:project-a",
    "secrets:project-a",
  ]);
});

test("сброс закрывает hybrid-listener и сообщает об его ошибке, не оставляя бронь", async () => {
  const events: string[] = [];
  const result = await resetProjectPreview("project-hybrid", ["local"], {
    resolveHost: async () => fakeHost({ ids: [] }),
    stopStatic: async projectId => { events.push("static:" + projectId); },
    stopHybrid: async projectId => { events.push("hybrid:" + projectId); throw new Error("listener не закрылся"); },
    removeState: projectId => { events.push("state:" + projectId); },
    flushWrites: async projectId => { events.push("flush:" + projectId); },
    clearReservation: async projectId => { events.push("reservation:" + projectId); return true; },
    clearSecrets: async projectId => { events.push("secrets:" + projectId); },
  });

  assert.deepEqual(events, [
    "static:project-hybrid",
    "hybrid:project-hybrid",
    "state:project-hybrid",
    "flush:project-hybrid",
    "reservation:project-hybrid",
    "secrets:project-hybrid",
  ]);
  assert.equal(result.reservationCleared, true);
  assert.equal(result.warnings.some(w => /hybrid-предпросмотр/.test(w)), true);
});

test("недоступный Docker не мешает снять бронь", async () => {
  const result = await resetProjectPreview("project-b", ["local"], {
    resolveHost: async () => fakeHost({ listFails: true }),
    removeState: () => undefined,
    flushWrites: async () => undefined,
    clearReservation: async () => true,
    clearSecrets: async () => undefined,
  });

  assert.deepEqual(result.removedContainers, []);
  assert.deepEqual(result.remainingContainers, []);
  assert.equal(result.reservationCleared, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /Docker не отдал список/);
});

test("неудалённый контейнер остаётся в remainingContainers", async () => {
  const result = await resetProjectPreview("project-c", ["local"], {
    resolveHost: async () => fakeHost({ ids: ["container-1"], removeFails: true }),
    removeState: () => undefined,
    flushWrites: async () => undefined,
    clearReservation: async () => true,
    clearSecrets: async () => undefined,
  });

  assert.deepEqual(result.removedContainers, []);
  assert.deepEqual(result.remainingContainers, ["container-1"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /container-1/);
});
