import { connectorAllowedForPlan } from "../account/connector-access.js";
import { planAllows } from "../account/entitlements.js";
import {
  PLAN_CATALOG,
  creditPoolFor,
  customDomainLimitFor,
  databaseLimitFor,
  functionLimitFor,
  limitsForPlan,
  repositoryImportLimitFor,
  repositoryPushAllowedFor,
  type PlanId,
} from "../account/plans.js";
import { hostingPlanNotice } from "./hosting-plan-notice.js";

/**
 * Что агент знает о тарифе до первого шага.
 *
 * Раньше в промпт попадала только заметка о хостинге, поэтому модель на «Старте» могла
 * пообещать серверные функции, на «Плюсе» — фоновые задания или терминал, а про квоты
 * (проекты, хранилище, изображения, поиск) не знала вообще. Заметка собирается из того же
 * каталога и той же матрицы возможностей, что и серверные проверки: число в промпте не может
 * разойтись с числом в отказе, потому что источник один.
 *
 * Текст короткий и в повелительном наклонении: он тратит контекст каждого запуска, поэтому
 * здесь только то, что меняет поведение модели, а не пересказ витрины тарифов.
 */
export function agentPlanBrief(plan: PlanId | undefined): string {
  if (!plan) return "";
  const catalog = PLAN_CATALOG[plan];
  const limits = limitsForPlan(plan);
  const functions = planAllows(plan, "serverlessFunctions");
  const background = planAllows(plan, "backgroundJobs");
  const terminal = planAllows(plan, "interactiveTerminal");
  const container = planAllows(plan, "containerPreview");
  const push = repositoryPushAllowedFor(plan);
  const importLimit = repositoryImportLimitFor(plan);
  const domains = customDomainLimitFor(plan);
  const credits = creditPoolFor(plan);
  const databaseBytes = databaseLimitFor(plan);
  const s3Only = !connectorAllowedForPlan(plan, "service", "email");

  const included: string[] = [];
  included.push(count(limits.projects, "project", "projects"));
  included.push(
    limits.hostingSites === null
      ? "hosting sites up to the project count"
      : count(limits.hostingSites, "hosting site", "hosting sites"),
  );
  included.push(storageLabel(limits.storageBytes) + " of account storage shared by all projects");
  included.push(
    credits > 0
      ? count(credits, "agent credit", "agent credits") + " per month"
      : count(limits.agentRunsPerDay ?? 0, "agent run", "agent runs") + " per day on the built-in model",
  );
  included.push(count(limits.webSearchesPerDay ?? 0, "web search", "web searches") + " per day");
  included.push(count(limits.imagesPerDay ?? 0, "generated image", "generated images") + " per day");
  if (functions) included.push(count(functionLimitFor(plan), "serverless function", "serverless functions") + " per site");
  if (databaseBytes > 0) included.push("a client database of " + megabytes(databaseBytes));
  if (importLimit !== null) included.push("repository import up to " + megabytes(importLimit));
  if (push) included.push("pushing commits to a connected repository");
  if (domains > 0) included.push("a custom domain group (apex + www) per site");

  const integrationParts: string[] = [];
  integrationParts.push(integrationCount(limits.integrations.cloud, "cloud"));
  integrationParts.push(integrationCount(limits.integrations.domains, "domain registrar"));
  integrationParts.push(integrationCount(limits.integrations.services, "keyed service"));
  if (s3Only) integrationParts.push("databases and S3 storage without a limit");
  included.push(integrationParts.join(", "));

  const unavailable: string[] = [];
  if (!functions) unavailable.push("serverless functions, background jobs and a functions manifest");
  else if (!background) unavailable.push("background jobs after the HTTP response");
  if (!container) unavailable.push("container and hybrid preview and any long-running dev server");
  if (!terminal) unavailable.push("the panel terminal");
  if (!push) unavailable.push("pushing commits back to a repository");
  if (domains === 0) unavailable.push("custom domains");
  if (s3Only) unavailable.push("keyed services other than S3 storage (email, payments, AI, maps, CRM)");
  if (databaseBytes <= 0) unavailable.push("the client database (it starts on «Плюс»)");

  const lines: string[] = [
    "PLAN FOR THIS RUN. Current plan: «" + catalog.name + "» (" + plan + "). Every number below is enforced by the server, not a suggestion: do not promise, attempt or simulate anything outside it.",
    "Included on this plan: " + included.join("; ") + ".",
  ];
  if (unavailable.length) lines.push("Not available on this plan: " + unavailable.join("; ") + ".");
  lines.push(
    "For an imported repository or uploaded project files, inspect the stack, entry points, scripts and backend needs before doing anything else. If the project needs a long-running server or container preview and this plan does not allow it, do not start a dev server and do not try to bypass the limit: say plainly that running it needs «Премиум» and offer analysis or a static build on the current plan.",
  );
  lines.push(
    "When the request needs something this plan does not have, say plainly what is missing and which plan provides it (serverless functions start on «Плюс», background jobs, the panel terminal and container preview start on «Премиум»), then continue with the part that is allowed. Never try to reach a plan feature through a workaround: no second project or account, no splitting one project across several projects to dodge a quota, no deleting node_modules or build output to hide real usage, and no external free tier used to imitate a paid platform feature.",
  );
  lines.push(
    "Quotas stop work, they do not fail silently: when a limit is reached, stop, name the exact limit and tell the user what frees it (delete a project, empty storage, wait for the UTC reset, buy credits or move to a higher plan). Do not retry the same refused action with a different tool.",
  );
  lines.push(hostingPlanNotice(plan));
  return lines.filter(Boolean).join(" ");
}

function count(value: number, one: string, many: string) {
  // Разряды через пробел: «5 000 кредитов» читается моделью как число, а не как код.
  const label = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return label + " " + (value === 1 ? one : many);
}

function integrationCount(value: number | null, label: string) {
  return value === null ? "unlimited " + label + "s" : count(value, label, label + "s");
}

function megabytes(bytes: number) {
  return Math.max(1, Math.round(bytes / (1024 * 1024))) + " MB";
}

function storageLabel(bytes: number) {
  const megabytesValue = bytes / (1024 * 1024);
  return megabytesValue >= 1024 ? megabytesValue / 1024 + " GB" : Math.round(megabytesValue) + " MB";
}
