import { planAllows } from "../account/entitlements.js";
import type { PlanId } from "../account/plans.js";

/**
 * Что агент должен знать о хостинге до первого шага.
 *
 * Без этой заметки модель видит только запрос пользователя и проект: на «Плюсе» она могла начать
 * с Express/Next, получить отказ build-guard и потратить шаг на выяснение причины. Заметка
 * называет доступную архитектуру заранее и даёт точный контракт функций, чтобы лендинг можно
 * было доращивать оплатой и доставкой без постоянного сервера.
 *
 * Публикация остаётся действием пользователя в панели: у агента нет инструмента публикации.
 */
export function hostingPlanNotice(plan: PlanId | undefined): string {
  if (!plan) return "";
  const functions = planAllows(plan, "serverlessFunctions");
  const background = planAllows(plan, "backgroundJobs");
  const container = planAllows(plan, "containerPreview");
  const lines = [
    "HOSTING CAPABILITIES FOR THIS RUN.",
    "Production hosting on this platform serves static files and optional serverless functions. A permanent server process (Express/Next/Nuxt listening on a port) is not a production hosting target.",
    functions
      ? "This plan allows static hosting AND serverless functions. When the product needs server-side behavior — payments, delivery calculation, webhooks, secrets, order storage — build a static frontend and short-lived functions behind /api/*. Do not create a long-running Express/Next/Nuxt server."
      : "This plan allows static hosting only. Do not create server code, API handlers, Express/Next/Nuxt servers, Dockerfiles for a server, or a functions manifest. If the request needs payments, delivery or other server-side work, say that it requires the «Плюс» plan.",
    background
      ? "This plan also allows background jobs: declare them in the jobs array of nestdev.functions.json and return {jobs:[{name,payload,idempotencyKey}]} from an HTTP function. Jobs run after the response in the same isolated executor and are limited to 60 seconds and 512 MB. Do not use them for video, OCR or permanent workers."
      : "Background jobs are not available on this plan: only short HTTP functions. Do not declare a jobs array in nestdev.functions.json.",
    container
      ? "Container preview is available for local development only; it does not change the production hosting model."
      : "Container preview is not available on this plan.",
    functions
      ? "Functions contract: nestdev.functions.json in the project root, version 1, runtime \"node\", and a list of {name, path, methods, handler}. path must start with /api/. handler is \"path/inside/project.ts#exportName\". The handler receives {method, path, query, headers, body: Buffer} and returns a string/Buffer, {status, headers, body}, or a Response. It must not listen on a port, keep state between requests, or write to the project directory. Read secrets from process.env; they are supplied only at invocation."
      : "",
    "A static landing can grow incrementally: keep its files, add only the functions needed for the new feature, and publish static files and functions together. The user publishes from the hosting panel; when the code is ready, say what should be published.",
  ];
  return lines.filter(Boolean).join(" ");
}
