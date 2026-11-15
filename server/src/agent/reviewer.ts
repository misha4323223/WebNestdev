import type { AgentRunRequest, ChatMessage, PlanState } from "../types.js";
import type { Provider } from "../provider.js";
import type { StepUsage } from "./step-runner.js";
import { runAgentStep } from "./step-runner.js";
import { getSandbox } from "../sandbox-manager.js";
import { hasRepo, scanChanges, worktreeDiffFromScan } from "../changes/git-repo.js";
import { scanTextForSecrets } from "../hosting/security.js";

/**
 * Reviewer is deliberately separate from the main run: it gets a clean context with the task, the
 * plan, the actual worktree diff and the checks already passed. It never reads the main chat and
 * never gets tools, so it cannot "agree" with the agent's own narrative.
 *
 * A deterministic pass runs before the model. Credentials, skipped tests and destructive SQL are
 * facts the model should not be asked to notice; they are either present in the diff or not.
 * The model then looks for semantic regressions that a regex cannot see.
 */

export type ReviewSeverity = "error" | "warning" | "info";
export type ReviewFinding = {
  severity: ReviewSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
};
export type ReviewResult = {
  verdict: "pass" | "fail";
  summary: string;
  findings: ReviewFinding[];
};
export type ReviewRun = ReviewResult & {
  usage: StepUsage;
  files: string[];
  additions: number;
  deletions: number;
  patchTruncated: boolean;
};

export type ReviewInput = {
  task: string;
  patch: string;
  files: string[];
  checks: string[];
  plan?: PlanState;
  expectedFiles?: string[];
};
export type ReviewModelInput = ReviewInput & { staticFindings: ReviewFinding[] };

const MAX_FINDINGS = 20;
const MAX_DETAIL = 700;
const MAX_PATCH_CHARS = 60_000;
const MAX_PLAN_CHARS = 3_000;
const MAX_REVIEW_FILES = 30;
const THRESHOLD_FILES = 5;
const THRESHOLD_LINES = 200;

/** The stage gate: a full clean-context review is mandatory above this size. */
export function reviewNeeded(fileCount: number, additions: number, deletions: number) {
  return fileCount > THRESHOLD_FILES || additions + deletions > THRESHOLD_LINES;
}

function addedLines(patch: string) {
  return patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
}

function patchStats(patch: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function finding(severity: ReviewSeverity, title: string, detail: string, file?: string, line?: number): ReviewFinding {
  return { severity, title, detail, ...(file ? { file } : {}), ...(line ? { line } : {}) };
}

/** Facts that do not need a model. Errors here are not overridable by a confident reviewer. */
export function staticReview(input: ReviewInput): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const added = addedLines(input.patch);
  // Only additions: removing a leaked key from a file is a fix, not a new secret.
  const secrets = scanTextForSecrets(added.join("\n"), [], "diff");
  for (const secret of secrets.slice(0, 5)) {
    findings.push(finding("error", "Секрет в diff", "Найден формат секрета (" + secret.kind + "). Уберите значение из изменений."));
  }
  if (added.some(line => /\b(?:it|test|describe|context)\.only\s*\(|\b(?:fit|fdescribe)\s*\(/.test(line))) {
    findings.push(finding("error", "Тест оставлен в режиме only", "`.only`/`fit`/`fdescribe` запускает не весь набор; уберите фокус перед завершением."));
  }
  if (added.some(line => /\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|describe|test)\s*\(/.test(line))) {
    findings.push(finding("warning", "Тест пропускается", "Добавлен skip/xit: проверьте, что это осознанное решение, а не способ обойти падение."));
  }
  if (added.some(line => /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i.test(line))) {
    findings.push(finding("error", "Разрушительный SQL", "В diff добавлен DROP/TRUNCATE. Для миграции нужен явный безопасный сценарий."));
  }
  // A statement can span lines: look for WHERE before the terminating semicolon rather than
  // requiring it on the same line as DELETE, which would reject valid formatted SQL.
  const addedSql = added.map(line => line.slice(1)).join("\n");
  const deleteWithoutWhere = [...addedSql.matchAll(/\bDELETE\s+FROM\b[\s\S]*?(?:;|$)/gi)]
    .some(match => !/\bWHERE\b/i.test(match[0]));
  if (deleteWithoutWhere) findings.push(finding("error", "DELETE без WHERE", "Такой запрос удаляет всю таблицу; добавьте условие или объясните, почему это безопасно."));
  if (added.some(line => /\beval\s*\(|new\s+Function\s*\(/.test(line))) {
    findings.push(finding("warning", "Динамическое исполнение", "Добавлены eval/new Function; проверьте, что входные данные не контролируются пользователем."));
  }
  if (input.expectedFiles?.length) {
    const allowed = new Set(input.expectedFiles.map(file => file.replace(/^\.\//, "")));
    for (const file of input.files) {
      if (!allowed.has(file)) findings.push(finding("warning", "Файл вне scope плана", "Изменён файл, которого нет в списке files ни одного этапа плана.", file));
    }
  }
  if (input.files.length > THRESHOLD_FILES && !input.checks.some(check => /тест|test|pytest|vitest|jest/i.test(check))) {
    findings.push(finding("warning", "Большой diff без проверки тестов", "Изменено больше " + THRESHOLD_FILES + " файлов, но в проверках нет тестов."));
  }
  return findings;
}

/** A reviewer answer must be JSON; a malformed answer is an infrastructure failure, not a pass. */
export function parseReviewResult(text: string, staticFindings: ReviewFinding[] = []): ReviewResult {
  const raw = (text ?? "").trim();
  if (!raw) throw new Error("Reviewer вернул пустой ответ");
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const from = cleaned.indexOf("{");
  const to = cleaned.lastIndexOf("}");
  if (from < 0 || to <= from) throw new Error("Reviewer вернул не JSON");
  let value: unknown;
  try {
    value = JSON.parse(cleaned.slice(from, to + 1));
  } catch {
    throw new Error("Reviewer вернул битый JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reviewer вернул не объект");
  const record = value as Record<string, unknown>;
  const verdict = record.verdict === "pass" || record.verdict === "fail" ? record.verdict : null;
  if (!verdict) throw new Error("Reviewer не указал verdict pass/fail");
  const summary = typeof record.summary === "string" ? record.summary.trim().slice(0, 1_500) : "";
  const findings: ReviewFinding[] = [];
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  for (const rawFinding of rawFindings.slice(0, MAX_FINDINGS)) {
    if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) continue;
    const item = rawFinding as Record<string, unknown>;
    const severity = item.severity === "error" || item.severity === "warning" || item.severity === "info" ? item.severity : "warning";
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 160) : "";
    const detail = typeof item.detail === "string" ? item.detail.trim().slice(0, MAX_DETAIL) : "";
    if (!title || !detail) continue;
    const file = typeof item.file === "string" ? item.file.trim().slice(0, 300) : undefined;
    const line = typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0 ? item.line : undefined;
    findings.push({ severity, title, detail, ...(file ? { file } : {}), ...(line ? { line } : {}) });
  }
  const merged = [...staticFindings, ...findings].slice(0, MAX_FINDINGS);
  const fail = verdict === "fail" || merged.some(item => item.severity === "error");
  return { verdict: fail ? "fail" : "pass", summary: summary || (fail ? "Найдены проблемы." : "Замечаний нет."), findings: merged };
}

function planText(plan: PlanState | undefined) {
  if (!plan?.items.length) return "план не опубликован";
  return plan.items
    .slice(0, 24)
    .map(item => "- [" + item.status + "] " + item.title + (item.note ? " — " + item.note : ""))
    .join("\n")
    .slice(0, MAX_PLAN_CHARS);
}

export function reviewerMessages(input: ReviewModelInput): ChatMessage[] {
  const patch = input.patch.length > MAX_PATCH_CHARS
    ? input.patch.slice(0, MAX_PATCH_CHARS) + "\n… diff обрезан по размеру …"
    : input.patch;
  const staticText = input.staticFindings.length
    ? input.staticFindings.map(item => "- [" + item.severity + "] " + item.title + ": " + item.detail).join("\n")
    : "нет";
  return [
    {
      role: "system",
      content:
        "Ты — независимый reviewer кодового агента. Ты не меняешь проект и не вызываешь инструменты. " +
        "Оцени только предоставленный diff и проверки; не придумывай факты о файлах, которых нет в diff. " +
        "Ищи регрессии, нарушения контрактов, потерю обработки ошибок, небезопасные операции, " +
        "ослабленные тесты и изменения вне scope. Не считай стиль ошибкой. " +
        "Верни ТОЛЬКО один JSON без markdown: " +
        '{"verdict":"pass"|"fail","summary":"кратко","findings":[{"severity":"error"|"warning"|"info","title":"...","detail":"...","file":"...","line":123}]}. ' +
        "error — только то, что действительно блокирует завершение; warning — риск; info — замечание. Если ошибок нет, verdict=pass.",
    },
    {
      role: "user",
      content:
        "ЗАДАЧА:\n" + input.task.slice(0, 4_000) +
        "\n\nПЛАН:\n" + planText(input.plan) +
        "\n\nПРОВЕРКИ:\n" + (input.checks.length ? input.checks.join("; ") : "не записаны") +
        "\n\nФАЙЛЫ:\n" + input.files.slice(0, MAX_REVIEW_FILES).join("\n") +
        "\n\nДЕТЕРМИНИРОВАННЫЕ ЗАМЕЧАНИЯ:\n" + staticText +
        "\n\nDIFF:\n" + patch,
    },
  ];
}

export type ReviewChangesOptions = {
  projectId: string;
  userId: string;
  runId: string;
  request: AgentRunRequest;
  provider: Provider;
  model: string;
  task: string;
  changedFiles: string[];
  checks: string[];
  plan?: PlanState;
  signal?: AbortSignal;
};

/**
 * Builds the diff and runs the review only above the threshold. Returns null for a small change;
 * a small change is still verified by build/tests/preview, but a full clean-context review would
 * cost more than the change itself.
 */
export async function reviewChanges(options: ReviewChangesOptions): Promise<ReviewRun | null> {
  if (!options.changedFiles.length) return null;
  const sandbox = await getSandbox(options.projectId, options.userId);
  // Without a repository there is no baseline to diff against; a full-file "diff" would review
  // the whole project and cost more than the change itself.
  if (!(await hasRepo(sandbox.root))) return null;
  const scan = await scanChanges(sandbox.root);
  const patches: string[] = [];
  const reviewedFiles: string[] = [];
  for (const filepath of [...new Set(options.changedFiles)].slice(0, MAX_REVIEW_FILES)) {
    if (!scan.changed.some(item => item.path === filepath)) continue;
    try {
      const diff = await worktreeDiffFromScan(sandbox.root, filepath, scan);
      reviewedFiles.push(filepath);
      if (diff.patch) patches.push(diff.patch);
    } catch (error) {
      // A binary/truncated file has no line diff; its path still counts toward the threshold.
      reviewedFiles.push(filepath);
      console.warn("[reviewer] diff недоступен для " + filepath, error);
    }
  }
  const patch = patches.join("\n");
  const stats = patchStats(patch);
  if (!reviewNeeded(reviewedFiles.length, stats.additions, stats.deletions)) return null;
  // The whole published plan is the scope, not only the current stage: a file from a previous
  // milestone is still expected, while a file outside every milestone deserves a warning.
  const expectedFiles = options.plan?.milestones?.flatMap(item => item.files);
  const staticFindings = staticReview({
    task: options.task,
    patch,
    files: reviewedFiles,
    checks: options.checks,
    ...(options.plan ? { plan: options.plan } : {}),
    ...(expectedFiles?.length ? { expectedFiles } : {}),
  });
  // A deterministic error must not depend on the reviewer model being available. Returning it
  // before the provider call also keeps a broken/malformed model answer from silently skipping it.
  if (staticFindings.some(item => item.severity === "error")) {
    return {
      verdict: "fail",
      summary: "Детерминированные проверки не пройдены.",
      findings: staticFindings,
      usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, cacheWritePromptTokens: 0, estimated: false },
      files: reviewedFiles,
      additions: stats.additions,
      deletions: stats.deletions,
      patchTruncated: patch.length > MAX_PATCH_CHARS,
    };
  }
  const step = await runAgentStep(options.provider, reviewerMessages({
    task: options.task,
    patch,
    files: reviewedFiles,
    checks: options.checks,
    ...(options.plan ? { plan: options.plan } : {}),
    staticFindings,
  }), options.model, {
    runId: options.runId,
    request: options.request,
    emit: () => {},
    ...(options.signal ? { signal: options.signal } : {}),
    toolNames: [],
    step: 1,
  });
  const result = parseReviewResult(step.text, staticFindings);
  return {
    ...result,
    usage: step.usage,
    files: reviewedFiles,
    additions: stats.additions,
    deletions: stats.deletions,
    patchTruncated: patch.length > MAX_PATCH_CHARS,
  };
}

/** Compact feedback for the main model. The full diff is not repeated. */
export function reviewFeedback(review: ReviewResult) {
  const findings = review.findings
    .filter(item => item.severity !== "info")
    .slice(0, 8)
    .map(item => "- [" + item.severity + "] " + item.title + (item.file ? " (" + item.file + (item.line ? ":" + item.line : "") + ")" : "") + ": " + item.detail)
    .join("\n");
  return "REVIEWER DID NOT PASS THE CHANGE. Fix the findings below, then run verification again. Do not finish while an error remains.\n" +
    (findings || "- " + review.summary);
}
