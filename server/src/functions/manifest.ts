import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Контракт serverless-функций проекта.
 *
 * Явный манифест важнее автоопределения: по каталогам можно предложить миграцию, но публиковать
 * догадку нельзя. Здесь проверяется всё, что потом попадёт в маршрутизатор и сборщик, поэтому
 * ошибка manifests — это отказ публикации, а не «попробуем и посмотрим».
 *
 * Безопасность путей:
 * - маршрут живёт только под `/api/`;
 * - обработчик — относительный путь внутри проекта;
 * - `..`, абсолютные пути и обратные слэши запрещены до чтения файла.
 */

export const FUNCTIONS_MANIFEST_FILE = "nestdev.functions.json";
export const FUNCTIONS_MANIFEST_MAX_BYTES = 64 * 1024;
export const FUNCTIONS_MANIFEST_MAX_FUNCTIONS = 25;
export const FUNCTIONS_MANIFEST_MAX_JOBS = 10;

const FUNCTION_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const ROUTE = /^\/api(?:\/[A-Za-z0-9._~-]+)*$/;
const HANDLER_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function safeRoute(value: string) {
  if (!ROUTE.test(value)) return false;
  if (value === "/api") return true;
  return value.slice(5).split("/").every(segment => segment !== "." && segment !== "..");
}

const methodSchema = z.preprocess(
  value => typeof value === "string" ? value.toUpperCase() : value,
  z.enum(METHODS),
);

const routeSchema = z.string().trim().max(300).refine(safeRoute, {
  message: "Маршрут должен начинаться с /api/ и не содержать .., query, fragment и пустых сегментов",
});

const handlerSchema = z.string().trim().min(3).max(500).refine(value => {
  const [file, exportName, extra] = value.split("#");
  if (!file || !exportName || extra !== undefined) return false;
  if (file.startsWith("/") || file.startsWith("\\") || file.includes("\\")) return false;
  if (file.split("/").some(segment => segment === ".." || segment === "" || segment === ".")) return false;
  return HANDLER_EXPORT.test(exportName);
}, { message: "Обработчик задаётся как path/inside/project.ts#exportName" });

/**
 * Кеш ответа — только явный opt-in. По умолчанию функция не кешируется: заказ, корзина и
 * авторизация не должны получить чужой ответ из общего кеша. TTL ограничен сутками, чтобы
 * случайный `ttlSeconds` не превратил витрину в вечную статику.
 */
const cacheSchema = z.object({
  ttlSeconds: z.number().int().min(1).max(86_400),
}).strict();

const functionSchema = z.object({
  name: z.string().trim().regex(FUNCTION_NAME, "Имя функции: строчные латинские буквы, цифры и дефис, до 63 символов"),
  path: routeSchema,
  methods: z.array(methodSchema).min(1).max(METHODS.length).default(["GET"]),
  handler: handlerSchema,
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  memoryMb: z.number().int().min(128).max(1_024).default(256),
  cache: cacheSchema.optional(),
}).strict();

/**
 * Фоновое задание — тот же обработчик, но без HTTP-маршрута. Таймаут больше, чем у функции:
 * задача запускается после ответа и не держит клиента. Потолок 60 секунд оставляет запас
 * двум слотам на 2 vCPU и не превращает очередь в скрытый постоянный сервер.
 */
const jobSchema = z.object({
  name: z.string().trim().regex(FUNCTION_NAME, "Имя задания: строчные латинские буквы, цифры и дефис, до 63 символов"),
  handler: handlerSchema,
  timeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  memoryMb: z.number().int().min(128).max(512).default(256),
}).strict();

export const functionManifestSchema = z.object({
  version: z.literal(1),
  runtime: z.enum(["node", "python"]),
  functions: z.array(functionSchema).min(1).max(FUNCTIONS_MANIFEST_MAX_FUNCTIONS),
  jobs: z.array(jobSchema).max(FUNCTIONS_MANIFEST_MAX_JOBS).default([]),
}).strict();

export type FunctionManifestEntry = z.infer<typeof functionSchema>;
export type FunctionCachePolicy = NonNullable<FunctionManifestEntry["cache"]>;
export type FunctionManifestJob = z.infer<typeof jobSchema>;
export type FunctionManifest = z.infer<typeof functionManifestSchema>;

export type FunctionManifestIssue = {
  /** Путь внутри JSON, например `functions.0.path`; пустая строка — весь документ. */
  field: string;
  message: string;
};

export class FunctionManifestError extends Error {
  readonly code = "FUNCTIONS_MANIFEST_INVALID";
  readonly statusCode = 422;

  constructor(
    message: string,
    readonly issues: FunctionManifestIssue[] = [],
  ) {
    super(message);
    this.name = "FunctionManifestError";
  }
}

function issueField(issue: z.core.$ZodIssue): string {
  return issue.path.map(String).join(".");
}

/**
 * Семантические проверки, которые не выражаются схемой поля: дубли имён и маршрутов, а также
 * method в нижнем регистре. Возвращает нормализованный manifest или бросает одну понятную ошибку.
 */
export function parseFunctionManifest(raw: unknown): FunctionManifest {
  const parsed = functionManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({ field: issueField(issue), message: issue.message }));
    throw new FunctionManifestError("Манифест функций заполнен неверно: " + (issues[0]?.field ? issues[0].field + " — " : "") + (issues[0]?.message ?? "проверьте поля"), issues);
  }

  const names = new Set<string>();
  const routes = new Set<string>();
  const issues: FunctionManifestIssue[] = [];
  const functions = parsed.data.functions.map((entry, index) => {
    const methods = [...new Set(entry.methods.map(method => method.toUpperCase()))] as FunctionManifestEntry["methods"];
    if (names.has(entry.name)) issues.push({ field: "functions." + index + ".name", message: "Имя функции повторяется: " + entry.name });
    if (routes.has(entry.path)) issues.push({ field: "functions." + index + ".path", message: "Маршрут уже занят другой функцией: " + entry.path });
    names.add(entry.name);
    routes.add(entry.path);
    return { ...entry, methods };
  });
  const jobs = parsed.data.jobs.map((entry, index) => {
    if (names.has(entry.name)) {
      issues.push({ field: "jobs." + index + ".name", message: "Имя задания уже занято функцией или другим заданием: " + entry.name });
    }
    names.add(entry.name);
    return entry;
  });

  if (issues.length) throw new FunctionManifestError(issues[0]?.field + " — " + issues[0]?.message, issues);
  return { ...parsed.data, functions, jobs };
}

/** Читает манифест из корня проекта. Отсутствие файла — это `null`, а не ошибка. */
export async function readFunctionManifest(root: string): Promise<FunctionManifest | null> {
  const file = path.join(root, FUNCTIONS_MANIFEST_FILE);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > FUNCTIONS_MANIFEST_MAX_BYTES) {
    throw new FunctionManifestError(
      "Манифест функций больше " + Math.round(FUNCTIONS_MANIFEST_MAX_BYTES / 1024) + " КБ: сократите список функций",
      [{ field: "", message: "Файл слишком большой" }],
    );
  }
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text.trim()) throw new FunctionManifestError("Манифест функций пуст", [{ field: "", message: "Пустой файл" }]);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FunctionManifestError("Манифест функций — невалидный JSON", [{ field: "", message: "Ожидается JSON" }]);
  }
  return parseFunctionManifest(raw);
}
