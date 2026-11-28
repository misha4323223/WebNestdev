/**
 * Live eval adapter: runs the real agent, in a real sandbox, against a real model.
 *
 * The harness deliberately has no shortcut for the model call or the tools. Each task gets a fresh
 * project whose directory is filled from a fixture; `AgentRuntime` then works exactly as it does for
 * a user (same prompt assembly, same tool catalog, same verification cycle); finally the task's
 * `verify` commands and the hidden check decide `ok`. A fake adapter would produce a green report
 * that says nothing about the product, which `docs/AI_EVAL.md` forbids.
 *
 * Cleanup is part of the measurement: a temporary project, its preview and its directory are
 * removed after every task so a suite leaves no workspaces behind.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanId } from "../../../account/plans.js";
import { getRunUsage } from "../../../account/usage-store.js";
import { AgentRuntime } from "../../../agent-runtime.js";
import { stopPreview } from "../../../preview-manager.js";
import { createConversation, createProject, deleteProject } from "../../../project-store.js";
import { getSandbox } from "../../../sandbox-manager.js";
import { runInSandbox } from "../../../sandbox-worker.js";
import { resolvePendingQuestion } from "../../../questions/pending-questions.js";
import type { AgentEvent, AgentMode, AgentRunRequest, ChatMessage } from "../../../types.js";
import type { SandboxConfig } from "../../../sandbox/sandbox-types.js";
import type { EventSink } from "../../types.js";
import type { EvalAdapter, EvalObservation, EvalTask } from "../types.js";
import { summarizeToolCalls } from "../tool-usage.js";
import { CHECK_FILE, EVAL_CHECKS } from "./checks.js";
import { fixtureForRepo } from "./fixtures/index.js";
import { materializeFixture } from "./materialize.js";

/** Tools whose input names a file the agent changed; only these count toward `filesChanged`. */
const PATH_MUTATIONS = new Set(["fs.write", "fs.edit", "fs.delete", "fs.rename"]);

export type LiveCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type LiveUsage = {
  input: number;
  output: number;
  cached: number;
  estimated: boolean;
};

/** Everything the adapter touches outside its own logic; injectable so tests need no database. */
export type LiveAdapterDeps = {
  createProject(name: string, userId: string): Promise<{ id: string }>;
  createConversation(projectId: string, title: string): Promise<{ id: string }>;
  getSandbox(projectId: string, userId: string): Promise<SandboxConfig>;
  runAgent(request: AgentRunRequest, emit: EventSink, signal?: AbortSignal): Promise<void>;
  runCommand(
    config: SandboxConfig,
    command: string,
    cwd: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<LiveCommandResult>;
  stopPreview(projectId: string): Promise<unknown>;
  deleteProject(projectId: string, userId: string): Promise<boolean>;
  getRunUsage(userId: string, runId: string): Promise<LiveUsage | null>;
  /** Ответ на вопрос панели: без него запуск ждёт человека до таймаута. */
  resolveQuestion(requestId: string, selected: string[]): boolean;
};

export type LiveAdapterOptions = {
  /** Owner of the temporary projects. Runs are recorded in that account's usage, as in production. */
  userId: string;
  plan: PlanId;
  mode?: AgentMode;
  /** Keep the temporary projects for inspection; off by default so a suite leaves no workspaces. */
  keepProjects?: boolean;
  /** Per-command ceiling for verification, in milliseconds. */
  commandTimeoutMs?: number;
  /**
   * Как отвечать на `question.ask`. В eval человека нет: по умолчанию выбирается первый вариант,
   * как «разумный дефолт» из инструкции самого инструмента, а ход считается вмешательством.
   * `false` оставляет вопрос без ответа — тогда задача упрётся в таймаут, что и измеряется.
   */
  autoAnswer?: boolean;
  answerQuestion?: (event: { question: string; options: { label: string }[] }) => string[] | undefined;
  deps?: Partial<LiveAdapterDeps>;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ERROR_CHARS = 400;

function defaultDeps(): LiveAdapterDeps {
  const runtime = new AgentRuntime();
  return {
    createProject: (name, userId) => createProject(name, undefined, userId),
    createConversation: (projectId, title) => createConversation(projectId, title),
    getSandbox: (projectId, userId) => getSandbox(projectId, userId),
    runAgent: (request, emit, signal) => runtime.run(request, emit, signal),
    runCommand: async (config, command, cwd, options) => {
      const result = await runInSandbox(config, command, cwd, {
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      // The sandbox reports `ok`/`exitCode` separately; the eval speaks one `code`, where anything
      // short of a clean exit (including a killed container) is a failure.
      return {
        code: result.ok && result.exitCode === 0 && result.signal === null ? 0 : result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    stopPreview: projectId => stopPreview(projectId),
    deleteProject: (projectId, userId) => deleteProject(projectId, userId),
    resolveQuestion: (requestId, selected) => resolvePendingQuestion(requestId, { ok: true, selected }),
    getRunUsage: async (userId, runId) => {
      const usage = await getRunUsage(userId, runId);
      return usage
        ? {
          input: usage.promptTokens,
          output: usage.completionTokens,
          cached: usage.cachedPromptTokens,
          estimated: usage.estimated,
        }
        : null;
    },
  };
}

function clip(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= MAX_ERROR_CHARS ? value : value.slice(0, MAX_ERROR_CHARS - 1) + "…";
}

function changedPath(name: string, input: unknown): string | null {
  if (!PATH_MUTATIONS.has(name) || typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  const candidate = typeof value.path === "string" ? value.path : typeof value.to === "string" ? value.to : "";
  return candidate.trim() || null;
}

type RunTrace = {
  runId: string;
  failed: string;
  steps: number;
  questions: number;
  calls: string[];
  files: Set<string>;
  /** Короткий финальный ответ модели: по нему видно, «сделал и соврал» это или честный отказ. */
  answer: string;
};

type QuestionAsked = Extract<AgentEvent, { type: "question.asked" }>;

function observeRun(
  run: (emit: EventSink) => Promise<void>,
  onQuestion?: (event: QuestionAsked) => void,
): Promise<RunTrace> {
  const trace: RunTrace = { runId: "", failed: "", steps: 0, questions: 0, calls: [], files: new Set(), answer: "" };
  const emit: EventSink = event => {
    if (event.type === "run.started") trace.runId = event.runId;
    else if (event.type === "message.delta") trace.answer = (trace.answer + event.delta).slice(-500);
    else if (event.type === "run.failed") trace.failed = event.error;
    else if (event.type === "run.progress") trace.steps = Math.max(trace.steps, event.step);
    else if (event.type === "question.asked") onQuestion?.(event);
    else if (event.type === "tool.started") {
      trace.calls.push(event.name);
      if (event.name === "question.ask") trace.questions += 1;
      const changed = changedPath(event.name, event.input);
      if (changed) trace.files.add(changed);
    }
  };
  return run(emit).then(() => trace);
}

/** Runs the task's own commands in order, stopping at the first failure — as a CI job would. */
async function runCommands(
  commands: string[],
  sandbox: SandboxConfig,
  deps: LiveAdapterDeps,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ command: string; result: LiveCommandResult }[]> {
  const outcomes: { command: string; result: LiveCommandResult }[] = [];
  for (const command of commands) {
    const result = await deps.runCommand(sandbox, command, sandbox.root, {
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    outcomes.push({ command, result });
    if (result.code !== 0) break;
  }
  return outcomes;
}

function failureReason(outcomes: { command: string; result: LiveCommandResult }[]): string {
  const failed = outcomes.find(outcome => outcome.result.code !== 0);
  if (!failed) return "";
  const detail = failed.result.stderr.trim() || failed.result.stdout.trim() || "код " + failed.result.code;
  return clip(failed.command + ": " + detail);
}

export function createLiveEvalAdapter(options: LiveAdapterOptions): EvalAdapter {
  const deps: LiveAdapterDeps = { ...defaultDeps(), ...options.deps };
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const mode: AgentMode = options.mode ?? "developer";

  return async function runLiveTask(task: EvalTask, context): Promise<EvalObservation> {
    const fixture = fixtureForRepo(task.repo);
    if (!fixture) {
      return { ok: false, error: "нет фикстуры для " + (task.repo ?? "задачи " + task.id) };
    }

    const project = await deps.createProject("eval: " + task.id, options.userId);
    const projectId = project.id;
    try {
      const conversation = await deps.createConversation(projectId, "eval " + task.id);
      const sandbox = await deps.getSandbox(projectId, options.userId);
      await materializeFixture(sandbox.root, fixture);

      const request: AgentRunRequest = {
        projectId,
        conversationId: conversation.id,
        messages: [{ role: "user", content: task.prompt } satisfies ChatMessage],
        userId: options.userId,
        plan: options.plan,
        mode,
        reasoning: "auto",
      };
      const answerQuestion = options.autoAnswer === false
        ? undefined
        : (event: QuestionAsked) => {
          const selected = options.answerQuestion?.(event) ?? event.options.slice(0, 1).map(option => option.label);
          if (selected.length) deps.resolveQuestion(event.requestId, selected);
        };
      const trace = await observeRun(
        emit => deps.runAgent(request, emit, context.signal),
        answerQuestion,
      );
      // Одна строка на задачу: по ней видно, работал ли агент вообще, не открывая отчёт.
      console.log("[eval] " + task.id + " project=" + projectId + " run=" + (trace.runId || "—") +
        " steps=" + trace.steps + " calls=" + trace.calls.length + (trace.failed ? " failed" : ""));

      const usage = trace.runId
        ? await deps.getRunUsage(options.userId, trace.runId).catch(() => null)
        : null;

      // Verification runs even after a failed run: it says whether the work is actually there,
      // while `ok` still reports the failure instead of hiding it behind green commands.
      const commands = await runCommands(task.verify, sandbox, deps, context.signal, commandTimeoutMs);
      const commandsOk = commands.every(outcome => outcome.result.code === 0);

      const check = EVAL_CHECKS[task.id];
      let checkFailure = "";
      if (check) {
        const checkFile = path.join(sandbox.root, CHECK_FILE);
        await writeFile(checkFile, check.script, "utf8");
        try {
          const result = await deps.runCommand(sandbox, "node " + CHECK_FILE, sandbox.root, {
            timeoutMs: commandTimeoutMs,
            ...(context.signal ? { signal: context.signal } : {}),
          });
          if (result.code !== 0) {
            checkFailure = clip(result.stderr.trim() || result.stdout.trim() || "проверка не прошла");
          }
        } finally {
          await rm(checkFile, { force: true });
        }
      }

      const testCommands = commands.filter(outcome => /\btest\b/i.test(outcome.command));
      const testsPassed = testCommands.length
        ? testCommands.every(outcome => outcome.result.code === 0)
        : undefined;

      return {
        ok: !trace.failed && commandsOk && !checkFailure && !context.signal?.aborted,
        ...(testsPassed !== undefined ? { testsPassed } : {}),
        steps: trace.steps || undefined,
        tokens: usage ? { input: usage.input, output: usage.output, cached: usage.cached } : undefined,
        filesChanged: [...trace.files],
        interventions: trace.questions,
        toolCalls: summarizeToolCalls(trace.calls),
        ...(trace.answer.trim() || usage?.estimated
          ? {
            notes: [
              trace.answer.trim() ? "ответ модели: " + clip(trace.answer) : "",
              usage?.estimated ? "токены оценены провайдером, а не измерены" : "",
            ].filter(Boolean).join("; "),
          }
          : {}),
        error: trace.failed || failureReason(commands) || checkFailure || undefined,
      } satisfies EvalObservation;
    } finally {
      await deps.stopPreview(projectId).catch(() => undefined);
      if (!options.keepProjects) {
        await deps.deleteProject(projectId, options.userId).catch(error => {
          console.error("[eval] не удалось удалить временный проект " + projectId + ": " + String(error));
        });
      }
    }
  };
}
