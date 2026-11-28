import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent } from "../../../types.js";
import type { SandboxConfig } from "../../../sandbox/sandbox-types.js";
import type { EvalTask } from "../types.js";
import { createLiveEvalAdapter, type LiveAdapterDeps } from "./adapter.js";

const TASK: EvalTask = {
  id: "mvp-db-migration",
  title: "Миграция без потери данных",
  size: "mvp",
  prompt: "Нужно добавить поле статуса к заказам. Сделай миграцию, которая не теряет существующие заказы.",
  verify: ["npm test", "npm run migrate"],
  repo: "eval://mvp-orders",
  maxMinutes: 10,
};

type FakeRun = (emit: (event: AgentEvent) => void) => Promise<void>;

async function harness(options: {
  run?: FakeRun;
  exitCode?: number;
  usage?: { input: number; output: number; cached: number; estimated: boolean } | null;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "eval-adapter-"));
  const sandbox: SandboxConfig = { projectId: "project-1", root, memoryMb: 512, cpuLimit: 1, timeoutMs: 1000 };
  const calls: { commands: string[]; deleted: boolean; previewsStopped: number; answered: string[] } = {
    commands: [],
    deleted: false,
    previewsStopped: 0,
    answered: [],
  };
  const run: FakeRun = options.run ?? (async emit => {
    emit({ type: "run.started", runId: "run-1" });
    emit({ type: "run.progress", runId: "run-1", step: 3, maxSteps: 40, tokens: 1200, budget: 250000 });
    emit({
      type: "tool.started",
      runId: "run-1",
      toolCallId: "call-1",
      name: "fs.write",
      input: { path: "src/migrate.mjs" },
    });
    emit({ type: "tool.started", runId: "run-1", toolCallId: "call-2", name: "database.status", input: {} });
  });
  const deps: LiveAdapterDeps = {
    createProject: async () => ({ id: "project-1" }),
    createConversation: async () => ({ id: "conversation-1" }),
    getSandbox: async () => sandbox,
    runAgent: async (_request, emit) => run(emit),
    runCommand: async (_config, command) => {
      calls.commands.push(command);
      return { code: options.exitCode ?? 0, stdout: "ok", stderr: options.exitCode ? "boom" : "" };
    },
    stopPreview: async () => {
      calls.previewsStopped += 1;
    },
    deleteProject: async () => {
      calls.deleted = true;
      return true;
    },
    getRunUsage: async () => options.usage === undefined
      ? { input: 1000, output: 250, cached: 400, estimated: false }
      : options.usage,
    resolveQuestion: (requestId, selected) => {
      calls.answered.push(requestId + ":" + selected.join("|"));
      return true;
    },
  };
  const adapter = createLiveEvalAdapter({ userId: "user-1", plan: "pro", deps });
  return { adapter, calls, sandbox, root };
}

test("успешный прогон: команды проекта, шаги, токены и вызовы инструментов", async () => {
  const { adapter, calls, root } = await harness({});
  try {
    const observation = await adapter(TASK, { signal: new AbortController().signal, timeoutMs: 60_000 });
    assert.equal(observation.ok, true);
    assert.equal(observation.testsPassed, true);
    assert.equal(observation.steps, 3);
    assert.deepEqual(observation.tokens, { input: 1000, output: 250, cached: 400 });
    assert.deepEqual(observation.filesChanged, ["src/migrate.mjs"]);
    assert.deepEqual(observation.toolCalls, [
      { name: "database.status", count: 1 },
      { name: "fs.write", count: 1 },
    ]);
    assert.deepEqual(calls.commands, ["npm test", "npm run migrate"]);
    assert.equal(calls.deleted, true);
    assert.equal(calls.previewsStopped, 1);
    // Фикстура попала в проект до запуска: проверка командой проекта была бы бессмысленной иначе.
    assert.match(await readFile(path.join(root, "src", "migrate.mjs"), "utf8"), /Миграция/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ошибка запуска агента не скрывается зелёными командами", async () => {
  const { adapter, root } = await harness({
    run: async emit => {
      emit({ type: "run.started", runId: "run-2" });
      emit({ type: "run.failed", runId: "run-2", error: "Провайдер модели вернул пустой ответ" });
    },
  });
  try {
    const observation = await adapter(TASK, { signal: new AbortController().signal, timeoutMs: 60_000 });
    assert.equal(observation.ok, false);
    assert.equal(observation.error, "Провайдер модели вернул пустой ответ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("упавшая команда проекта делает задачу неуспешной и называет причину", async () => {
  const { adapter, calls, root } = await harness({ exitCode: 1 });
  try {
    const observation = await adapter(TASK, { signal: new AbortController().signal, timeoutMs: 60_000 });
    assert.equal(observation.ok, false);
    assert.equal(observation.testsPassed, false);
    assert.match(observation.error ?? "", /npm test: boom/);
    // После первого отказа остальные команды не запускаются — как в CI.
    assert.deepEqual(calls.commands, ["npm test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("без измеренного расхода токены не выдумываются", async () => {
  const { adapter, root } = await harness({ usage: null });
  try {
    const observation = await adapter(TASK, { signal: new AbortController().signal, timeoutMs: 60_000 });
    assert.equal(observation.tokens, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("вопрос панели получает ответ, а не ждёт человека до таймаута", async () => {
  const { adapter, calls, root } = await harness({
    run: async emit => {
      emit({ type: "run.started", runId: "run-3" });
      emit({
        type: "question.asked",
        runId: "run-3",
        requestId: "question-1",
        question: "На каком адресе будет жить сайт?",
        options: [
          { label: "https://example.ru", description: "Домен уже есть" },
          { label: "Домена пока нет" },
        ],
        multiSelect: false,
        allowCustom: true,
        expiresAt: Date.now() + 60_000,
      });
      emit({ type: "tool.started", runId: "run-3", toolCallId: "call-9", name: "question.ask", input: {} });
      emit({ type: "run.progress", runId: "run-3", step: 2, maxSteps: 40, tokens: 900, budget: 250000 });
    },
  });
  try {
    const observation = await adapter(TASK, { signal: new AbortController().signal, timeoutMs: 60_000 });
    assert.deepEqual(calls.answered, ["question-1:https://example.ru"]);
    assert.equal(observation.interventions, 1);
    assert.equal(observation.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("задача без фикстуры не выдаётся за успешную", async () => {
  const { adapter } = await harness({});
  const observation = await adapter(
    { ...TASK, id: "mono-shared-type", repo: "eval://mono-shared-type" },
    { signal: new AbortController().signal, timeoutMs: 60_000 },
  );
  assert.equal(observation.ok, false);
  assert.match(observation.error ?? "", /нет фикстуры/);
});
