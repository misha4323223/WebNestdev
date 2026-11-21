import { planAllows } from "../account/entitlements.js";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";

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
  const name = PLAN_CATALOG[plan].name;
  const functions = planAllows(plan, "serverlessFunctions");
  const background = planAllows(plan, "backgroundJobs");
  const container = planAllows(plan, "containerPreview");
  const lines = [
    "HOSTING CAPABILITIES FOR THIS RUN. Current plan: «" + name + "» (" + plan + ").",
    "Production hosting on this platform serves static files and optional serverless functions. A permanent server process (Express/Next/Nuxt listening on a port) is not a production hosting target.",
    functions
      ? "This plan allows static hosting AND serverless functions. When the product needs server-side behavior — payments, delivery calculation, webhooks, secrets, order storage — build a static frontend and short-lived functions behind /api/*. Do not create a long-running Express/Next/Nuxt server."
      : "This plan allows static hosting only. Do not create server code, API handlers, Express/Next/Nuxt servers, Dockerfiles for a server, or a functions manifest. If the request needs payments, delivery or other server-side work, say that it requires the «Плюс» plan.",
    background
      ? "This plan also allows background jobs: declare them in the jobs array of nestdev.functions.json and return {jobs:[{name,payload,idempotencyKey}]} from an HTTP function. Jobs run after the response in the same isolated executor and are limited to 60 seconds and 512 MB. Do not use them for video, OCR or permanent workers."
      : functions
        ? "Background jobs are not available on this plan: only short HTTP functions. Do not declare a jobs array in nestdev.functions.json."
        : "Background jobs and serverless functions are not available on this plan. Do not declare a jobs array in nestdev.functions.json.",
    container
      ? "Preview: preview.start may use a container/hybrid development runtime on this plan, but it prefers hybrid. For a project with a frontend build and a separate API/server, make the split explicit in package.json.preview or let the detector save .webnestdev/preview.json; hybrid keeps the API and WebSocket working with much less load than a pure dev container. Use a pure container only when the project has one combined process, a whole-app server framework (Next/Nuxt/Remix without a static split), a persistent worker, or hybrid cannot start. Use preview.start after changes; never launch `npm run dev`, `next dev`, `vite dev`, `vite preview`, or another server through terminal.exec. Container preview does not change the production hosting model: production is still static files plus short-lived functions."
      : functions
        ? "Preview: preview.start builds and serves the static files, and executes the serverless functions declared in nestdev.functions.json in one preview container. The /api/* routes work in preview: test them with preview.start and project.verify before publishing; publishing is a separate step for the live site, not a prerequisite for testing functions. Container, hybrid and dev-server previews are unavailable: do not run `npm run dev`, `next dev`, `vite dev`, `vite preview`, or another server through terminal.exec."
        : "Preview: this plan is static only. preview.start builds once and serves the files; container, hybrid, and dev-server previews are unavailable. Do not create API handlers or a functions manifest on this plan. Do not run `npm run dev`, `next dev`, `vite dev`, `vite preview`, or another server through terminal.exec.",
    "Build contract: if the project already has a ready index.html, hosting needs no build script at all — do not add `scripts.build` only to satisfy publishing. If a build is genuinely required, it must produce index.html in dist, build or out. A static-functions project without a build script publishes its ready files and builds only the functions.",
    functions
      ? "Functions contract: nestdev.functions.json in the project root, version 1, runtime \"node\", and a list of {name, path, methods, handler}. path must start with /api/. handler is \"path/inside/project.ts#exportName\". The handler receives {method, path, query, headers, body: Buffer} and returns a string/Buffer, {status, headers, body}, or a Response. It must not listen on a port, keep state between requests, or write to the project directory. Read secrets from process.env; they are supplied only at invocation."
      : "",
    "A static landing can grow incrementally: keep its files, add only the functions needed for the new feature, and publish static files and functions together. The user publishes from the hosting panel; when the code is ready, say what should be published.",
  ];
  return lines.filter(Boolean).join(" ");
}
