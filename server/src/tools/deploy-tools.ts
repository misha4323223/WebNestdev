import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { getSandbox } from "../sandbox-manager.js";
import {
  DEPLOY_PLAN_FILE,
  deployPlanNotice,
  readDeployPlan,
  writeDeployPlan,
  type DeployPlan,
} from "../deploy/deploy-plan.js";

/**
 * План развёртывания — это не `plan.update`. `plan.update` показывает шаги текущего запуска и
 * исчезает вместе с ним; `deploy_project.md` переживает перезагрузку страницы, новый чат и
 * сокращение контекста. Инструменты ниже — единственный способ, которым агент ведёт этот файл,
 * поэтому формат и статусы остаются предсказуемыми для следующего запуска.
 */

const statusSchema = z.enum(["pending", "in_progress", "done", "blocked", "skipped"]);

const stepSchema = z.object({
  title: z.string().trim().min(1).max(300),
  status: statusSchema.optional(),
  note: z.string().trim().max(700).optional(),
});

const serviceSchema = z.object({
  role: z.string().trim().min(1).max(60),
  provider: z.string().trim().min(1).max(200),
  note: z.string().trim().max(700).optional(),
});

const planSchema = z.object({
  goal: z.string().trim().max(200).optional(),
  target: z.object({
    kind: z.string().trim().max(200).optional(),
    provider: z.string().trim().max(200).optional(),
    region: z.string().trim().max(200).optional(),
    domain: z.string().trim().max(200).optional(),
  }).optional(),
  services: z.array(serviceSchema).max(12).optional(),
  steps: z.array(stepSchema).min(1).max(40),
});

function compactPlan(plan: DeployPlan) {
  return {
    file: plan.file,
    exists: plan.exists,
    ...(plan.goal ? { goal: plan.goal } : {}),
    target: plan.target,
    services: plan.services,
    steps: plan.steps,
    total: plan.total,
    done: plan.done,
    complete: plan.complete,
    current: plan.current,
    blocked: plan.blocked,
    ...(plan.updatedAt ? { updatedAt: plan.updatedAt } : {}),
  };
}

registerTool({
  name: "deploy.plan",
  description:
    "Write or update the durable deployment plan in `" + DEPLOY_PLAN_FILE + "` at the project root. " +
    "This file is the bookmark that survives a page reload, a new chat and context trimming — unlike plan.update, which only shows the current run. " +
    "Call it BEFORE creating the first deployment resource, and again with the complete ordered list after every verified step (send the full list, not a diff). " +
    "Input: {goal?:'production'|'staging'|..., target?:{kind?:'static'|'server'|'container'|'vm', provider?, region?, domain?}, " +
    "services?:[{role:'database'|'storage'|'email'|'sms'|'hosting'|'domain', provider:'Timeweb Cloud PostgreSQL', note?}], " +
    "steps:[{title, status?:'pending'|'in_progress'|'done'|'blocked'|'skipped', note?}]}. " +
    "Work out what the project actually is (static site or an app with a server) and include only the services it really needs. " +
    "Mark a step 'blocked' when it needs the user — a key, a payment, a phone confirmation — and put the exact cabinet action and the provider docs URL in its note. " +
    "NEVER put a key, password, token or connection string in this file: provider access is requested with access.request, the application's own variables with secrets.request, and the plan names just the provider and the environment variable. " +
    "The tool owns the file and rewrites it; do not edit it with fs.write, and keep completed steps in the list so the next run does not recreate their resources.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["steps"],
    properties: {
      goal: { type: "string", description: "Что это за развёртывание: production, staging, демо для клиента." },
      target: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", description: "static | server | container | vm — что именно размещается." },
          provider: { type: "string", description: "Хостинг или облако, где размещается проект." },
          region: { type: "string", description: "Регион или зона, если важны." },
          domain: { type: "string", description: "Домен, на котором будет работать проект." },
        },
      },
      services: {
        type: "array",
        maxItems: 12,
        description: "Только те сервисы, которые нужны этому проекту: база, хранилище, почта, SMS, хостинг, домен.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "provider"],
          properties: {
            role: { type: "string", description: "Роль: database, storage, email, sms, hosting, domain." },
            provider: { type: "string", description: "Выбранный провайдер или продукт." },
            note: { type: "string", description: "Короткая деталь: план, регион, назначение." },
          },
        },
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        description: "Полный упорядоченный список шагов развёртывания.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string", description: "Короткий конкретный шаг, видимый пользователю." },
            status: { type: "string", enum: ["pending", "in_progress", "done", "blocked", "skipped"] },
            note: { type: "string", description: "Что сделано, где создано, что осталось, ссылка на документацию." },
          },
        },
      },
    },
  },
  execute: async (input, context) => {
    const parsed = planSchema.parse(input ?? {});
    const sandbox = await getSandbox(context.projectId, context.userId);
    const plan = await writeDeployPlan(sandbox.root, parsed);
    return {
      ok: true,
      ...compactPlan(plan),
      note:
        "План сохранён в " + DEPLOY_PLAN_FILE + ". Дальше работай по нему: шаг in_progress — текущий, done не переделывай. " +
        "После каждого проверенного шага отправь полный список снова. Для шага, который требует пользователя, поставь blocked, " +
        "напиши точное действие в кабинете и ссылку на документацию. Доступ к провайдеру запрашивай через access.request, " +
        "переменные самого приложения — через secrets.request.",
    };
  },
});

registerTool({
  name: "deploy.status",
  description:
    "Read the durable deployment plan from `" + DEPLOY_PLAN_FILE + "`: goal, target, chosen services, every step with its status, progress, the current step and what is blocked. " +
    "Call it first when the user asks to deploy, publish or continue a deployment; on a new chat; after a reload or an interrupted run; and before creating or reusing any deployment resource. " +
    "If the file does not exist, say so and build the plan with deploy.plan before touching the provider. " +
    "A step marked done means the resource already exists — reuse it instead of creating a second one.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  execute: async (_input, context) => {
    const sandbox = await getSandbox(context.projectId, context.userId);
    const plan = await readDeployPlan(sandbox.root);
    if (!plan.exists) {
      return {
        exists: false,
        file: DEPLOY_PLAN_FILE,
        hint: "Плана развёртывания пока нет. Если пользователь просит развернуть проект, сначала составь полный план через deploy.plan, затем создавай ресурсы.",
      };
    }
    return {
      ...compactPlan(plan),
      summary: deployPlanNotice(plan),
      hint: plan.complete
        ? "План выполнен. Не создавай ресурсы заново и не удаляй их без явной просьбы; для изменения развёртывания сначала прочитай, что уже сделано."
        : "Продолжай с шага in_progress или со следующего pending. BLOCKED требует действия пользователя: назови точный кабинет и ссылку на документацию, затем запроси доступ через access.request (провайдер) или ключ приложения через secrets.request.",
    };
  },
});
