import test from "node:test";
import assert from "node:assert/strict";
import {
  createAbuseWatch,
  createDockerObserver,
  evaluateAbuse,
  parseCpuPercent,
  parseDockerPsLine,
  parseStatsLines,
  projectFromEnvJson,
  type AbuseSample,
} from "./abuse-watch.js";

const limits = { cpuPercent: 90, sustainedMs: 10 * 60_000 };
const minutes = (count: number) => count * 60_000;

test("разбор вывода Docker: проценты, id и проект из переменной окружения", () => {
  assert.equal(parseCpuPercent("12.34%"), 12.34);
  assert.equal(parseCpuPercent("--"), 0);
  assert.deepEqual(parseDockerPsLine('{"ID":"abc","Labels":"webnestdev.managed=1,webnestdev.project=p1"}'), {
    id: "abc",
    projectId: "p1",
  });
  assert.deepEqual(parseDockerPsLine('{"ID":"def","Labels":"webnestdev.managed=1"}'), { id: "def", projectId: null });
  assert.equal(parseDockerPsLine("не json"), null);
  assert.equal(projectFromEnvJson('["CI=1","WEBNESTDEV_PROJECT_ID=proj-7"]'), "proj-7");
  assert.equal(projectFromEnvJson('["CI=1"]'), null);
  assert.deepEqual(parseStatsLines("aaa 95.5%\nbbb 3.2%\n"), [
    { id: "aaa", cpuPercent: 95.5 },
    { id: "bbb", cpuPercent: 3.2 },
  ]);
});

test("короткая нагрузка не считается нарушением", () => {
  const samples: AbuseSample[] = [{ containerId: "c1", projectId: "p1", cpuPercent: 99 }];
  const start = evaluateAbuse(new Map(), samples, 1_000, limits);
  assert.deepEqual(start.violations, []);

  const afterFive = evaluateAbuse(start.state, samples, 1_000 + minutes(5), limits);
  assert.deepEqual(afterFive.violations, []);
});

test("десять минут выше порога — нарушение с контейнерами проекта", () => {
  const samples: AbuseSample[] = [
    { containerId: "c1", projectId: "p1", cpuPercent: 99 },
    { containerId: "c2", projectId: "p1", cpuPercent: 97 },
    { containerId: "c3", projectId: "p2", cpuPercent: 5 },
  ];
  const first = evaluateAbuse(new Map(), samples, 1_000, limits);
  const later = evaluateAbuse(first.state, samples, 1_000 + minutes(11), limits);
  assert.equal(later.violations.length, 1);
  assert.equal(later.violations[0].projectId, "p1");
  assert.deepEqual([...later.violations[0].containers].sort(), ["c1", "c2"]);
  assert.equal(later.state.size, 0, "после нарушения отсчёт начинается заново");
});

test("просадка CPU сбрасывает отсчёт: одна сборка не приближает блокировку", () => {
  const hot: AbuseSample[] = [{ containerId: "c1", projectId: "p1", cpuPercent: 99 }];
  const start = evaluateAbuse(new Map(), hot, 0, limits);
  const cold: AbuseSample[] = [{ containerId: "c1", projectId: "p1", cpuPercent: 3 }];
  const cooled = evaluateAbuse(start.state, cold, minutes(5), limits);
  assert.equal(cooled.state.size, 0);
  const again = evaluateAbuse(cooled.state, hot, minutes(6), limits);
  const notYet = evaluateAbuse(again.state, hot, minutes(10), limits);
  assert.deepEqual(notYet.violations, [], "после сброса нужно ещё десять минут");
});

test("контейнер без проекта не приписывается никому", () => {
  const samples: AbuseSample[] = [{ containerId: "c1", projectId: null, cpuPercent: 99 }];
  const first = evaluateAbuse(new Map(), samples, 0, limits);
  const later = evaluateAbuse(first.state, samples, minutes(30), limits);
  assert.deepEqual(later.violations, []);
  assert.equal(later.state.size, 0);
});

test("тик: блокировка один раз, причина с названием проекта, повторно не срабатывает", async () => {
  let now = 0;
  const calls: string[] = [];
  const watch = createAbuseWatch({
    observe: async () => [
      { containerId: "c1", projectId: "p1", cpuPercent: 99 },
      { containerId: "c2", projectId: "p1", cpuPercent: 95 },
    ],
    ownerOf: async () => ({ userId: "u1", email: "u@example.com", name: "Магазин" }),
    block: async ({ reason }) => {
      assert.match(reason, /Магазин/);
      assert.match(reason, /поддержку/);
      calls.push("block");
    },
    stop: async id => {
      calls.push("stop:" + id);
    },
    audit: async () => {
      calls.push("audit");
    },
    now: () => now,
    limits,
  });
  assert.deepEqual(await watch.tick(), []);
  now = minutes(11);
  const violations = await watch.tick();
  assert.equal(violations.length, 1);
  assert.deepEqual(calls, ["block", "audit", "stop:c1", "stop:c2"]);
  now = minutes(12);
  assert.deepEqual(await watch.tick(), [], "повторный тик не блокирует второй раз");
});

test("владелец не найден — аккаунт не блокируется, причина остаётся в логе", async () => {
  let now = 0;
  const lines: string[] = [];
  let blocked = false;
  const watch = createAbuseWatch({
    observe: async () => [{ containerId: "c1", projectId: "ghost", cpuPercent: 99 }],
    ownerOf: async () => null,
    block: async () => {
      blocked = true;
    },
    stop: async () => undefined,
    audit: async () => undefined,
    now: () => now,
    limits,
    log: line => lines.push(line),
  });
  await watch.tick();
  now = minutes(11);
  await watch.tick();
  assert.equal(blocked, false);
  assert.match(lines.join("\n"), /владелец не найден/);
});

test("наблюдатель Docker: проект из метки и из окружения, CPU сопоставлен по id", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") {
      return {
        code: 0,
        stdout: [
          '{"ID":"aaaaaaaaaaaa","Labels":"webnestdev.managed=1,webnestdev.project=p1"}',
          '{"ID":"bbbbbbbbbbbb","Labels":"webnestdev.managed=1"}',
        ].join("\n"),
        stderr: "",
      };
    }
    if (args[0] === "inspect") {
      return { code: 0, stdout: '["WEBNESTDEV_PROJECT_ID=p2"]', stderr: "" };
    }
    if (args[0] === "stats") {
      return { code: 0, stdout: "aaaaaaaaaaaa 91.0%\nbbbbbbbbbbbb 12.5%\n", stderr: "" };
    }
    return null;
  };

  const observe = createDockerObserver(run);
  const samples = await observe();
  assert.deepEqual(samples, [
    { containerId: "aaaaaaaaaaaa", projectId: "p1", cpuPercent: 91 },
    { containerId: "bbbbbbbbbbbb", projectId: "p2", cpuPercent: 12.5 },
  ]);
  assert.ok(calls.some(args => args[0] === "inspect" && args[3] === "bbbbbbbbbbbb"));
});

test("наблюдатель Docker молчит, если Docker CLI недоступен", async () => {
  const observe = createDockerObserver(async () => null);
  assert.deepEqual(await observe(), []);
});

test("автоматическое ограничение не читается как решение администратора", async () => {
  const { blockedMessageFor } = await import("../account/restriction-store.js");
  const message = blockedMessageFor({
    userId: "u1",
    blockedAt: new Date().toISOString(),
    blockedBy: "system",
    blockedByLabel: "автоматическая проверка нагрузки",
    reason: "контейнер проекта «Магазин» держал загрузку CPU",
  });
  assert.match(message, /автоматической проверкой нагрузки/);
  assert.doesNotMatch(message, /заблокирован администратором/);
  assert.match(message, /поддержку/);
});
