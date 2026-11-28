/**
 * Прогон одного шага модели на политиках eval.
 *
 * Промт и каталог инструментов берутся из собранного dist того образа, который проверяем
 * (/app/server/dist — после правок, /app/server/dist-old — до). Задача, mustCall и mustNotCall
 * приходят из нового каталога задач, чтобы обе версии отвечали на один и тот же вопрос.
 *
 * Модель — та же, что в продакшене: адрес, имя и ключ читаются из окружения контейнера и
 * никогда не печатаются. В отчёт попадают только имена инструментов, usage и время.
 */
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.EVAL_DIST;
const version = process.env.EVAL_VERSION || "unknown";
const outFile = process.env.EVAL_OUT || "/app/server/eval-out-" + version + ".json";
const limit = Number(process.env.EVAL_LIMIT || "0");

const load = specifier => import(pathToFileURL(path.join(dist, specifier)).href);
const registry = await load("tool-registry.js");
const catalog = await load("agent/tool-catalog.js");
const prompts = await load("agent/prompt-assembly.js").catch(() => null);
const messages = await load("agent/message-builder.js");

// Инструменты регистрируются импортом модулей; тесты и вспомогательные файлы пропускаем.
const walk = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const failedImports = [];
for (const file of walk(path.join(dist, "tools"))) {
  if (!file.endsWith(".js") || file.endsWith(".test.js")) continue;
  try { await import(pathToFileURL(file).href); }
  catch (error) { failedImports.push(path.basename(file) + ": " + (error instanceof Error ? error.message : String(error))); }
}

const tasksModule = await import(pathToFileURL("/app/server/dist/agent/eval/tasks.js").href);
const tasks = tasksModule.EVAL_TASKS
  .filter(task => (task.mustCall?.length || task.mustNotCall?.length))
  .slice(0, limit > 0 ? limit : undefined);

/**
 * Боевой провайдер платформы задаётся в админке, а его значения живут в шифрованном сторе и
 * применяются поверх process.env тем же кодом, что и у сервера. Режим EVAL_USE_PLATFORM=1
 * читает именно их: печатаются только адрес и имя модели, токен — никогда.
 */
let base = (process.env.PLATFORM_AI_BASE_URL || "").replace(/\/+$/, "");
let key = process.env.PLATFORM_AI_API_KEY || "";
let model = process.env.PLATFORM_AI_MODEL || "";
let configSource = "environment";
if (process.env.EVAL_USE_PLATFORM === "1") {
  const platformEnv = await load("platform/platform-env.js").catch(() => null);
  if (typeof platformEnv?.loadPlatformEnv === "function") await platformEnv.loadPlatformEnv();
  const provider = await load("provider/platform-provider.js");
  const config = provider.getPlatformProviderConfig();
  if (!config) throw new Error("провайдер платформы не настроен");
  base = config.baseUrl.replace(/\/+$/, "");
  key = config.token || "";
  model = config.model;
  configSource = "panel";
  if (typeof platformEnv?.platformEnvSetByPanel === "function") {
    console.log("[config] panel overrides: " + ["PLATFORM_AI_BASE_URL", "PLATFORM_AI_MODEL", "PLATFORM_AI_API_KEY"]
      .map(name => name + "=" + (platformEnv.platformEnvSetByPanel(name) ? "panel" : "env"))
      .join(" "));
  }
  console.log("[config] base=" + base + " model=" + model + " token=" + (key ? "set" : "none"));
}
if (!base || !key || !model) throw new Error("модель не настроена");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callModel(systemPrompt, userPrompt, tools) {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools,
    tool_choice: "auto",
    temperature: 0,
    max_tokens: 400,
  });
  const started = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body,
    });
    const text = await response.text();
    if (response.ok) {
      return { json: JSON.parse(text), latencyMs: Date.now() - started };
    }
    if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error("HTTP " + response.status + ": " + text.slice(0, 300));
    }
    await sleep(3000 * attempt);
  }
  throw new Error("unreachable");
}

const results = [];
for (const task of tasks) {
  const names = catalog.selectToolNames({ task: task.prompt, mode: "build" });
  const tools = registry.getToolDefinitionsFor(names);
  const systemPrompt = typeof prompts?.systemPromptFor === "function"
    ? prompts.systemPromptFor(names)
    : messages.SYSTEM_PROMPT;
  const record = {
    id: task.id,
    size: task.size,
    mustCall: task.mustCall ?? [],
    mustNotCall: task.mustNotCall ?? [],
    promptChars: systemPrompt.length,
    toolsCount: tools.length,
  };
  try {
    const { json, latencyMs } = await callModel(systemPrompt, task.prompt, tools);
    const choice = json.choices?.[0];
    const calls = (choice?.message?.tool_calls ?? []).map(call => call.function?.name).filter(Boolean);
    const known = new Set(names);
    record.calls = calls;
    record.unknownCalls = calls.filter(name => !known.has(name));
    record.first = calls[0] ?? null;
    record.contentChars = (choice?.message?.content ?? "").length;
    record.finishReason = choice?.finish_reason ?? null;
    record.usage = json.usage ?? null;
    record.latencyMs = latencyMs;
    record.mustCallHit = record.mustCall.length === 0 || calls.some(name => record.mustCall.includes(name));
    record.mustNotCallViolated = calls.some(name => record.mustNotCall.includes(name));
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }
  results.push(record);
  console.log("[" + version + "] " + task.id + " first=" + (record.first ?? "-") +
    " must=" + (record.mustCallHit === undefined ? "err" : record.mustCallHit ? "ok" : "miss") +
    " tokens=" + (record.usage?.total_tokens ?? "?") + (record.error ? " ERR " + record.error : ""));
  await sleep(1500);
}

const summary = {
  version,
  model,
  configSource,
  dist,
  generatedAt: new Date().toISOString(),
  failedImports,
  tasks: results,
  totals: {
    calls: results.length,
    errors: results.filter(r => r.error).length,
    mustCallHit: results.filter(r => r.mustCallHit).length,
    mustNotCallViolated: results.filter(r => r.mustNotCallViolated).length,
    promptTokens: results.reduce((sum, r) => sum + (r.usage?.prompt_tokens ?? 0), 0),
    completionTokens: results.reduce((sum, r) => sum + (r.usage?.completion_tokens ?? 0), 0),
    totalTokens: results.reduce((sum, r) => sum + (r.usage?.total_tokens ?? 0), 0),
    promptChars: results.reduce((sum, r) => sum + r.promptChars, 0),
  },
};
writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log("EVAL-" + version + " done: " + outFile + " errors=" + summary.totals.errors);
