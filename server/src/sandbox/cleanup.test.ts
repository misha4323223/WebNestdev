import assert from "node:assert/strict";
import test from "node:test";
import {
  isSandboxWorkerName,
  parseDockerTime,
  reapIntervalMs,
  reapStuckSandboxContainers,
  shouldReap,
  startSandboxMaintenance,
  stuckLimits,
} from "./cleanup.js";

const LIMITS = { createdMs: 5 * 60_000, exitedMs: 15 * 60_000, deadMs: 60_000 };
const NOW = Date.parse("2026-11-06T20:00:00Z");

test("зависшие контейнеры: убираются только неработающие и только наши", () => {
  // `created` — контейнер, который не доехал до старта: он держит слой образа и ничего не делает.
  assert.equal(shouldReap({ id: "1", name: "wnd-cmd-p-abc", state: "created", ageMs: 6 * 60_000 }, LIMITS), true);
  // Молодой `created` — это окно между create и start, его трогать нельзя.
  assert.equal(shouldReap({ id: "1", name: "wnd-cmd-p-abc", state: "created", ageMs: 30_000 }, LIMITS), false);
  assert.equal(shouldReap({ id: "2", name: "wnd-job-p-abc", state: "exited", ageMs: 20 * 60_000 }, LIMITS), true);
  assert.equal(shouldReap({ id: "2", name: "wnd-job-p-abc", state: "exited", ageMs: 60_000 }, LIMITS), false);
  assert.equal(shouldReap({ id: "3", name: "wnd-cmd-p-abc", state: "dead", ageMs: 2 * 60_000 }, LIMITS), true);
  // Работающую команду проход не имеет права прервать, как и предпросмотр.
  assert.equal(shouldReap({ id: "4", name: "wnd-cmd-p-abc", state: "running", ageMs: 24 * 60 * 60_000 }, LIMITS), false);
  assert.equal(shouldReap({ id: "5", name: "wnd-preview-p-abc", state: "exited", ageMs: 24 * 60 * 60_000 }, LIMITS), false);
  assert.equal(shouldReap({ id: "6", name: "src-webnestdev-server-1", state: "exited", ageMs: 24 * 60 * 60_000 }, LIMITS), false);
  assert.equal(isSandboxWorkerName("wnd-cmd-p-abc"), true, "команда агента");
  assert.equal(isSandboxWorkerName("wnd-job-p-abc"), true, "задание");
  assert.equal(isSandboxWorkerName("wnd-preview-p-abc"), false, "предпросмотр");
  assert.equal(isSandboxWorkerName("gracious_turing"), false, "чужое имя");
});

test("зависшие контейнеры: пороги читаются из окружения в минутах", () => {
  assert.deepEqual(stuckLimits({} as NodeJS.ProcessEnv), LIMITS);
  const custom = stuckLimits({ SANDBOX_STUCK_CREATED_MINUTES: "2", SANDBOX_STUCK_EXITED_MINUTES: "0", SANDBOX_STUCK_DEAD_MINUTES: "abc" } as NodeJS.ProcessEnv);
  assert.equal(custom.createdMs, 2 * 60_000);
  assert.equal(custom.exitedMs, 0);
  assert.equal(custom.deadMs, LIMITS.deadMs, "нечисловое значение оставляет умолчание");
  assert.equal(reapIntervalMs({} as NodeJS.ProcessEnv), 10 * 60_000);
  assert.equal(reapIntervalMs({ SANDBOX_REAP_INTERVAL_MINUTES: "0" } as NodeJS.ProcessEnv), 0);
});

test("зависшие контейнеры: время Docker с наносекундами разбирается", () => {
  assert.equal(parseDockerTime("2026-11-06T20:00:00.123456789Z"), Date.parse("2026-11-06T20:00:00.123Z"));
  assert.equal(parseDockerTime("2026-11-06T20:00:00Z"), Date.parse("2026-11-06T20:00:00Z"));
  assert.ok(Number.isNaN(parseDockerTime("")));
  assert.ok(Number.isNaN(parseDockerTime("вчера")));
});

type Call = { args: string[] };

/** Фейковый docker: отвечает на `ps`/`inspect` и записывает всё, что у него попросили. */
function fakeDocker(containers: { id: string; name: string; state: string; created: string }[], options: { failList?: boolean; failCreated?: string[] } = {}) {
  const calls: Call[] = [];
  const docker = async (args: string[]) => {
    calls.push({ args });
    if (args[0] === "ps") {
      if (options.failList) return { code: 1, stdout: "", stderr: "docker недоступен" };
      const rows = containers.map(c => [c.id, c.name, c.state].join("\t")).join("\n");
      return { code: 0, stdout: rows + "\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      if (options.failCreated?.includes(args[3])) return { code: 1, stdout: "", stderr: "no such object" };
      const found = containers.find(c => c.id === args[3]);
      return found ? { code: 0, stdout: found.created + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "no such object" };
    }
    if (args[0] === "rm") return { code: 0, stdout: args[2] ?? "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { docker, calls };
}

test("зависшие контейнеры: проход снимает старые и не трогает предпросмотры", async () => {
  const { docker, calls } = fakeDocker([
    { id: "aaa", name: "wnd-cmd-p1-1", state: "created", created: "2026-11-06T19:00:00.000000000Z" },
    { id: "bbb", name: "wnd-cmd-p2-2", state: "created", created: "2026-11-06T19:59:50Z" },
    { id: "ccc", name: "wnd-preview-p3", state: "exited", created: "2026-11-05T10:00:00Z" },
    { id: "ddd", name: "src-webnestdev-server-1", state: "exited", created: "2026-11-05T10:00:00Z" },
  ]);
  const result = await reapStuckSandboxContainers({ docker, limits: LIMITS, now: () => NOW });
  assert.deepEqual(result.removed.map(item => item.id), ["aaa"]);
  assert.equal(result.examined, 2, "проверяются только кандидаты в created/exited/dead с нашими именами");
  const removedArgs = calls.filter(call => call.args[0] === "rm").map(call => call.args);
  assert.deepEqual(removedArgs, [["rm", "-f", "aaa"]]);
});

test("зависшие контейнеры: отказ docker не ломает проход и ничего не удаляет", async () => {
  const { docker, calls } = fakeDocker(
    [{ id: "aaa", name: "wnd-cmd-p1-1", state: "created", created: "2026-11-06T19:00:00Z" }],
    { failList: true },
  );
  const result = await reapStuckSandboxContainers({ docker, limits: LIMITS, now: () => NOW });
  assert.deepEqual(result, { removed: [], examined: 0, failed: 0 });
  assert.equal(calls.filter(call => call.args[0] === "rm").length, 0);

  // Время создать не удалось — контейнер не убирается: возраст здесь единственная защита.
  const broken = fakeDocker(
    [
      { id: "aaa", name: "wnd-cmd-p1-1", state: "created", created: "2026-11-06T19:00:00Z" },
      { id: "bbb", name: "wnd-cmd-p2-2", state: "exited", created: "2026-11-06T10:00:00Z" },
    ],
    { failCreated: ["aaa"] },
  );
  const partial = await reapStuckSandboxContainers({ docker: broken.docker, limits: LIMITS, now: () => NOW });
  assert.deepEqual(partial.removed.map(item => item.id), ["bbb"]);
  assert.equal(partial.failed, 1);
});

test("зависшие контейнеры: сторож проводит уборку сразу при запуске", async () => {
  const { docker, calls } = fakeDocker([
    { id: "aaa", name: "wnd-cmd-p1-1", state: "created", created: "2026-11-06T19:00:00Z" },
  ]);
  const lines: string[] = [];
  const stop = startSandboxMaintenance(
    (message, extra) => lines.push(message + JSON.stringify(extra ?? {})),
    // `reapJobs: false` — стартовая уборка заданий ходит в настоящий Docker, в тесте она не нужна.
    { intervalMs: 0, reapJobs: false, deps: { docker, limits: LIMITS, now: () => NOW } },
  );
  assert.equal(typeof stop, "function");
  stop();
  stop();
  // Проход асинхронный: ждём, пока уборка доедет до `rm`.
  for (let i = 0; i < 50 && !calls.some(call => call.args[0] === "rm"); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(calls.filter(call => call.args[0] === "rm").map(call => call.args), [["rm", "-f", "aaa"]]);
  assert.ok(lines.some(line => line.startsWith("[sandbox] убраны зависшие контейнеры (старт)")), lines.join("\n"));
});
