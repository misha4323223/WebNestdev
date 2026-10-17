import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Ключи платформы вводятся человеком: из консоли провайдера, из скачанного .env, из
 * уведомления в мессенджере. Проверяется не «сохранилось», а «сохранилось ровно то, что нужно»:
 * многострочный JSON, строка с литеральными \n, JSON в кавычках, CRLF и хвостовой комментарий.
 */
async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-platform-"));
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  try { await run(root); }
  finally {
    delete process.env.WEBNESTDEV_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  }
}

function serviceAccountKey(privateKey = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n") {
  return { id: "key-id", service_account_id: "sa-id", private_key: privateKey };
}

const prettyKey = JSON.stringify(serviceAccountKey(), null, 2);

test("парсер .env принимает кавычки, export, комментарии и многострочные значения", async () => {
  const { parseEnvFileContent } = await import("./platform-env.js");
  const content = [
    "# ключи из консоли",
    "export GITHUB_CLIENT_ID=abc123",
    "GITHUB_CLIENT_SECRET='s3cret with spaces' # комментарий после значения",
    'YANDEX_CLOUD_ID="b1gpj9488h3k7oaa3foh" # облако',
    'SMS_SENDER="Имя # с решёткой"',
    // Так выглядит строка из .env: компактный JSON целиком в кавычках, кавычки внутри экранированы.
    "YANDEX_SA_KEY=" + JSON.stringify(JSON.stringify(serviceAccountKey())),
    "",
  ].join("\r\n");
  const values = Object.fromEntries(parseEnvFileContent(content).map(line => [line.name, line.value]));
  assert.equal(values.GITHUB_CLIENT_ID, "abc123");
  assert.equal(values.GITHUB_CLIENT_SECRET, "s3cret with spaces");
  assert.equal(values.YANDEX_CLOUD_ID, "b1gpj9488h3k7oaa3foh");
  assert.equal(values.SMS_SENDER, "Имя # с решёткой");
  const { parseServiceAccountKey } = await import("../yandex/yandex-api.js");

  assert.deepEqual(parseServiceAccountKey(values.YANDEX_SA_KEY), serviceAccountKey());
});

test("многострочное значение в кавычках читается целиком, а не до первой строки", async () => {
  const { parseEnvFileContent } = await import("./platform-env.js");
  const values = parseEnvFileContent('YANDEX_SA_KEY="' + prettyKey + '"\nNEXT=1\n');
  assert.equal(values.length, 2);
  const { parseServiceAccountKey } = await import("../yandex/yandex-api.js");
  assert.deepEqual(parseServiceAccountKey(values[0].value), serviceAccountKey());
  assert.equal(values[1].value, "1");
});

test("ключ с настоящими переносами внутри JSON принимается как правильный", async () => {
  const { validatePlatformValue, normalizePastedValue } = await import("./platform-env.js");
  const pasted = '{\n "id": "k",\n "service_account_id": "s",\n "private_key": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"\n}';
  assert.equal(normalizePastedValue("  a\r\nb  "), "a\nb");
  assert.equal(validatePlatformValue("YANDEX_SA_KEY", pasted), null);
  assert.match(String(validatePlatformValue("YANDEX_SA_KEY", "{\"id\":\"k\"}")), /private_key|id/);
  assert.match(String(validatePlatformValue("GITHUB_CALLBACK_URL", "api.github.com/callback")), /https/);
});

test("сохранение шифрует значения, маскирует секреты и умеет вернуть ключ к окружению", async () => {
  await withRoot(async root => {
    const platform = await import("./platform-env.js");
    const saved = await platform.savePlatformEnv({
      github_client_id: " Iv1.abc ",
      GITHUB_CLIENT_SECRET: "super-secret-value\r\n",
      YANDEX_SA_KEY: prettyKey,
      WEBNESTDEV_ENCRYPTION_KEY: "нельзя",
    });
    assert.deepEqual(saved.saved.sort(), ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "YANDEX_SA_KEY"]);
    assert.deepEqual(saved.skipped.map(item => item.name), ["WEBNESTDEV_ENCRYPTION_KEY"]);

    assert.equal(platform.getPlatformEnv("GITHUB_CLIENT_ID"), "Iv1.abc");
    assert.equal(platform.getPlatformEnv("GITHUB_CLIENT_SECRET"), "super-secret-value");
    assert.deepEqual(JSON.parse(platform.getPlatformEnv("YANDEX_SA_KEY") ?? ""), serviceAccountKey());

    const raw = await readFile(path.join(root, "platform", "env.json"), "utf8");
    assert.ok(!raw.includes("super-secret-value"), "секрет не должен лежать в файле открытым");
    assert.ok(!raw.includes("BEGIN PRIVATE KEY"), "ключ сервисного аккаунта не должен лежать открытым");

    const status = platform.platformEnvStatus();
    const secret = status.find(entry => entry.name === "GITHUB_CLIENT_SECRET");
    assert.equal(secret?.source, "panel");
    assert.match(String(secret?.value), /^supe…alue$/);
    const key = status.find(entry => entry.name === "YANDEX_SA_KEY");
    assert.match(String(key?.value), /^строк: \d+$/);
    assert.equal(status.find(entry => entry.name === "GITHUB_CLIENT_SECRET")?.value?.includes("secret"), false);

    // Пустая строка — это «вернуть как было»: ключ из панели убирается, и снова читается
    // значение выкладки, а не пустота.
    process.env.GITHUB_CLIENT_SECRET = "from-deployment";
    try {
      await platform.savePlatformEnv({ GITHUB_CLIENT_SECRET: "" });
      assert.equal(platform.platformEnvSetByPanel("GITHUB_CLIENT_SECRET"), false);
      assert.equal(platform.getPlatformEnv("GITHUB_CLIENT_SECRET"), "from-deployment");
      const after = platform.platformEnvStatus().find(entry => entry.name === "GITHUB_CLIENT_SECRET");
      assert.equal(after?.source, "environment");
    } finally { delete process.env.GITHUB_CLIENT_SECRET; }
  });
});

test("сохранённые в панели ключи сразу видны читателям сервера", async () => {
  await withRoot(async () => {
    const platform = await import("./platform-env.js");
    await platform.savePlatformEnv({
      GITHUB_CLIENT_ID: "Iv1.frompanel",
      GITHUB_CLIENT_SECRET: "panel-secret",
      YANDEX_CLOUD_ID: "b1gpj9488h3k7oaa3foh",
      YANDEX_FOLDER_ID: "b1g74qv3u70jmct1ekvf",
      YANDEX_SA_KEY: prettyKey,
      PLATFORM_AI_BASE_URL: "https://ai.example/v1",
      PLATFORM_AI_MODEL: "model-x",
      PLATFORM_AI_API_KEY: "ai-key",
      YANDEX_CLIENT_ID: "yandex-client-id",
      YANDEX_CLIENT_SECRET: "yandex-client-secret",
    });

    const { yandexNotifyConfig, yandexNotifyCredentialKind } = await import("../auth/yandex-notify.js");
    const notify = yandexNotifyConfig();
    assert.equal(notify.cloudId, "b1gpj9488h3k7oaa3foh");
    assert.equal(notify.folderId, "b1g74qv3u70jmct1ekvf");
    assert.equal(notify.credential?.kind, "rawKey");
    assert.equal(yandexNotifyCredentialKind(), "key");

    // Провайдер SMS выбирается по наличию ключа: ключ из панели включает Yandex без .env.
    const { smsConfig } = await import("../auth/sms.js");
    assert.equal(smsConfig().provider, "yandex");
    assert.equal(smsConfig().test, false);

    // Имя провайдера в окружении может быть задано иначе — проверяются значения, которые
    // панель действительно переопределяет.
    const { getPlatformProviderConfig } = await import("../provider/platform-provider.js");
    const ai = getPlatformProviderConfig();
    assert.equal(ai?.baseUrl, "https://ai.example/v1");
    assert.equal(ai?.model, "model-x");
    assert.equal(ai?.token, "ai-key");
    assert.ok(ai?.provider);

    // Yandex ID читает те же ключи, что вводит панель, — иначе подключение по кнопке
    // оставалось бы «не настроенным» даже после сохранения ключей в панели.
    const { yandexOAuthConfig } = await import("../routes/yandex.js");
    const oauth = yandexOAuthConfig();
    assert.equal(oauth.clientId, "yandex-client-id");
    assert.equal(oauth.clientSecret, "yandex-client-secret");
    // По умолчанию scope не запрашивается: права берутся из настроек приложения, а запрос
    // невыданного права (cloud-api есть уже не в каждом приложении) Яндекс отклоняет.
    assert.equal(oauth.scope, undefined);
    // Явно заданный scope возвращается как есть — панель может сузить набор прав.
    await platform.savePlatformEnv({ YANDEX_OAUTH_SCOPE: "login:info" });
    assert.equal(yandexOAuthConfig().scope, "login:info");
  });
});

test("загрузка .env не теряет хорошие ключи из-за одной плохой строки", async () => {
  await withRoot(async () => {
    const platform = await import("./platform-env.js");
    const result = await platform.savePlatformEnv({
      GITHUB_CLIENT_ID: "ok-id",
      GITHUB_CLIENT_SECRET: "ok-secret",
      YANDEX_SA_KEY: "не json",
      COMMENT: "не переменная",
    });
    assert.deepEqual(result.saved.sort(), ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
    assert.deepEqual(result.skipped.map(item => item.name).sort(), ["COMMENT", "YANDEX_SA_KEY"]);
    assert.equal(platform.getPlatformEnv("GITHUB_CLIENT_ID"), "ok-id");
  });
});
