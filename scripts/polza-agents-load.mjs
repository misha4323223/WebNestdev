/**
 * Имитация одновременной работы агентов на шлюзе Polza.
 *
 * Отличие от `polza-load-test.mjs`: там был один всплеск коротких запросов, а здесь каждый
 * «агент» живёт заданное время и повторяет шаги: запрос со стримом, ответ, пауза, следующий шаг.
 * Именно так выглядит нагрузка платформы, когда 100–150 человек работают одновременно.
 *
 * Ключ берётся из окружения (`POLZA_TEST_KEY`), не из аргументов.
 *
 * Использование:
 *   node scripts/polza-agents-load.mjs 150 20
 *   node scripts/polza-agents-load.mjs 100 30 morph/fp8 deepseek/deepseek-v4.1-flash-1017 400 120
 *
 * Аргументы: агенты, секунды, провайдер, модель, повторов промпта (≈ токены входа), лимит ответа.
 * Стоимость пишется по `usage.cost_rub`, если шлюз его отдаёт в стриме; иначе оценка по тарифу
 * провайдера (вход/выход за миллион токенов) считается отдельной строкой.
 */
const key = process.env.POLZA_TEST_KEY;
if (!key) {
  console.error("нет POLZA_TEST_KEY в окружении");
  process.exit(1);
}

const N = Number(process.argv[2] || 100);
const seconds = Number(process.argv[3] || 20);
const provider = (process.argv[4] ?? "morph/fp8").trim();
const model = process.argv[5] || "deepseek/deepseek-v4.1-flash-1017";
const promptRepeat = Number(process.argv[6] || 400);
const maxTokens = Number(process.argv[7] || 120);

const prompt = Array.from(
  { length: promptRepeat },
  (_, index) => "Фрагмент " + (index + 1) + ": напиши короткую строку кода на JavaScript.",
).join(" ");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + seconds * 1000;
const stats = {
  requests: 0,
  ok: 0,
  statuses: {},
  retryAfter: new Set(),
  errors: [],
  ttft: [],
  total: [],
  promptTokens: 0,
  outputTokens: 0,
  outputChars: 0,
  cost: 0,
};

function recordStatus(status) {
  const label = String(status);
  stats.statuses[label] = (stats.statuses[label] || 0) + 1;
}

async function step() {
  stats.requests += 1;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let firstTokenAt = 0;
  try {
    const response = await fetch("https://polza.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        reasoning_effort: "none",
        stream: true,
        stream_options: { include_usage: true },
        ...(provider ? { provider: { only: [provider], allow_fallbacks: false } } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      recordStatus(response.status);
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) stats.retryAfter.add(retryAfter);
      let message = text.slice(0, 160);
      try {
        message = JSON.parse(text)?.error?.message || message;
      } catch {}
      stats.errors.push(response.status + ": " + String(message).slice(0, 120));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) stats.outputChars += delta.content.length;
          if (!firstTokenAt && (delta?.content || delta?.reasoning_content)) firstTokenAt = Date.now() - started;
          if (chunk.usage) usage = chunk.usage;
        } catch {}
      }
    }
    recordStatus(200);
    stats.ok += 1;
    stats.ttft.push(firstTokenAt || Date.now() - started);
    stats.total.push(Date.now() - started);
    if (usage) {
      stats.promptTokens += Number(usage.prompt_tokens || 0);
      stats.outputTokens += Number(usage.completion_tokens || 0);
      stats.cost += Number(usage.cost_rub || 0);
    }
  } catch (error) {
    recordStatus(0);
    stats.errors.push("0: " + String(error).slice(0, 120));
  } finally {
    clearTimeout(timer);
  }
}

async function agent() {
  while (Date.now() < deadline) {
    await step();
    // Пауза между шагами: человек читает ответ, агент выполняет инструмент.
    await sleep(1000 + Math.random() * 1500);
  }
}

const began = Date.now();
await Promise.all(Array.from({ length: N }, () => agent()));
const elapsed = Date.now() - began;

const sorted = values => [...values].sort((a, b) => a - b);
const percentile = (values, q) => {
  const list = sorted(values);
  return list.length ? list[Math.min(list.length - 1, Math.floor(list.length * q))] : 0;
};
const minutes = elapsed / 60_000;
// Шлюз не всегда присылает usage в стриме — тогда оцениваем токены по длине текста.
const promptTokens = stats.promptTokens || Math.round((prompt.length / 4) * stats.ok);
const outputTokens = stats.outputTokens || Math.round(stats.outputChars / 4);
const estimatedCost = (promptTokens * 2.556 + outputTokens * 46.47) / 1_000_000;

console.log("агентов:", N, "| длительность:", seconds, "с | провайдер:", provider || "авто", "| модель:", model);
console.log("запросов:", stats.requests, "| успешных:", stats.ok, "| в минуту:", Math.round(stats.requests / minutes));
console.log("статусы:", JSON.stringify(stats.statuses));
console.log("Retry-After:", stats.retryAfter.size ? [...stats.retryAfter].join(", ") : "нет");
console.log("TTFT мс: медиана", percentile(stats.ttft, 0.5), "| p95", percentile(stats.ttft, 0.95));
console.log("шаг целиком мс: медиана", percentile(stats.total, 0.5), "| p95", percentile(stats.total, 0.95));
console.log("токенов: вход", promptTokens, "| выход", outputTokens);
console.log("стоимость по usage:", stats.cost.toFixed(4), "₽ | оценка по тарифу:", estimatedCost.toFixed(4), "₽");
for (const error of stats.errors.slice(0, 6)) console.log("  ошибка:", error);
