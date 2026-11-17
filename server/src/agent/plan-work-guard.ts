import { accountPlanFor } from "../billing/store.js";
import { planAllows } from "../account/entitlements.js";
import { readDeploymentProfile } from "../deployment/profile.js";

/**
 * Что агенту разрешено собирать на тарифе.
 *
 * «Старт» и «Плюс» не получают контейнерный preview, поэтому сборка серверного проекта для них
 * бессмысленна: результат нельзя ни запустить, ни проверить. Отказ происходит до запуска
 * команды, а не после десяти минут `next build`. Статика и статика с serverless-функциями
 * разрешены: их отдаёт статический хостинг, а функции — одноразовый исполнитель.
 *
 * Это защита от случайной сборки, а не песочница: агент по-прежнему может править файлы.
 * Проверка намеренно смотрит только на команды сборки/запуска, чтобы не запрещать тесты,
 * линтеры и чтение проекта.
 */

const SERVER_COMMAND = new RegExp(
  [
    // package-manager scripts
    String.raw`(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|dev|start|serve|preview)\b`,
    // framework CLIs, включая вызов через npx/локальный bin: `npx next build` — та же сборка
    String.raw`(?:^|[;&|]\s*|\s)(?:next|nuxt|remix|astro|svelte-kit|vite)\s+(?:build|dev|preview|start)\b`,
    String.raw`(?:^|[;&|]\s*|\s)(?:npx|bunx|npm\s+exec|pnpm\s+exec|yarn\s+exec)\s+(?:next|nuxt|remix|astro|svelte-kit|vite)\s+(?:build|dev|preview|start)\b`,
    String.raw`(?:^|[;&|]\s*|\s)(?:[^\s]*\/)?node_modules\/\.bin\/(?:next|nuxt|remix|astro|svelte-kit|vite)\s+(?:build|dev|preview|start)\b`,
    // direct server entry points
    String.raw`(?:^|[;&|]\s*|\s)(?:node|tsx|ts-node|nodemon|deno|bun)\s+(?!--test\b)(?:--?[^\s]+\s+)*[^\s]+\.(?:js|mjs|cjs|ts)\b`,
    // Python app servers
    String.raw`(?:^|[;&|]\s*|\s)(?:uvicorn|gunicorn|flask|streamlit|python3?|fastapi)\b`,
  ].join("|"),
  "i",
);

/**
 * Команды, которые поднимают долгоживущий dev/start/preview-сервер. На тарифах без
 * контейнерного preview их нельзя запускать даже для статического проекта: preview.start
 * соберёт файлы и отдаст их сам, а отдельный процесс только займёт место в песочнице.
 * `npm run build` сюда намеренно не входит.
 */
const DEV_SERVER_COMMAND = new RegExp(
  [
    String.raw`(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b`,
    String.raw`(?:^|[;&|]\s*|\s)(?:next|nuxt|remix|astro|svelte-kit|vite)\s+(?:dev|preview|start)\b`,
    String.raw`(?:^|[;&|]\s*|\s)(?:npx|bunx|npm\s+exec|pnpm\s+exec|yarn\s+exec)\s+(?:next|nuxt|remix|astro|svelte-kit|vite)\s+(?:dev|preview|start)\b`,
    String.raw`(?:^|[;&|]\s*|\s)(?:[^\s]*\/)?node_modules\/\.bin\/(?:next|nuxt|remix|astro|svelte-kit|vite)\s+(?:dev|preview|start)\b`,
    String.raw`(?:^|[;&|]\s*|\s)(?:uvicorn|gunicorn|flask|streamlit|fastapi)\b`,
    String.raw`(?:^|[;&|]\s*|\s)python3?\s+-m\s+(?:http\.server|SimpleHTTPServer)\b`,
  ].join("|"),
  "i",
);

export function isServerBuildCommand(command: string) {
  return SERVER_COMMAND.test(command);
}

export function isDevServerCommand(command: string) {
  return DEV_SERVER_COMMAND.test(command);
}

export type PlanWorkGuardResult = { allowed: true } | { allowed: false; reason: string };

export async function checkPlanCanBuildProject(input: {
  root: string;
  userId: string;
  command: string;
}): Promise<PlanWorkGuardResult> {
  if (!isServerBuildCommand(input.command)) return { allowed: true };
  const plan = await accountPlanFor(input.userId).catch(() => "free" as const);
  // Контейнерный preview — это и есть право запускать серверный проект. На «Премиуме» оно есть.
  if (planAllows(plan, "containerPreview")) return { allowed: true };
  if (isDevServerCommand(input.command)) {
    return {
      allowed: false,
      reason:
        "На этом тарифе контейнерный dev-сервер недоступен. Запускайте предпросмотр через preview.start: " +
        "он соберёт проект и отдаст статику. Команды сборки и тесты (npm run build, npm test) разрешены.",
    };
  }
  const profile = await readDeploymentProfile(input.root).catch(() => null);
  if (!profile || profile.projectType.backend !== "server") return { allowed: true };
  return {
    allowed: false,
    reason:
      "Тариф не позволяет собирать серверный проект: контейнерный preview доступен только на «Премиуме». " +
      "На этом тарифе агент собирает статику и serverless-функции. Уберите серверный запуск или перейдите на «Премиум».",
  };
}
