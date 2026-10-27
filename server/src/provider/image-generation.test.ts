import assert from "node:assert/strict";
import test from "node:test";
import {
  describeImageGeneration,
  generateImage,
  getImageGenerationConfig,
  imageApiStyle,
  imageEndpoint,
  imageFileExtension,
  imageRequestBody,
  parseImageResponse,
  providerErrorMessage,
  sniffImageType,
  type ImageAttempt,
  type ImageSend,
} from "./image-generation.js";

const NAMES = [
  "PLATFORM_IMAGE_BASE_URL",
  "PLATFORM_IMAGE_MODEL",
  "PLATFORM_IMAGE_PROVIDER",
  "PLATFORM_IMAGE_KEY_1",
  "PLATFORM_IMAGE_KEY_2",
  "PLATFORM_IMAGE_KEY_3",
];

function clear() {
  for (const name of NAMES) delete process.env[name];
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("картинка")]);

/** Ответ сервиса в тесте: сеть не нужна — разбор ответа и перебор ключей проверяются на заглушке. */
function answer(calls: Array<{ url: string; headers: Record<string, string>; body: string }>, replies: ImageAttempt[]): ImageSend {
  return async input => {
    calls.push({ url: input.url, headers: input.headers, body: input.body });
    const reply = replies.shift();
    if (!reply) throw new Error("лишний запрос");
    return reply;
  };
}

test("генерация включается только целиком: адрес, модель и хотя бы один ключ", () => {
  clear();
  assert.equal(getImageGenerationConfig(), null);

  process.env.PLATFORM_IMAGE_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/acc/ai/run";
  process.env.PLATFORM_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
  assert.equal(getImageGenerationConfig(), null, "одного адреса и модели мало — нужен ключ");

  process.env.PLATFORM_IMAGE_KEY_1 = "cf-key";
  const config = getImageGenerationConfig();
  assert.equal(config?.baseUrl, "https://api.cloudflare.com/client/v4/accounts/acc/ai/run");
  assert.equal(config?.model, "@cf/black-forest-labs/flux-1-schnell");
  assert.deepEqual(config?.keys, ["cf-key"]);
  assert.equal(config?.providerName, "Cloudflare Workers AI", "имя по умолчанию");
  assert.match(describeImageGeneration(), /Cloudflare Workers AI \(@cf\/black-forest-labs\/flux-1-schnell\), ключей 1/);
  clear();
});

test("незаданные переменные объясняются строкой старта, а не тишиной", () => {
  clear();
  assert.match(describeImageGeneration(), /PLATFORM_IMAGE_\* не заданы/);
});

test("ключи читаются по порядку, пустые и повторы отбрасываются", () => {
  clear();
  process.env.PLATFORM_IMAGE_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/acc/ai/run";
  process.env.PLATFORM_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
  process.env.PLATFORM_IMAGE_PROVIDER = "  Cloudflare  ";
  process.env.PLATFORM_IMAGE_KEY_1 = "  key-1  ";
  process.env.PLATFORM_IMAGE_KEY_2 = "key-1";
  process.env.PLATFORM_IMAGE_KEY_3 = "key-3";
  const config = getImageGenerationConfig();
  assert.deepEqual(config?.keys, ["key-1", "key-3"]);
  assert.equal(config?.providerName, "Cloudflare");
  clear();
});

test("вид запроса выбирается по адресу: Cloudflare дописывает модель, OpenAI — /images/generations", () => {
  const run = "https://api.cloudflare.com/client/v4/accounts/acc/ai/run";
  assert.equal(imageApiStyle(run), "cloudflare");
  assert.equal(imageEndpoint(run, "@cf/black-forest-labs/flux-1-schnell"), run + "/@cf/black-forest-labs/flux-1-schnell");
  assert.equal(imageEndpoint(run + "/", "/@cf/stabilityai/stable-diffusion-xl-base-1.0"), run + "/@cf/stabilityai/stable-diffusion-xl-base-1.0");

  assert.equal(imageApiStyle("https://api.example.com/v1"), "openai");
  assert.equal(imageEndpoint("https://api.example.com/v1", "image-1"), "https://api.example.com/v1/images/generations");
  assert.equal(
    imageEndpoint("https://api.example.com/v1/images/generations", "image-1"),
    "https://api.example.com/v1/images/generations",
    "готовый адрес не удваивается",
  );
});

test("Flux не получает размер, который его схема не принимает", () => {
  const request = { prompt: "кот в шляпе", size: "1024x1024", negativePrompt: "текст" };
  assert.deepEqual(imageRequestBody("cloudflare", "@cf/black-forest-labs/flux-1-schnell", request), { prompt: "кот в шляпе" });
  assert.deepEqual(imageRequestBody("cloudflare", "@cf/stabilityai/stable-diffusion-xl-base-1.0", request), {
    prompt: "кот в шляпе",
    width: 1024,
    height: 1024,
    negative_prompt: "текст",
  });
  assert.deepEqual(imageRequestBody("openai", "gpt-image-1", request), {
    model: "gpt-image-1",
    prompt: "кот в шляпе",
    n: 1,
    size: "1024x1024",
    response_format: "b64_json",
  });
  // Размер вне допустимых границ не отправляется: сервис ответил бы отказом, а не картинкой.
  assert.deepEqual(imageRequestBody("cloudflare", "@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt: "кот", size: "4096x4096" }), {
    prompt: "кот",
  });
});

test("ответ читается и байтами, и base64 из JSON", () => {
  assert.deepEqual(parseImageResponse("image/png", PNG), { bytes: PNG, contentType: "image/png" });
  assert.deepEqual(parseImageResponse("image/png; charset=binary", PNG), { bytes: PNG, contentType: "image/png" });

  const wrapped = { result: { image: PNG.toString("base64") }, success: true };
  const parsed = parseImageResponse("application/json", Buffer.from(JSON.stringify(wrapped)));
  assert.deepEqual(parsed.bytes, PNG, "base64 разобран в те же байты");
  assert.equal(parsed.contentType, "image/png", "тип берётся из самих байтов: Cloudflare его не называет");

  const openai = { data: [{ b64_json: "data:image/png;base64," + PNG.toString("base64") }] };
  assert.deepEqual(parseImageResponse("application/json", Buffer.from(JSON.stringify(openai))).bytes, PNG);
});

test("отказ сервиса приходит сообщением, а не картинкой из нуля байт", () => {
  const failed = Buffer.from(JSON.stringify({ success: false, errors: [{ code: 7000, message: "No such model" }] }));
  assert.equal(providerErrorMessage(JSON.parse(failed.toString("utf8"))), "No such model");
  assert.throws(() => parseImageResponse("application/json", failed), /No such model/);
  assert.throws(
    () => parseImageResponse("application/json", Buffer.from(JSON.stringify({ data: [{ url: "https://cdn.example.com/a.png" }] }))),
    /ссылку на картинку, а не сами байты/,
  );
  assert.throws(() => parseImageResponse("text/html", Buffer.from("<html>плохой шлюз</html>")), /не изображение и не JSON/);
});

test("generateImage перебирает ключи: лимит первого уходит ко второму, картинка возвращается", async () => {
  clear();
  const config = {
    providerName: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc/ai/run",
    model: "@cf/black-forest-labs/flux-1-schnell",
    keys: ["key-1", "key-2"],
  };
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const send = answer(calls, [
    { status: 429, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ success: false, errors: [{ message: "rate limited" }] })) },
    { status: 200, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ result: { image: PNG.toString("base64") } })) },
  ]);
  const image = await generateImage(config, { prompt: "кот в шляпе" }, { send });
  assert.equal(calls.length, 2, "первый ключ отказал — запрос ушёл ко второму");
  assert.equal(calls[0]?.headers.authorization, "Bearer key-1");
  assert.equal(calls[1]?.headers.authorization, "Bearer key-2");
  assert.equal(calls[0]?.url, config.baseUrl + "/@cf/black-forest-labs/flux-1-schnell");
  assert.equal(calls[0]?.body, JSON.stringify({ prompt: "кот в шляпе" }));
  assert.deepEqual(image.bytes, PNG);
  assert.equal(image.contentType, "image/png");
  assert.equal(image.keyIndex, 1);
  clear();
});

test("ошибка формата не перебирает ключи: другой ключ её не исправит", async () => {
  const config = { providerName: "Cloudflare", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc/ai/run", model: "@cf/x/y", keys: ["key-1", "key-2"] };
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const send = answer(calls, [
    { status: 400, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ success: false, errors: [{ message: "model not found" }] })) },
  ]);
  await assert.rejects(() => generateImage(config, { prompt: "кот" }, { send }), /model not found/);
  assert.equal(calls.length, 1);
});

test("ни один ключ не подошёл — в отказе видно, что ответил каждый", async () => {
  const config = { providerName: "Cloudflare", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc/ai/run", model: "@cf/x/y", keys: ["key-1", "key-2"] };
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const send = answer(calls, [
    { status: 403, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ success: false, errors: [{ message: "invalid token" }] })) },
    { status: 401, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ success: false, errors: [{ message: "token expired" }] })) },
  ]);
  await assert.rejects(() => generateImage(config, { prompt: "кот" }, { send }), /ключ #1 → 403: invalid token; ключ #2 → 401: token expired/);
});

test("тип картинки определяется по байтам, расширение — по типу", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("RIFF____WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(Buffer.from("не картинка")), null);
  assert.equal(imageFileExtension("image/png"), ".png");
  assert.equal(imageFileExtension("image/jpeg"), ".jpg");
  assert.equal(imageFileExtension("image/webp"), ".webp");
});
