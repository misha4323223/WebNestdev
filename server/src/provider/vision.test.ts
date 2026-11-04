import test from "node:test";
import assert from "node:assert/strict";
import { getVisionConfig, inspectImage, visionChatUrl } from "./vision.js";

const NAMES = [
  "PLATFORM_VISION_MODEL",
  "PLATFORM_VISION_BASE_URL",
  "PLATFORM_VISION_API_KEY",
  "PLATFORM_VISION_PROVIDER",
  "PLATFORM_AI_BASE_URL",
  "PLATFORM_AI_API_KEY",
  "PLATFORM_AI_MODEL",
  "PLATFORM_AI_PROVIDER",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_PROXY_URL",
  "AI_PROXY_TOKEN",
] as const;

function withEnv(values: Partial<Record<(typeof NAMES)[number], string>>, run: () => Promise<void> | void) {
  const before = new Map(NAMES.map(name => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  return Promise.resolve(run()).finally(() => {
    for (const name of NAMES) {
      const value = before.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("vision без отдельной и без главной модели честно выключен", async () => {
  await withEnv({}, () => {
    assert.equal(getVisionConfig(), null);
  });
});

test("vision без PLATFORM_VISION_MODEL использует главную модель платформы", async () => {
  await withEnv({
    PLATFORM_AI_MODEL: "deepseek/deepseek-v4.1-flash-1018",
    PLATFORM_AI_BASE_URL: "https://polza.example/v1",
    PLATFORM_AI_API_KEY: "main-key",
    PLATFORM_AI_PROVIDER: "Polza",
  }, () => {
    const config = getVisionConfig();
    assert.equal(config?.model, "deepseek/deepseek-v4.1-flash-1018");
    assert.equal(config?.baseUrl, "https://polza.example/v1");
    assert.equal(config?.key, "main-key");
    assert.equal(config?.provider, "Polza");
  });
});

test("vision использует провайдера проекта, если отдельной модели нет", async () => {
  await withEnv({}, () => {
    const config = getVisionConfig({
      provider: "Project gateway",
      baseUrl: "https://project.example/v1",
      model: "project-vision-model",
      token: "project-key",
    });
    assert.equal(config?.model, "project-vision-model");
    assert.equal(config?.baseUrl, "https://project.example/v1");
    assert.equal(config?.key, "project-key");
    assert.equal(config?.provider, "Project gateway");
  });
});

test("отдельная vision-модель важнее главной", async () => {
  await withEnv({
    PLATFORM_VISION_MODEL: "vision-model",
    PLATFORM_VISION_BASE_URL: "https://vision.example/v1",
    PLATFORM_VISION_API_KEY: "vision-key",
  }, () => {
    const config = getVisionConfig({
      provider: "Project gateway",
      baseUrl: "https://project.example/v1",
      model: "main-model",
      token: "main-key",
    });
    assert.equal(config?.model, "vision-model");
    assert.equal(config?.baseUrl, "https://vision.example/v1");
    assert.equal(config?.key, "vision-key");
  });
});

test("vision берёт base/key из PLATFORM_AI_*, но модель задаёт отдельно", async () => {
  await withEnv({
    PLATFORM_VISION_MODEL: "vision-model",
    PLATFORM_AI_BASE_URL: "https://gateway.example/v1",
    PLATFORM_AI_API_KEY: "secret",
    PLATFORM_AI_PROVIDER: "Gateway",
  }, () => {
    const config = getVisionConfig();
    assert.equal(config?.model, "vision-model");
    assert.equal(config?.baseUrl, "https://gateway.example/v1");
    assert.equal(config?.key, "secret");
    assert.equal(config?.provider, "Gateway");
  });
});

test("image.inspect отправляет data-url и читает текстовый ответ vision-модели", async () => {
  await withEnv({
    PLATFORM_VISION_MODEL: "vision-model",
    PLATFORM_VISION_BASE_URL: "https://vision.example/v1",
    PLATFORM_VISION_API_KEY: "vision-key",
  }, async () => {
    const config = getVisionConfig();
    assert.ok(config);
    const captured: { url: string; body: Record<string, unknown>; authorization?: string } = { url: "", body: {} };
    const result = await inspectImage(config, {
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/png",
      question: "Что не так с отступами?",
    }, async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      captured.authorization = (init.headers as Record<string, string> | undefined)?.authorization;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Слева отступ меньше, чем справа." } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    assert.equal(captured.url, "https://vision.example/v1/chat/completions");
    assert.equal(captured.authorization, "Bearer vision-key");
    assert.equal(captured.body.model, "vision-model");
    const messages = captured.body.messages as Array<{ content: unknown }>;
    const parts = messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.equal(parts[1]?.type, "image_url");
    assert.match(parts[1]?.image_url?.url ?? "", /^data:image\/png;base64,/);
    assert.equal(result.analysis, "Слева отступ меньше, чем справа.");
    assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 20 });
  });
});

test("visionChatUrl не дублирует /v1", () => {
  assert.equal(visionChatUrl("https://example.com/v1"), "https://example.com/v1/chat/completions");
  assert.equal(visionChatUrl("https://example.com"), "https://example.com/v1/chat/completions");
  assert.equal(visionChatUrl("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions");
});
