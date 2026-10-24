import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { detectProject, type ProjectShape } from "../preview/project-kind.js";

/**
 * Что квиз развёртывания знает о проекте до первого вопроса.
 *
 * Тип проекта не спрашивается у человека, если его можно определить: структура и зависимости
 * отвечают на это точнее. Одна ось «статика / сервер» этого не описывает — статический фронтенд
 * может жить в Object Storage, а его API, оплата и рассылка — в Cloud Functions, с базой и
 * секретами. Поэтому профиль описывает две вещи отдельно: чем отдаётся фронтенд и что выполняет
 * бэкенд. Вопросы остаются только там, где выбор действительно принадлежит пользователю — где
 * размещать, какой домен, какие сервисы нужны.
 *
 * Манифесты читаются не только в корне: у функций и у сервера часто свой package.json или
 * requirements.txt (`functions/`, `server/`, `api/`). Без этого сайт с Cloud Functions выглядел
 * бы «готовой статикой без базы и оплаты», хотя всё это у него есть.
 */

const MAX_MANIFEST_CHARS = 20_000;
const MANIFEST_FILES = ["requirements.txt", "pyproject.toml", "Pipfile"];
const ENV_EXAMPLE_NAMES = [".env.example", ".env.sample"];
/** Каталоги, где обычный проект держит API, функции или сервер. Читаются на один уровень. */
const NESTED_DIRS = [
  "functions",
  "cloud-functions",
  "api",
  "server",
  "backend",
  "src/functions",
  "src/api",
  "netlify/functions",
  "vercel/api",
];
/** Внутри functions/ не читаем зависимости и сборку: там тысячи каталогов, а не функции. */
const NESTED_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const MAX_NESTED_FUNCTION_DIRS = 16;
const FUNCTION_CONFIG_FILES = ["serverless.yml", "serverless.yaml", "netlify.toml", "vercel.json"];
const FUNCTION_PACKAGES = /(^|\/)(@yandex-cloud\/functions-framework|@google-cloud\/functions-framework|@azure\/functions|@netlify\/functions|firebase-functions|serverless|@vercel\/node|aws-lambda)$/i;
const SERVER_PACKAGES = new Set([
  "express", "fastify", "koa", "hono", "nest", "@nestjs/core", "socket.io", "ws",
  "hapi", "@hapi/hapi", "restify", "polka", "next", "nuxt", "remix", "@remix-run/node",
]);
const PYTHON_SERVER = new Set([
  "fastapi", "flask", "django", "uvicorn", "gunicorn", "starlette", "aiohttp",
  "streamlit", "gradio", "tornado", "bottle",
]);
const HANDLER_FILES = /^(index|handler|main|function)\.(js|mjs|cjs|ts|py)$/i;
const SERVER_SCRIPT = /^\s*(node|tsx|ts-node|nodemon|next|nuxt|remix|uvicorn|gunicorn|python3?|streamlit|flask|deno|bun)\b/;
const SSR_FRAMEWORKS = new Set(["Next.js", "Nuxt", "SvelteKit", "Remix"]);

export type DeploymentNeed = "database" | "storage" | "email" | "sms" | "payments" | "ai" | "maps" | "crm";
export type DeploymentNeeds = Record<DeploymentNeed, boolean>;

export type DeploymentFrontend = "static" | "ssr" | "unknown";
export type DeploymentBackend = "none" | "functions" | "server" | "unknown";
export type DeploymentArchitecture = "static" | "static-functions" | "functions" | "server" | "unknown";

export type DeploymentFunctionDir = {
  /** `functions`, `api` или `.` для функций в корне проекта. */
  path: string;
  runtime: "node" | "python" | "unknown";
  evidence: string[];
};

export type DeploymentProjectType = {
  /** Одна из готовых архитектур — по ней квиз строит шаги и варианты размещения. */
  id: DeploymentArchitecture;
  frontend: DeploymentFrontend;
  backend: DeploymentBackend;
  /** Результат превью-классификатора; полезен как дополнительное доказательство. */
  shape: ProjectShape["kind"];
  label: string;
  reason: string;
  evidence: string[];
  framework: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  /** Где лежит код функций: из этого агент строит шаги развёртывания. */
  functions: DeploymentFunctionDir[];
  /** Где лежит серверная часть, если она не в корне. */
  serverDir: string | null;
};

export type DeploymentProfile = {
  projectType: DeploymentProjectType;
  needs: DeploymentNeeds;
  /** Что именно выдало потребность — видно в интерфейсе рядом с галочкой. */
  needsEvidence: Partial<Record<DeploymentNeed, string[]>>;
  /**
   * Сервисы каталога, которые проект уже называет в зависимостях или .env.example.
   * Из этого квиз выбирает Postbox вместо первого сервиса почты и Robokassa вместо первого
   * сервиса оплаты: пользователю не нужно узнавать провайдера, который и так есть в проекте.
   */
  serviceIds: string[];
};

const NEED_PACKAGES: Record<DeploymentNeed, RegExp> = {
  database: /(^|\/)(pg|postgres|postgresql|mysql|mysql2|mongodb|mongoose|prisma|@prisma\/client|drizzle-orm|drizzle-kit|kysely|sequelize|typeorm|ioredis|redis|better-sqlite3|sqlite3|@ydbjs\/[a-z-]+|psycopg2?(?:-binary)?|asyncpg|sqlalchemy|pymongo|motor|redis|alembic)$/i,
  storage: /(^|\/)(@aws-sdk\/client-s3|aws-sdk|minio|@yandex-cloud\/storage|@google-cloud\/storage)$/i,
  email: /(^|\/)(nodemailer|notisend|@notisend\/[a-z-]+|resend|postmark|@sendgrid\/mail|mailgun|mailgun-js|unisender|sendsay|rusender)$/i,
  sms: /(^|\/)(twilio|smsru|smsaero|@smsc\/[a-z-]+|turbosms)$/i,
  payments: /(^|\/)(yookassa|@yookassa\/[a-z-]+|stripe|cloudpayments|tinkoff|robokassa|paypal)$/i,
  ai: /(^|\/)(openai|@anthropic-ai\/sdk|anthropic|groq-sdk|@google\/generative-ai|mistralai|ollama|@mistralai\/[a-z-]+)$/i,
  maps: /(^|\/)(mapbox-gl|@mapbox\/[a-z-]+|@pbe\/react-yandex-maps|ymaps|@googlemaps\/[a-z-]+|leaflet)$/i,
  crm: /(^|\/)(bitrix24|@bitrix24\/[a-z-]+|amocrm-js|@amocrm\/[a-z-]+)$/i,
};

const NEED_ENV: Record<DeploymentNeed, RegExp> = {
  database: /(^|_)(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGODB_URI|MONGO_URL|REDIS_URL|YDB_CONNECTION_STRING)($|_)/i,
  storage: /(^|_)S3_(ENDPOINT|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY)($|_)/i,
  email: /(^|_)(SMTP_|MAIL_|NOTISEND|SENDSAY|RUSENDER|UNISENDER|POSTBOX)/i,
  sms: /(^|_)(SMS_|TWILIO_)/i,
  payments: /(^|_)(YOOKASSA|CLOUDPAYMENTS|ROBOKASSA|TBANK|STRIPE)/i,
  ai: /(^|_)(OPENAI|ANTHROPIC|GROQ|GEMINI|MISTRAL|DEEPSEEK|OPENROUTER|AI_API_KEY)/i,
  maps: /(^|_)(YANDEX_MAPS|MAPBOX|GOOGLE_MAPS|MAPS_API_KEY)/i,
  crm: /(^|_)(BITRIX|AMOCRM|CRM_)/i,
};

/**
 * Подсказки сервисов каталога по тому, что проект уже использует. Категория важна: `yandex`
 * в адресе бакета не должен превращаться в Yandex AI, а `tinkoff` в зависимостях — в облако.
 */
const SERVICE_HINTS: Partial<Record<DeploymentNeed, Array<{ id: string; pattern: RegExp }>>> = {
  storage: [
    { id: "selectel-storage", pattern: /selectel/i },
    { id: "vk-storage", pattern: /vk\s*cloud|vkcloud|vkcs|ru-msk\.vkcloud/i },
    { id: "yandex-storage", pattern: /yandex\s*cloud|yandexcloud|yc[_-]?storage/i },
    { id: "timeweb-storage", pattern: /timeweb|twcstorage/i },
    { id: "cloudru-storage", pattern: /cloud\.ru|cloudru/i },
  ],
  email: [
    { id: "yandex-postbox", pattern: /postbox/i },
    { id: "notisend", pattern: /notisend/i },
    { id: "sendsay", pattern: /sendsay/i },
    { id: "rusender", pattern: /rusender/i },
    { id: "unisender", pattern: /unisender/i },
  ],
  payments: [
    { id: "robokassa", pattern: /robokassa/i },
    { id: "yookassa", pattern: /yookassa|yoo[_-]?kassa/i },
    { id: "cloudpayments", pattern: /cloudpayments/i },
    { id: "tbank-payments", pattern: /tbank|tinkoff|t-bank/i },
  ],
  ai: [
    { id: "gigachat", pattern: /gigachat/i },
    { id: "yandex-ai", pattern: /yandexgpt|yandex[_-]?ai|ai[_-]?studio/i },
  ],
  maps: [
    { id: "yandex-maps", pattern: /yandex[_-]?maps|ymaps|api-maps\.yandex/i },
    { id: "2gis", pattern: /2gis|twogis/i },
  ],
  crm: [
    { id: "retailcrm", pattern: /retailcrm/i },
    { id: "bitrix24", pattern: /bitrix/i },
    { id: "amocrm", pattern: /amocrm|amo[_-]?crm/i },
  ],
};

const FRAMEWORKS: Array<[RegExp, string]> = [
  [/^next$/, "Next.js"],
  [/^nuxt$/, "Nuxt"],
  [/^@sveltejs\/kit$/, "SvelteKit"],
  [/^astro$/, "Astro"],
  [/^@remix-run\/node$/, "Remix"],
  [/^vite$/, "Vite"],
  [/^@angular\/core$/, "Angular"],
  [/^react$/, "React"],
  [/^vue$/, "Vue"],
  [/^express$/, "Express"],
  [/^fastify$/, "Fastify"],
  [/^@nestjs\/core$/, "NestJS"],
  [/^django$/, "Django"],
  [/^flask$/, "Flask"],
  [/^fastapi$/, "FastAPI"],
];

type NestedProject = {
  dir: string;
  entries: string[];
  packageJson: Record<string, unknown> | null;
  pythonText: string;
  envText: string;
  deps: string[];
  pythonDeps: string[];
  handlerFiles: string[];
  namedFunctions: boolean;
  function: boolean;
  server: boolean;
  evidence: string[];
};

async function readManifest(root: string, name: string) {
  const info = await stat(path.join(root, name)).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MANIFEST_CHARS) return "";
  return readFile(path.join(root, name), "utf8").catch(() => "");
}

function parsePackage(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

function packageDependencies(packageJson: Record<string, unknown> | null) {
  const deps = packageJson && typeof packageJson.dependencies === "object" && packageJson.dependencies
    ? Object.keys(packageJson.dependencies as Record<string, unknown>)
    : [];
  const devDeps = packageJson && typeof packageJson.devDependencies === "object" && packageJson.devDependencies
    ? Object.keys(packageJson.devDependencies as Record<string, unknown>)
    : [];
  return [...deps, ...devDeps];
}

function envNames(example: string) {
  return example
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#") && line.includes("="))
    .map(line => line.slice(0, line.indexOf("=")).trim())
    .filter(Boolean);
}

/**
 * Имена Python-зависимостей из requirements/pyproject. Строка манифеста — это не имя пакета:
 * версия, extras и маркеры среды отбрасываются, подчёркивания приводятся к дефису, как в PyPI.
 * Без этого `psycopg2-binary==2.9` не совпадал с шаблоном, и серверный Python-проект выглядел
 * как проект без базы.
 */
function pythonDependencies(text: string) {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#") && !line.startsWith("["))
    .map(line => line.replace(/^["']|["']$/g, ""))
    .map(line => line.split(/[<>=!~;\[\s]/)[0]?.trim().toLowerCase().replace(/_/g, "-") ?? "")
    .filter(Boolean);
}

function firstFramework(deps: string[]) {
  for (const [pattern, name] of FRAMEWORKS) {
    if (deps.some(dep => pattern.test(dep))) return name;
  }
  return null;
}

function stringScript(packageJson: Record<string, unknown> | null, name: string) {
  const scripts = packageJson && typeof packageJson.scripts === "object" && packageJson.scripts
    ? packageJson.scripts as Record<string, unknown>
    : {};
  const value = scripts[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

/** Читает манифесты и признаки функций/сервера во вложенных каталогах — на один уровень. */
async function readNestedProjects(root: string): Promise<NestedProject[]> {
  const projects: NestedProject[] = [];
  // Функции часто лежат не манифестом в `functions/`, а на уровень глубже:
  // `functions/api/package.json` — свой деплой-юнит со своими зависимостями. Без этого
  // сайт с оплатой, базой и рассылкой в такой функции выглядел бы готовой статикой.
  const nestedDirs = [...NESTED_DIRS];
  let extraDirs = 0;
  for (const parent of ["functions", "cloud-functions", "src/functions", "netlify/functions"]) {
    const children = await readdir(path.join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (extraDirs >= MAX_NESTED_FUNCTION_DIRS) break;
      if (!child.isDirectory() || NESTED_SKIP.has(child.name)) continue;
      nestedDirs.push(parent + "/" + child.name);
      extraDirs += 1;
    }
  }
  for (const dir of unique(nestedDirs)) {
    const full = path.join(root, dir);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;
    const entries = await readdir(full).catch(() => []);
    const packageJson = parsePackage(await readManifest(full, "package.json"));
    const pythonText = (await Promise.all(MANIFEST_FILES.map(name => readManifest(full, name)))).join("\n");
    const envText = (await Promise.all(ENV_EXAMPLE_NAMES.map(name => readManifest(full, name)))).join("\n");
    const handlerFiles = entries.filter(name => HANDLER_FILES.test(name));
    if (!packageJson && !pythonText.trim() && !envText.trim() && !handlerFiles.length) continue;

    const deps = packageDependencies(packageJson);
    const pythonDeps = pythonDependencies(pythonText);
    const namedFunctions = /(^|\/)functions?$/i.test(dir);
    // Вложенный каталог внутри functions/ — это функция, даже если он называется api и в нём
    // нет functions-framework: express внутри функции остаётся функцией.
    const underFunctions = /^(functions|cloud-functions|src\/functions|netlify\/functions)\//.test(dir);
    const functionDeps = deps.some(dep => FUNCTION_PACKAGES.test(dep)) || pythonDeps.includes("functions-framework");
    // `api` у Vercel и подобных — это функции даже без своего package.json: файл-обработчик
    // лежит прямо в каталоге и экспортирует функцию.
    const functionDir = functionDeps
      || underFunctions
      || (namedFunctions && handlerFiles.length > 0)
      || (dir === "api" && handlerFiles.length > 0)
      || (dir === "vercel/api" && handlerFiles.length > 0);
    const start = stringScript(packageJson, "start") ?? stringScript(packageJson, "serve") ?? stringScript(packageJson, "dev");
    // У каталога функций `start` обычно запускает локальный вызов функции, а не сервер, а
    // express внутри функции — это всё ещё функция. Поэтому functions-подобный каталог не
    // считается сервером, даже если его обработчик использует express или FastAPI.
    const functionLike = functionDeps || namedFunctions || underFunctions;
    // Каталог `api` с файлом-обработчиком — это функция даже при express внутри: именно так
    // выглядят Vercel- и Yandex-функции. Без явного `!functionDir` такой каталог попадал в
    // nestedServer и весь сайт считался серверным приложением.
    const server = !functionDir && !functionLike && (
      deps.some(dep => SERVER_PACKAGES.has(dep))
      || pythonDeps.some(dep => PYTHON_SERVER.has(dep))
      || Boolean(start && SERVER_SCRIPT.test(start))
    );

    projects.push({
      dir,
      entries,
      packageJson,
      pythonText,
      envText,
      deps,
      pythonDeps,
      handlerFiles,
      namedFunctions,
      function: functionDir,
      server,
      evidence: unique([
        ...(packageJson ? [dir + "/package.json"] : []),
        ...(pythonText.trim() ? [dir + "/requirements.txt"] : []),
        ...handlerFiles.slice(0, 2).map(file => dir + "/" + file),
      ]),
    });
  }
  return projects;
}

function architectureLabel(id: DeploymentArchitecture, frontend: DeploymentFrontend) {
  if (id === "static") return "Статический сайт";
  if (id === "static-functions") return "Статический сайт + Cloud Functions";
  if (id === "functions") return frontend === "ssr" ? "Приложение на Cloud Functions" : "API на Cloud Functions";
  if (id === "server") {
    if (frontend === "static") return "Статический фронтенд + сервер";
    if (frontend === "ssr") return "Приложение с сервером (SSR)";
    return "Приложение с сервером";
  }
  return "Тип проекта нужно подтвердить";
}

export async function readDeploymentProfile(root: string): Promise<DeploymentProfile> {
  const shape = await detectProject(root);
  const packageJson = parsePackage(await readManifest(root, "package.json"));
  const pythonText = (await Promise.all(MANIFEST_FILES.map(name => readManifest(root, name)))).join("\n");
  const envText = (await Promise.all(ENV_EXAMPLE_NAMES.map(name => readManifest(root, name)))).join("\n");
  const nested = await readNestedProjects(root);

  const rootDeps = packageDependencies(packageJson);
  const rootPythonDeps = pythonDependencies(pythonText);
  const rootEnv = envNames(envText);
  const rootFunctionDeps = rootDeps.some(dep => FUNCTION_PACKAGES.test(dep)) || rootPythonDeps.includes("functions-framework");
  const rootServerDeps = rootDeps.some(dep => SERVER_PACKAGES.has(dep)) || rootPythonDeps.some(dep => PYTHON_SERVER.has(dep));
  const rootStart = stringScript(packageJson, "start") ?? stringScript(packageJson, "serve");
  const rootServer = shape.kind === "node-runtime" || shape.kind === "python-runtime" || rootServerDeps || Boolean(rootStart && SERVER_SCRIPT.test(rootStart));

  // Конфигурация serverless-провайдера сама по себе доказывает функции, даже если манифест
  // лежит не рядом с обработчиком.
  const functionConfigs: string[] = [];
  for (const name of FUNCTION_CONFIG_FILES) {
    const text = await readManifest(root, name);
    if (text.trim() && /function|serverless|api\//i.test(text)) functionConfigs.push(name);
  }

  const nestedServer = nested.find(project => project.server) ?? null;
  const functionProjects = nested.filter(project => project.function);

  // Явный functions-framework сильнее express внутри той же функции: на Yandex Cloud такой
  // express-обработчик всё равно запускается функцией, а не долгоживущим сервером.
  let backend: DeploymentBackend = "none";
  if (nestedServer) backend = "server";
  else if (rootFunctionDeps || functionProjects.length || functionConfigs.length) backend = "functions";
  else if (rootServer || rootServerDeps) backend = "server";

  const hasStatic = shape.kind === "instant-site" || shape.kind === "static-build";
  const allDeps = [...rootDeps, ...nested.flatMap(project => project.deps)];
  const allPythonDeps = [...rootPythonDeps, ...nested.flatMap(project => project.pythonDeps)];
  const framework = firstFramework(allDeps)
    ?? ["Django", "Flask", "FastAPI", "Streamlit"].find(name => allPythonDeps.includes(name.toLowerCase()))
    ?? null;
  const frontend: DeploymentFrontend = hasStatic ? "static" : framework && SSR_FRAMEWORKS.has(framework) ? "ssr" : "unknown";

  const id: DeploymentArchitecture = backend === "server"
    ? "server"
    : backend === "functions"
      ? frontend === "static" ? "static-functions" : "functions"
      : frontend === "static" ? "static" : "unknown";

  const serverDir = backend === "server" ? (nestedServer?.dir ?? (rootServer ? "." : null)) : null;
  const functionDirs: DeploymentFunctionDir[] = functionProjects.map(project => ({
    path: project.dir,
    runtime: project.packageJson ? "node" : project.pythonText.trim() ? "python" : "unknown",
    evidence: project.evidence,
  }));
  if ((rootFunctionDeps || functionConfigs.length) && !functionDirs.some(entry => entry.path === ".")) {
    functionDirs.unshift({
      path: ".",
      runtime: packageJson ? "node" : pythonText.trim() ? "python" : "unknown",
      evidence: unique([
        ...(rootFunctionDeps ? ["package.json · functions-framework"] : []),
        ...functionConfigs,
      ]),
    });
  }

  const needsEvidence: DeploymentProfile["needsEvidence"] = {};
  const needs: DeploymentNeeds = { database: false, storage: false, email: false, sms: false, payments: false, ai: false, maps: false, crm: false };
  const depSources = [
    ...rootDeps.map(dep => ({ dep, source: "" })),
    ...nested.flatMap(project => project.deps.map(dep => ({ dep, source: project.dir + "/package.json · " }))),
  ];
  const pythonSources = [
    ...rootPythonDeps.map(dep => ({ dep, source: "" })),
    ...nested.flatMap(project => project.pythonDeps.map(dep => ({ dep, source: project.dir + "/requirements.txt · " }))),
  ];
  const envSources = [
    ...rootEnv.map(name => ({ name, source: "" })),
    ...nested.flatMap(project => envNames(project.envText).map(name => ({ name, source: project.dir + "/.env.example · " }))),
  ];
  for (const need of Object.keys(needs) as DeploymentNeed[]) {
    const fromPackages = depSources.filter(item => NEED_PACKAGES[need].test(item.dep)).map(item => item.source + item.dep);
    const fromPython = pythonSources.filter(item => NEED_PACKAGES[need].test(item.dep)).map(item => item.source + item.dep);
    const fromEnv = envSources.filter(item => NEED_ENV[need].test(item.name)).map(item => item.source + item.name);
    const evidence = unique([...fromPackages, ...fromPython, ...fromEnv]).slice(0, 4);
    if (evidence.length) {
      needs[need] = true;
      needsEvidence[need] = evidence;
    }
  }

  const reasonParts = [shape.reason];
  if (backend === "functions" && functionDirs.length) {
    reasonParts.push("функции: " + functionDirs.map(entry => entry.path === "." ? "корень проекта" : entry.path).join(", "));
  }
  if (backend === "server" && serverDir && serverDir !== ".") reasonParts.push("сервер: " + serverDir);
  if (functionConfigs.length) reasonParts.push("конфигурация: " + functionConfigs.join(", "));

  const buildCommand = stringScript(packageJson, "build");
  const startCommand = stringScript(packageJson, "start") ?? stringScript(packageJson, "serve");

  // Подсказки ищем и в именах переменных, и в значениях .env.example: адрес бакета
  // `storage.yandexcloud.net` называет провайдера так же точно, как POSTBOX_SMTP_HOST.
  const hintText = [
    ...allDeps,
    ...allPythonDeps,
    envText,
    ...nested.map(project => project.envText),
  ].join("\n");
  const serviceIds = unique(
    (Object.keys(needs) as DeploymentNeed[]).flatMap(need =>
      needs[need] && SERVICE_HINTS[need]
        ? SERVICE_HINTS[need]!.filter(hint => hint.pattern.test(hintText)).map(hint => hint.id)
        : [],
    ),
  );

  return {
    projectType: {
      id,
      frontend,
      backend,
      shape: shape.kind,
      label: architectureLabel(id, frontend),
      reason: reasonParts.join("; "),
      evidence: unique([
        ...shape.evidence,
        ...nested.flatMap(project => project.evidence),
        ...functionConfigs,
        ...(rootFunctionDeps ? ["package.json · functions-framework"] : []),
      ]).slice(0, 12),
      framework,
      buildCommand,
      startCommand,
      functions: functionDirs.slice(0, 6),
      serverDir,
    },
    needs,
    needsEvidence,
    serviceIds,
  };
}
