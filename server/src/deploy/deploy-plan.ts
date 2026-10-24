import path from "node:path";
import { readFileInside, writeFileInside } from "../sandbox/path-guard.js";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";

/**
 * План развёртывания — обычный `deploy_project.md` в корне проекта.
 *
 * Зачем отдельный файл: развёртывание — это не один запуск агента, а цепочка шагов с внешними
 * ресурсами, деньгами и ключами. Перезагрузка страницы, новый чат или сокращение контекста не
 * должны приводить к повторному созданию уже созданного. Поэтому состояние живёт в файле, который
 * читает и человек во вкладке «Файлы», и агент — до первого действия и после каждого шага.
 *
 * Формат остаётся markdown-документом: заголовок, параметры и чекбоксы. Служебные маркеры статусов
 * написаны рядом, чтобы файл читался без знания внутреннего формата.
 */

export const DEPLOY_PLAN_FILE = "deploy_project.md";
/** Потолок файла: план развёртывания — список шагов, а не документация на сотни килобайт. */
const MAX_FILE_CHARS = 120_000;
const MAX_STEPS = 40;
const MAX_TITLE_CHARS = 300;
const MAX_NOTE_CHARS = 700;
const MAX_FIELD_CHARS = 200;
const MAX_SERVICES = 12;
const MAX_CONTEXT_CHARS = 3500;
const MAX_CONTEXT_STEPS = 30;

export const DEPLOY_STEP_STATUSES = ["pending", "in_progress", "done", "blocked", "skipped"] as const;
export type DeployStepStatus = typeof DEPLOY_STEP_STATUSES[number];

export type DeployStep = {
  title: string;
  status: DeployStepStatus;
  note?: string;
};

export type DeployService = {
  /** Роль сервиса: database, storage, email, sms, hosting, domain. */
  role: string;
  /** Выбранный провайдер или продукт: «Timeweb Cloud PostgreSQL», «NotiSend». */
  provider: string;
  note?: string;
};

export type DeployTarget = {
  /** static | server — выводится из проекта, а не спрашивается наугад. */
  kind?: string;
  /** timeweb | yandex | cloudru | regru и т. п. */
  provider?: string;
  region?: string;
  domain?: string;
};

export type DeployPlan = {
  file: string;
  exists: boolean;
  goal?: string;
  target: DeployTarget;
  services: DeployService[];
  steps: DeployStep[];
  total: number;
  done: number;
  complete: boolean;
  current: DeployStep | null;
  blocked: DeployStep[];
  updatedAt?: string;
};

export type DeployPlanInput = {
  goal?: string;
  target?: DeployTarget;
  services?: Array<Pick<DeployService, "role" | "provider"> & { note?: string }>;
  steps: Array<Pick<DeployStep, "title" | "note"> & { status?: DeployStepStatus }>;
};

const MARK: Record<DeployStepStatus, string> = {
  pending: " ",
  in_progress: "~",
  done: "x",
  blocked: "!",
  skipped: "-",
};

const STATUS_BY_MARK: Record<string, DeployStepStatus> = {
  " ": "pending",
  "~": "in_progress",
  ">": "in_progress",
  "/": "in_progress",
  x: "done",
  X: "done",
  "!": "blocked",
  "-": "skipped",
};

const STEP_LINE = /^\s*[-*+]\s+\[([ xX~>!\-/])\]\s+(.*)$/;
const META_LINE = /^\s*[-*+]\s+(.+?):\s*(.*)$/;
const FENCE_LINE = /^(```|~~~)/;

function cleanLine(value: string, max = MAX_FIELD_CHARS) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Заголовок шага становится частью строки `- [x] Заголовок — заметка`. Разделитель не должен
 * встречаться в самом заголовке, иначе при следующем чтении заметка отрежется не там.
 */
function cleanTitle(value: string) {
  return cleanLine(value.replace(/^\*\*(.+?)\*\*$/, "$1"), MAX_TITLE_CHARS)
    .replace(/\s+—\s+/g, " – ");
}

function cleanNote(value: string | undefined) {
  return value ? cleanLine(value, MAX_NOTE_CHARS) : "";
}

/** Модели присылают статусы по-разному; нормализация щадящая, чтобы шаг не терялся. */
export function normalizeDeployStatus(value: unknown): DeployStepStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "in_progress" || normalized === "progress" || normalized === "doing" || normalized === "active" || normalized === "started") return "in_progress";
  if (normalized === "done" || normalized === "complete" || normalized === "completed" || normalized === "finished" || normalized === "success" || normalized === "ok") return "done";
  if (normalized === "blocked" || normalized === "waiting" || normalized === "manual" || normalized === "needs_user" || normalized === "user" || normalized === "blocked_on_user") return "blocked";
  if (normalized === "skipped" || normalized === "skip" || normalized === "not_needed" || normalized === "cancelled" || normalized === "canceled") return "skipped";
  if (normalized === "pending" || normalized === "todo" || normalized === "queued" || normalized === "not_started" || normalized === "new") return "pending";
  return undefined;
}

function progressOf(steps: DeployStep[]) {
  const done = steps.filter(step => step.status === "done").length;
  return {
    done,
    total: steps.length,
    complete: steps.length > 0 && steps.every(step => step.status === "done" || step.status === "skipped"),
    current: steps.find(step => step.status === "in_progress") ?? null,
    blocked: steps.filter(step => step.status === "blocked"),
  };
}

function parseMetadataLine(trimmed: string, plan: { goal?: string; target: DeployTarget; services: DeployService[]; updatedAt?: string }) {
  const meta = META_LINE.exec(trimmed);
  if (!meta) return;
  // Строка шага уже обработана раньше: здесь только параметры документа.
  if (STEP_LINE.test(trimmed)) return;
  const key = meta[1].trim().toLowerCase();
  const value = meta[2].trim();
  if (!value) return;

  if (key === "цель" || key === "goal" || key === "назначение") {
    plan.goal = value.slice(0, MAX_FIELD_CHARS);
    return;
  }
  if (key === "тип" || key === "kind" || key === "формат") {
    plan.target.kind = value.slice(0, MAX_FIELD_CHARS);
    return;
  }
  if (key === "провайдер" || key === "provider" || key === "хостинг") {
    plan.target.provider = value.slice(0, MAX_FIELD_CHARS);
    return;
  }
  if (key === "регион" || key === "region") {
    plan.target.region = value.slice(0, MAX_FIELD_CHARS);
    return;
  }
  if (key === "домен" || key === "domain") {
    plan.target.domain = value.slice(0, MAX_FIELD_CHARS);
    return;
  }
  if (key === "обновлено" || key === "updated" || key === "updatedat" || key === "updated_at") {
    plan.updatedAt = value.slice(0, 60);
    return;
  }
  if (key.startsWith("сервис") || key.startsWith("service")) {
    const separator = key.indexOf("·");
    const role = cleanLine(separator >= 0 ? key.slice(separator + 1) : key.replace(/^(сервис|service)\s*/, ""), 60);
    if (!role || plan.services.length >= MAX_SERVICES) return;
    const noteAt = value.indexOf(" — ");
    const provider = cleanLine(noteAt >= 0 ? value.slice(0, noteAt) : value, MAX_FIELD_CHARS);
    const note = noteAt >= 0 ? cleanLine(value.slice(noteAt + 3), MAX_NOTE_CHARS) : "";
    if (provider) plan.services.push({ role, provider, ...(note ? { note } : {}) });
  }
}

export function parseDeployPlan(markdown: string, exists = true): DeployPlan {
  const plan: { goal?: string; target: DeployTarget; services: DeployService[]; updatedAt?: string } = {
    target: {},
    services: [],
  };
  const steps: DeployStep[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (FENCE_LINE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const step = STEP_LINE.exec(raw);
    if (step) {
      const body = step[2].trim();
      const noteAt = body.indexOf(" — ");
      const title = cleanTitle(noteAt >= 0 ? body.slice(0, noteAt) : body);
      if (!title) continue;
      const note = cleanNote(noteAt >= 0 ? body.slice(noteAt + 3) : "");
      steps.push({
        title,
        status: STATUS_BY_MARK[step[1]] ?? "pending",
        ...(note ? { note } : {}),
      });
      continue;
    }

    parseMetadataLine(trimmed, plan);
  }

  const limited = steps.slice(0, MAX_STEPS);
  return {
    file: DEPLOY_PLAN_FILE,
    exists,
    ...(plan.goal ? { goal: plan.goal } : {}),
    target: plan.target,
    services: plan.services,
    steps: limited,
    ...progressOf(limited),
    ...(plan.updatedAt ? { updatedAt: plan.updatedAt } : {}),
  };
}

/** Нормализует вход инструмента: один шаг в работе, уникальные заголовки, разумные пределы. */
export function normalizeDeploySteps(input: DeployPlanInput["steps"]): DeployStep[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("План развёртывания не может быть пустым: перечислите шаги в порядке выполнения.");
  }
  if (input.length > MAX_STEPS) {
    throw new Error("В плане развёртывания не больше " + MAX_STEPS + " шагов: разделите работу на более крупные этапы.");
  }

  const seen = new Set<string>();
  let inProgressSeen = false;
  const steps: DeployStep[] = [];

  for (const raw of input) {
    const title = cleanTitle(String(raw?.title ?? ""));
    if (!title) throw new Error("У каждого шага развёртывания должен быть заголовок.");
    const key = title.toLocaleLowerCase("ru");
    if (seen.has(key)) throw new Error("Шаги развёртывания не должны повторяться: " + title);
    seen.add(key);

    const requested = normalizeDeployStatus(raw?.status) ?? "pending";
    // Два «текущих» шага в одном плане сбивают и агента, и человека: второй остаётся ждать.
    const status = requested === "in_progress" && inProgressSeen ? "pending" : requested;
    if (status === "in_progress") inProgressSeen = true;

    const note = cleanNote(raw?.note);
    steps.push({ title, status, ...(note ? { note } : {}) });
  }

  return steps;
}

function normalizeServices(input: DeployPlanInput["services"]): DeployService[] {
  if (!input?.length) return [];
  const seen = new Set<string>();
  const services: DeployService[] = [];
  for (const raw of input.slice(0, MAX_SERVICES)) {
    const role = cleanLine(String(raw?.role ?? ""), 60);
    const provider = cleanLine(String(raw?.provider ?? ""), MAX_FIELD_CHARS);
    if (!role || !provider) continue;
    const key = role.toLocaleLowerCase("ru");
    if (seen.has(key)) throw new Error("Роль сервиса указана дважды: " + role);
    seen.add(key);
    const note = cleanNote(raw?.note);
    services.push({ role, provider, ...(note ? { note } : {}) });
  }
  return services;
}

function normalizeTarget(input: DeployTarget | undefined): DeployTarget {
  const target: DeployTarget = {};
  for (const key of ["kind", "provider", "region", "domain"] as const) {
    const value = cleanLine(String(input?.[key] ?? ""));
    if (value) target[key] = value;
  }
  return target;
}

export function renderDeployPlan(input: {
  goal?: string;
  target: DeployTarget;
  services: DeployService[];
  steps: DeployStep[];
  updatedAt: string;
}) {
  const lines = [
    "# План развёртывания",
    "",
    "<!-- deploy-plan:v1 · статусы: [ ] ждёт · [~] в работе · [x] готово · [!] нужен пользователь · [-] пропущено -->",
    "",
    "## Развёртывание",
    "- Обновлено: " + input.updatedAt,
  ];

  const parametersStart = lines.length;
  const goal = cleanLine(input.goal ?? "");
  if (goal) lines.push("- Цель: " + goal);
  if (input.target.kind) lines.push("- Тип: " + input.target.kind);
  if (input.target.provider) lines.push("- Провайдер: " + input.target.provider);
  if (input.target.region) lines.push("- Регион: " + input.target.region);
  if (input.target.domain) lines.push("- Домен: " + input.target.domain);
  for (const service of input.services) {
    lines.push("- Сервис · " + service.role + ": " + service.provider + (service.note ? " — " + service.note : ""));
  }
  if (lines.length === parametersStart) lines.push("- Параметры не заданы");

  lines.push("", "## Шаги", "");
  for (const step of input.steps) {
    lines.push("- [" + MARK[step.status] + "] " + step.title + (step.note ? " — " + step.note : ""));
  }
  lines.push("");

  return lines.join("\n");
}

export async function readDeployPlan(root: string): Promise<DeployPlan> {
  let markdown = "";
  try {
    markdown = await readFileInside(root, path.join(root, DEPLOY_PLAN_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        file: DEPLOY_PLAN_FILE,
        exists: false,
        target: {},
        services: [],
        steps: [],
        total: 0,
        done: 0,
        complete: false,
        current: null,
        blocked: [],
      };
    }
    throw error;
  }
  if (markdown.length > MAX_FILE_CHARS) {
    throw new Error(DEPLOY_PLAN_FILE + " слишком большой: план развёртывания должен оставаться списком шагов.");
  }
  return parseDeployPlan(markdown, true);
}

export async function writeDeployPlan(
  root: string,
  input: DeployPlanInput,
  now = new Date(),
): Promise<DeployPlan> {
  const steps = normalizeDeploySteps(input.steps);
  const services = normalizeServices(input.services);
  const target = normalizeTarget(input.target);
  const goal = cleanLine(input.goal ?? "");
  const markdown = renderDeployPlan({
    ...(goal ? { goal } : {}),
    target,
    services,
    steps,
    updatedAt: now.toISOString(),
  });

  const written = await writeFileInside(root, path.join(root, DEPLOY_PLAN_FILE), markdown);
  // Контейнер работает от uid 1000, а сервер пишет от root: файл должен остаться записываемым
  // агенту внутри песочницы, иначе следующее обновление плана не пройдёт.
  await openDirsForSandbox(root, path.dirname(written));
  await openFileForSandbox(written);
  return parseDeployPlan(markdown, true);
}

/**
 * Компактная сводка для системного контекста. Полный файл в каждый запуск не тянется: шаги
 * ограничены, а завершённый план превращается в одну строку — иначе старый деплой занимал бы
 * место в контексте каждой следующей задачи.
 */
export function deployPlanNotice(plan: DeployPlan | null | undefined): string {
  if (!plan?.exists) return "";

  if (plan.total === 0) {
    return [
      "DEPLOYMENT PLAN: " + DEPLOY_PLAN_FILE + " exists but has no steps.",
      "Before creating any deployment resource, write the full ordered plan with deploy.plan.",
    ].join("\n");
  }

  const target = [plan.goal, plan.target.kind, plan.target.provider, plan.target.domain].filter(Boolean).join(" · ");
  if (plan.complete) {
    return [
      "DEPLOYMENT PLAN: " + DEPLOY_PLAN_FILE + " is complete (" + plan.total + " step(s)" + (plan.updatedAt ? ", updated " + plan.updatedAt : "") + ").",
      "This is the durable record of the deployment: do not recreate its resources, do not repeat its steps, and do not delete anything unless the user explicitly asks.",
      "Read it with deploy.status when the user asks to change the deployment; update it with deploy.plan if the deployment changes.",
    ].join("\n");
  }

  const lines = [
    "DEPLOYMENT PLAN (" + DEPLOY_PLAN_FILE + ") — the durable bookmark that survives a reload, a new chat and context trimming.",
    "Progress: " + plan.done + " of " + plan.total + " done" +
      (plan.blocked.length ? "; blocked: " + plan.blocked.length : "") +
      (plan.current ? "; current: \"" + plan.current.title + "\"" : "") + ".",
  ];
  if (target) lines.push("Goal/target: " + target + ".");
  if (plan.services.length) {
    lines.push("Services: " + plan.services.map(service => service.role + " — " + service.provider).join("; ") + ".");
  }
  lines.push("Steps:");

  let used = lines.join("\n").length;
  let shown = 0;
  for (const step of plan.steps) {
    if (shown >= MAX_CONTEXT_STEPS) break;
    const line = "- [" + step.status + "] " + step.title + (step.note ? " — " + step.note : "");
    if (used + line.length + 1 > MAX_CONTEXT_CHARS - 320) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < plan.steps.length) {
    lines.push("… " + (plan.steps.length - shown) + " more step(s): read the full plan with deploy.status.");
  }
  lines.push(
    "Never create a resource whose step is already done — reuse it and update the plan instead.",
    "After every verified step call deploy.plan with the complete list and mark it done; a human-only step is blocked with the exact cabinet action and a docs link.",
    "Read the full plan with deploy.status before any deploy action, and always before asking for credentials.",
  );

  return lines.join("\n").slice(0, MAX_CONTEXT_CHARS);
}
