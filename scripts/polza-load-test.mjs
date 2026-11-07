/**
 * Нагрузочный тест шлюза Polza: N одновременных запросов к одной модели.
 *
 * Зачем: лимиты Polza не опубликованы числами (только правило «запросов к модели в минуту и в
 * сутки на организацию»), поэтому реальный потолок можно узнать только замером. Скрипт шлёт
 * короткие запросы, считает статусы, задержки и стоимость, показывает `Retry-After` у 429.
 *
 * Ключ берётся из окружения (`POLZA_TEST_KEY`), а не из аргументов: иначе он попадал бы в
 * историю команд и в логи.
 *
 * Использование:
 *   node scripts/polza-load-test.mjs            # 50 запросов через morph/fp8
 *   node scripts/polza-load-test.mjs 50 morph/fp8
 *   node scripts/polza-load-test.mjs 50 ""      # без provider: шлюз выберет сам
 */
const key = process.env.POLZA_TEST_KEY;
if (!key) {
  console.error("нет POLZA_TEST_KEY в окружении: добавьте ключ в .env.local");
  process.exit(1);
}

const N = Number(process.argv[2] || 50);
const provider = (process.argv[3] ?? "morph/fp8").trim();
const model = process.argv[4] || "deepseek/deepseek-v4.1-flash-1017";
// Длина «контекста» и потолок ответа: пустышка меряет частоту запросов, длинный промпт —
// ещё и пропускную способность по токенам, которая у шлюза ограничена отдельно.
const promptRepeat = Number(process.argv[5] || 0);
const maxTokens = Number(process.argv[6] || 16);
const prompt = promptRepeat > 0
  ? Array.from({ length: promptRepeat }, (_, index) => "Фрагмент " + (index + 1) + ": напиши короткую строку кода на JavaScript.").join(" ")
  : "Ответь одним словом: ок";

const started = Date.now();
const run = async index => {
  const at = Date.now();
  try {
    const response = await fetch("https://polza.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        reasoning_effort: "none",
        ...(provider ? { provider: { only: [provider], allow_fallbacks: false } } : {}),
      }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return {
      index,
      status: response.status,
      ms: Date.now() - at,
      retryAfter: response.headers.get("retry-after"),
      error: body?.error?.message || body?.error?.code || null,
      cost: Number(body?.usage?.cost_rub || 0),
      promptTokens: Number(body?.usage?.prompt_tokens || 0),
      outputTokens: Number(body?.usage?.completion_tokens || 0),
    };
  } catch (error) {
    return { index, status: 0, ms: Date.now() - at, error: String(error) };
  }
};

const results = await Promise.all(Array.from({ length: N }, (_, index) => run(index)));
const elapsed = Date.now() - started;
const statuses = {};
for (const result of results) statuses[result.status] = (statuses[result.status] || 0) + 1;
const latencies = results.map(result => result.ms).sort((a, b) => a - b);
const percentile = q => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

console.log("запросов:", N, "| провайдер:", provider || "авто", "| модель:", model);
console.log("общее время:", (elapsed / 1000).toFixed(1), "с | запросов в секунду:", (N / (elapsed / 1000)).toFixed(1));
console.log("статусы:", JSON.stringify(statuses));
console.log("латентность мс: min", latencies[0], "| медиана", percentile(0.5), "| p95", percentile(0.95), "| max", latencies[latencies.length - 1]);
console.log("стоимость:", results.reduce((sum, result) => sum + result.cost, 0).toFixed(6), "₽");
const tokens = results.reduce((sum, result) => sum + (result.promptTokens || 0) + (result.outputTokens || 0), 0);
console.log("токенов всего:", tokens, "| в среднем на запрос:", Math.round(tokens / N));

const retryAfter = [...new Set(results.map(result => result.retryAfter).filter(Boolean))];
console.log("Retry-After:", retryAfter.length ? retryAfter.join(", ") : "нет");

const failed = results.filter(result => result.status !== 200);
console.log("ошибок:", failed.length);
for (const failure of failed.slice(0, 8)) {
  console.log("  #" + failure.index, failure.status, "|", failure.ms + "мс |", String(failure.error).slice(0, 160));
}
