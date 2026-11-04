import type { AgentMode } from "../types.js";

/**
 * Набор схем инструментов, который получает модель в одном запуске.
 *
 * Раньше каждый шаг отправлял все зарегистрированные инструменты: 72 схемы, около 69 000
 * символов. Почти половина из них относится к деплою, облакам, доменам и мобильным сборкам и
 * обычной правке кода не нужна. Здесь набор выбирается один раз на запуск: он остаётся
 * стабильным для кэша префикса DeepSeek и не раздувает каждый следующий шаг.
 *
 * Это не замена проверкам безопасности: `executeTool` всё равно откажет в инструменте, которого
 * нет в этом наборе, а планировщик дополнительно запрещает изменения.
 */

const CORE_TOOLS = [
  "project.list_files", "project.stat",
  "fs.list", "fs.read", "fs.write", "fs.edit", "fs.rename", "fs.delete", "fs.grep", "fs.outline",
  "terminal.exec", "terminal.start", "terminal.tail", "terminal.stop", "terminal.jobs",
  "npm.install", "pip.install",
  "git.status", "git.diff", "git.log", "git.branch", "git.pull", "git.add", "git.commit",
  "preview.start", "preview.stop", "preview.status", "preview.logs",
  "project.verify", "project.check", "project.assets",
  // Эти инструменты нужны обычной задаче, а не только деплою: системный промпт прямо
  // требует net.request/net.download для внешних API и файлов, database.status — перед
  // написанием хранения, service.status — перед просьбой о ключе интеграции.
  "net.request", "net.download",
  "database.status", "database.env",
  "service.status", "service.env", "service.secrets",
  "browser.open", "browser.inspect",
  "image.inspect", "image.generate",
  "note.remember", "note.find", "chat.history",
  "plan.update", "question.ask", "design.theme", "secrets.request",
  "agent.scout",
] as const;

/** Инструменты, которые подключаются только когда пользователь включил поиск. */
const WEB_TOOLS = ["web.search", "web.read"] as const;
/** Chromium дорогой и запускается только по явному переключателю. */
const BROWSER_TOOLS = ["browser.runtime", "browser.scenario", "browser.screenshot", "browser.perf"] as const;
/** Деплой, облака, домены, базы и сервисы — отдельная группа по смыслу задачи. */
const DEPLOY_PREFIXES = ["deploy.", "domain.", "cloud.", "yandex.", "service.", "database."] as const;
const DEPLOY_TOOLS = ["access.request"] as const;
/** Expo нужен только мобильному проекту, а не обычному лендингу. */
const MOBILE_PREFIX = "expo.";

/**
 * Инструменты, которые планировщик не должен даже видеть в схемах. Сервер всё равно откажет
 * в изменении, но не показывать их модели — дешевле и меньше соблазна.
 */
const PLANNER_FORBIDDEN = new Set([
  "fs.write", "fs.edit", "fs.rename", "fs.delete",
  "npm.install", "pip.install", "net.download", "database.env", "service.env",
  "git.pull", "git.add", "git.commit",
  "preview.start", "preview.stop", "project.check", "image.generate",
  "secrets.request", "access.request", "deploy.plan", "cloud.request", "domain.request",
]);

const DEPLOY_RE = /(депло|deploy|хостинг|hosting|домен|domain|dns|ssl|сервер|vps|облак|cloud|yandex|яндекс|s3|storage|хранилищ|почт|email|smtp|оплат|payment|stripe|юkassa|подключ|интеграц|база данных|database|postgres|mysql|mongo|redis)/i;
const MOBILE_RE = /(expo|react native|мобильн|android|ios)/i;

export type ToolCatalogOptions = {
  mode: AgentMode;
  task?: string;
  webSearch?: boolean;
  browserCheck?: boolean;
};

function isDeployTool(name: string) {
  return DEPLOY_PREFIXES.some(prefix => name.startsWith(prefix)) || (DEPLOY_TOOLS as readonly string[]).includes(name);
}

function isMobileTool(name: string) {
  return name.startsWith(MOBILE_PREFIX);
}

/**
 * Возвращает имена инструментов для запуска. Набор стабилен до конца запуска; задача и
 * переключатели влияют только на его состав, а не на порядок.
 */
export function selectToolNames(options: ToolCatalogOptions): string[] {
  const task = options.task ?? "";
  const deploy = DEPLOY_RE.test(task);
  const mobile = MOBILE_RE.test(task);
  const planner = options.mode === "planner";
  const names: string[] = [
    ...CORE_TOOLS,
    ...(options.webSearch ? WEB_TOOLS : []),
    ...(options.browserCheck ? BROWSER_TOOLS : []),
  ];
  // Дополнительные группы добавляются после ядра, чтобы порядок схем оставался предсказуемым.
  if (deploy) names.push("deploy.plan", "deploy.status", "deploy.check", "access.request");
  // Остальные инструменты групп находятся по префиксу в полном реестре: так новая команда
  // внутри уже выбранной группы не потеряется из-за забытого списка.
  const fromRegistry = (name: string) => {
    if (isDeployTool(name)) return deploy;
    if (isMobileTool(name)) return mobile;
    return false;
  };
  // `getToolDefinitionsFor` сам отфильтрует имена, которых нет в реестре; здесь важно только
  // сохранить стабильный порядок и не включать чужие группы.
  for (const name of [
    "deploy.plan", "deploy.status", "deploy.check",
    "domain.check", "domain.list", "domain.request",
    "cloud.status", "cloud.request", "cloud.catalog",
    "yandex.status", "yandex.resources", "yandex.request",
    "service.status", "service.env", "service.secrets",
    "database.status", "database.env",
    "access.request",
    "expo.status", "expo.setup", "expo.build", "expo.build_status",
  ]) {
    if (!fromRegistry(name)) continue;
    names.push(name);
  }
  const unique = [...new Set(names)];
  return planner ? unique.filter(name => !PLANNER_FORBIDDEN.has(name)) : unique;
}

/**
 * Для тестов и наблюдаемости: сколько символов занимает выбранный набор. Это не точные токены —
 * коэффициент остаётся тем же, что у бюджета контекста.
 */
export function toolCatalogChars(names: readonly string[]): number {
  return names.reduce((sum, name) => sum + name.length, 0);
}
