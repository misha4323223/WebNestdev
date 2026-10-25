import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { createLimiter, positiveInt, type Slot } from "../concurrency.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { isSecretEnvFile, openFileForSandbox } from "../sandbox/permissions.js";
import { loadProjectSecretFiles } from "../secrets/project-secrets.js";
import { askUser } from "../questions/pending-questions.js";
import { assertPublicUrl, requestPage, WebReadError } from "../web/read-url.js";
import {
  approvalQuestion,
  APPROVAL_OPTIONS,
  assertHeaderSafeSecret,
  findSecretValue,
  publicResponseHeaders,
  redactSecret,
  sanitizeHeaders,
} from "../net/net-policy.js";

/**
 * `net.request` и `net.download`: единственный легальный выход агента во внешний мир.
 *
 * Песочница проекта остаётся без сети — это её свойство, а не дефект сборки. Запрос выполняет
 * сервер: он проверяет адрес тем же транспортом, что закрыл DNS rebinding (порт 80/443, только
 * публичные адреса, привязка к проверенному IP), ограничивает размер и время ответа, не хранит
 * cookie и не следует редиректам автоматически — иначе проверенный адрес сменился бы на
 * непроверенный.
 *
 * Ключи сторонних API не берутся из аргументов инструмента: только из сохранённых секретов
 * проекта и только после явного разрешения человека в панели. Значение ключа вырезается из
 * ответа, а в журнал попадают лишь метод, хост и имя переменной.
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const requestSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  method: z.enum(METHODS).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(100_000).optional(),
  maxChars: z.number().int().min(500).max(200_000).optional(),
  auth: z
    .object({
      variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      file: z.string().max(200).optional(),
      scheme: z.enum(["bearer", "header"]).optional(),
      header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    })
    .optional(),
});

const downloadSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  path: z.string().trim().min(1).max(500),
  overwrite: z.boolean().optional(),
  maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
});

/** Один запрос — одно соединение, поэтому параллельность ограничена как у чтения страниц. */
const netLimiter = createLimiter(() => ({
  limit: positiveInt(process.env.NET_MAX_CONCURRENT, 2),
  queueLimit: positiveInt(process.env.NET_MAX_QUEUE, 6),
  waitTimeoutMs: positiveInt(process.env.NET_QUEUE_TIMEOUT_MS, 30_000),
  busyLabel: "Внешние запросы",
}));

const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 200_000;
const DEFAULT_RESPONSE_BYTES = 120_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function seconds(value: number) {
  return Math.max(1, Math.round(value / 1000));
}

/**
 * Единый ответ на любой отказ проверки адреса: причина от `assertPublicUrl` уже сформулирована
 * по-русски и не содержит внутренних деталей транспорта.
 */
function refusal(error: unknown) {
  if (error instanceof WebReadError) return { ok: false as const, code: error.code, error: error.message };
  return { ok: false as const, code: "unavailable", error: error instanceof Error ? error.message : String(error) };
}

async function approvedSecret(
  input: NonNullable<z.infer<typeof requestSchema>["auth"]>,
  context: { projectId: string; userId: string; runId: string; emit?: unknown; signal?: AbortSignal },
  method: string,
  url: URL,
) {
  const sandbox = await getSandbox(context.projectId, context.userId);
  const files = await loadProjectSecretFiles(context.projectId, sandbox.root);
  const found = findSecretValue(files, input.variable, input.file);
  if (!found) {
    throw new Error(
      "Переменная " +
        input.variable +
        (input.file ? " в " + input.file : "") +
        " не найдена среди секретов проекта. Запросите ключ у пользователя через secrets.request, а не придумывайте значение.",
    );
  }
  // Подтверждение — отдельный короткий разговор с человеком, поэтому оно идёт тем же окном, что и
  // вопрос агента. Без события панели подтверждение невозможно: тогда запрос не выполняется.
  const emit = context.emit as ((event: unknown) => void) | undefined;
  if (!emit) throw new Error("Подтверждение отправки ключа недоступно без панели: запрос не выполнен");
  const { question, answer } = askUser({
    projectId: context.projectId,
    userId: context.userId,
    question: approvalQuestion({ variable: input.variable, method, url, file: found.file }).slice(0, 400),
    options: APPROVAL_OPTIONS,
    multiSelect: false,
    allowCustom: false,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  emit({
    type: "question.asked",
    runId: context.runId,
    requestId: question.id,
    question: question.question,
    options: question.options,
    multiSelect: false,
    allowCustom: false,
    expiresAt: question.expiresAt,
  });
  const resolution = await answer;
  const allowed = resolution.ok && "selected" in resolution && resolution.selected[0] === APPROVAL_OPTIONS[0].label;
  // Журнал подтверждений: видно, что человек разрешил или запретил отправку ключа.
  console.log(
    "[net] approval " + (allowed ? "allowed" : "denied") + " " + input.variable + " -> " + url.hostname + " " + method,
  );
  if (!allowed) return { denied: true as const, variable: input.variable, file: found.file };
  return { denied: false as const, variable: input.variable, value: found.value };
}

registerTool({
  name: "net.request",
  description:
    "Make one HTTP(S) request from the platform server to a public API and return status, selected headers and a bounded body. " +
    "Input: {url, method?: GET|POST|PUT|PATCH|DELETE|HEAD, headers?:{name:value}, body?:string, maxChars?:500..200000, auth?:{variable, file?, scheme?:bearer|header, header?}}. " +
    "This is the legal way to call a third-party API with a key: the key is read from the project's saved secrets and ONLY after the user approves the exact destination in a panel. " +
    "Never put a key, token or cookie into headers yourself — authorization/cookie headers are refused; use auth.variable. The key value never comes back in the response. " +
    "Only public hosts on ports 80/443 are reachable: localhost, private networks and the project's own sandbox are refused by design. " +
    "Redirects are not followed (a 3xx returns its location), the body is capped, and binary responses are not downloaded — use net.download for files. " +
    "If the secret is missing, request it with secrets.request first; do not invent a value.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the API endpoint." },
      method: { type: "string", enum: METHODS, description: "HTTP method. Default GET." },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Plain request headers. Authorization, cookie and hop-by-hop headers are refused.",
      },
      body: { type: "string", description: "Request body as text (JSON is sent with content-type: application/json when no content-type is given)." },
      maxChars: { type: "integer", minimum: 500, maximum: 200000, description: "Response body limit. Default 120000 characters." },
      auth: {
        type: "object",
        additionalProperties: false,
        required: ["variable"],
        description: "Send a saved project secret as the Authorization header, after the user approves this exact request.",
        properties: {
          variable: { type: "string", description: "Name of the saved project secret, e.g. STRIPE_SECRET_KEY." },
          file: { type: "string", description: "Secrets file, when the same name exists in several. Default is the first file that has it." },
          scheme: { type: "string", enum: ["bearer", "header"], description: "bearer (default) sends `Authorization: Bearer <value>`; header sends the raw value in `header`." },
          header: { type: "string", description: "Header name for scheme=header, default X-Api-Key." },
        },
      },
    },
  },
  execute: async (input, context) => {
    const parsed = requestSchema.parse(input ?? {});
    const method = (parsed.method ?? "GET").toUpperCase();
    const headers = sanitizeHeaders(parsed.headers);
    if (parsed.body !== undefined && (method === "GET" || method === "HEAD")) {
      throw new Error("GET и HEAD не отправляют тело: используйте POST, PUT или PATCH");
    }
    if (method !== "GET" && method !== "HEAD" && parsed.body !== undefined && !Object.keys(headers).some(name => name === "content-type")) {
      try {
        JSON.parse(parsed.body);
        headers["content-type"] = "application/json";
      } catch {
        headers["content-type"] = "text/plain; charset=utf-8";
      }
    }

    let checked;
    try {
      checked = await assertPublicUrl(parsed.url);
    } catch (error) {
      return refusal(error);
    }

    let secret: string | undefined;
    if (parsed.auth) {
      const approved = await approvedSecret(parsed.auth, context, method, checked.url);
      if (approved.denied) {
        return {
          ok: false,
          code: "denied",
          status: 0,
          url: checked.url.href,
          error:
            "Пользователь не разрешил отправку ключа " +
            approved.variable +
            " на " +
            checked.url.origin +
            ". Запрос не выполнен; не повторяйте его без новой необходимости и не подставляйте ключ вручную.",
        };
      }
      assertHeaderSafeSecret(approved.value);
      secret = approved.value;
      if ((parsed.auth.scheme ?? "bearer") === "bearer") {
        headers.authorization = "Bearer " + approved.value;
      } else {
        const name = (parsed.auth.header ?? "X-Api-Key").toLowerCase();
        // Имя проверяется той же политикой, что и обычные заголовки: Authorization/Cookie/Host и
        // hop-by-hop туда не проходят. Для Authorization есть scheme=bearer.
        try {
          sanitizeHeaders({ [name]: "placeholder" });
        } catch {
          throw new Error("Заголовок " + name + " нельзя использовать для ключа: для Authorization выберите scheme=bearer");
        }
        headers[name] = approved.value;
      }
    }

    const maxBytes = Math.min(MAX_RESPONSE_BYTES, parsed.maxChars ?? DEFAULT_RESPONSE_BYTES);
    const slot: Slot = await netLimiter.acquire(context.signal);
    try {
      const response = await requestPage(
        checked.url,
        checked.addresses,
        AbortSignal.any([
          ...(context.signal ? [context.signal] : []),
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
        {
          method,
          headers,
          ...(parsed.body === undefined ? {} : { body: parsed.body }),
          maxBytes,
        },
      );
      const body = redactSecret(response.body, secret);
      // Location и WWW-Authenticate тоже могут вернуть эхо ключа: вырезаем его и из заголовков.
      const responseHeaders = Object.fromEntries(
        Object.entries(publicResponseHeaders(response.headers)).map(([name, value]) => [name, redactSecret(value, secret)]),
      );
      const ok = response.status >= 200 && response.status < 300;
      // В журнал — метод, хост и имя переменной. Ни пути с идентификаторами, ни тела, ни ключа.
      console.log(
        "[net] " +
          method +
          " " +
          checked.url.hostname +
          " -> " +
          response.status +
          " project=" +
          context.projectId +
          (parsed.auth ? " secret=" + parsed.auth.variable : ""),
      );
      return {
        ok,
        status: response.status,
        method,
        url: checked.url.href,
        headers: responseHeaders,
        body,
        truncated: response.oversized,
        ...(parsed.auth ? { usedSecret: parsed.auth.variable } : {}),
        ...(response.status >= 300 && response.status < 400
          ? { note: "Это редирект: адрес назначения в headers.location не запрашивался, проверьте его отдельно, если он нужен." }
          : {}),
        ...(response.status === 429
          ? { note: "Сервер ограничил частоту: подождите столько секунд, сколько указано в retry-after, прежде чем повторять." }
          : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: "unavailable",
        status: 0,
        url: checked.url.href,
        error:
          "Запрос не выполнен за " +
          seconds(REQUEST_TIMEOUT_MS) +
          " с: " +
          reason +
          ". Проверьте адрес и доступность API, а не сеть песочницы — запрос идёт с сервера.",
      };
    } finally {
      slot.release();
    }
  },
});

registerTool({
  name: "net.download",
  description:
    "Download a public file by URL into the project and return its path and size. Input: {url, path, overwrite?:false, maxBytes?:1..52428800}. " +
    "Use it for a real asset or a sample file that a page links to — not for reading a page (web.read) and not for API JSON (net.request). " +
    "The destination is a path inside the project; .git and .env files are refused, existing files are kept unless overwrite is true. " +
    "Only public hosts on ports 80/443 are reachable; redirects are checked hop by hop (up to 4) so a public link cannot forward the download to an internal address. " +
    "Size is capped at 50 MB and the response is written only after a successful 2xx.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["url", "path"],
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the file." },
      path: { type: "string", description: "Destination path inside the project, e.g. public/logo.png." },
      overwrite: { type: "boolean", description: "Replace an existing file. Default false." },
      maxBytes: { type: "integer", minimum: 1, maximum: 52428800, description: "Size limit. Default 25 MB." },
    },
  },
  execute: async (input, context) => {
    const parsed = downloadSchema.parse(input ?? {});
    const destination = parsed.path.replace(/\\/g, "/");
    if (path.isAbsolute(destination) || destination.split("/").some(segment => segment === "..")) {
      throw new Error("Путь скачивания должен быть относительным и не выходить за пределы проекта");
    }
    const base = path.posix.basename(destination);
    if (isSecretEnvFile(base)) throw new Error("Скачивать в файл окружения нельзя: секреты проекта не перезаписываются загрузкой");
    if (destination === ".git" || destination.startsWith(".git/")) throw new Error("Скачивать внутрь .git нельзя");

    const sandbox = await getSandbox(context.projectId, context.userId);
    const target = path.join(sandbox.root, destination);
    if (!parsed.overwrite) {
      const existing = await lstat(target).catch(() => null);
      if (existing) throw new Error("Файл " + destination + " уже существует: укажите overwrite=true, если его нужно заменить");
    }

    const maxBytes = Math.min(MAX_DOWNLOAD_BYTES, parsed.maxBytes ?? DEFAULT_DOWNLOAD_BYTES);
    const slot: Slot = await netLimiter.acquire(context.signal);
    try {
      let current;
      try {
        current = await assertPublicUrl(parsed.url);
      } catch (error) {
        return refusal(error);
      }
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await requestPage(
          current.url,
          current.addresses,
          AbortSignal.any([
            ...(context.signal ? [context.signal] : []),
            AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3),
          ]),
          { maxBytes, keep: "head" },
        );
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location;
          if (!location) return { ok: false, status: response.status, url: current.url.href, error: "Редирект без адреса (Location)" };
          try {
            current = await assertPublicUrl(new URL(location, current.url).href);
          } catch (error) {
            return refusal(error);
          }
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            status: response.status,
            url: current.url.href,
            error: "Сервер ответил " + response.status + ": файл не сохранён",
          };
        }
        if (response.oversized) {
          return {
            ok: false,
            status: response.status,
            url: current.url.href,
            error: "Файл больше лимита " + Math.round(maxBytes / 1024) + " КБ: увеличьте maxBytes или скачайте другой файл",
          };
        }
        const written = await writeFileInside(sandbox.root, target, response.bytes);
        // Файл, записанный сервером от root, контейнер должен уметь читать и перезаписывать.
        await openFileForSandbox(written);
        console.log(
          "[net] download " + current.url.hostname + " -> " + destination + " bytes=" + response.bytes.length + " project=" + context.projectId,
        );
        return {
          ok: true,
          status: response.status,
          url: current.url.href,
          path: destination,
          bytes: response.bytes.length,
          contentType: response.headers["content-type"] ?? null,
        };
      }
      return { ok: false, status: 0, url: parsed.url, error: "Слишком много перенаправлений (больше " + MAX_REDIRECTS + ")" };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        url: parsed.url,
        error: "Скачивание не удалось: " + (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      slot.release();
    }
  },
});
