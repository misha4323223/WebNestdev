import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callYandexNotify, yandexNotifyCredentialKind, resetYandexNotifyCache, sendYandexSms, yandexNotifyConfigured } from "./yandex-notify.js";
import { smsConfig, smsConfigHint, smsProviderLabel } from "./sms.js";

/** An authorized key as the console issues one; RSA because the signing is PS256. */
const KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const AUTHORIZED_KEY = JSON.stringify({ id: "aje1testkey", service_account_id: "aje2testaccount", private_key: KEY_PEM });

const CREDENTIAL_NAMES = [
  "YANDEX_NOTIFY_IAM_TOKEN",
  "YANDEX_SA_KEY",
  "YANDEX_SA_KEY_FILE",
  "YANDEX_NOTIFY_ENDPOINT",
  "YANDEX_FOLDER_ID",
  "YANDEX_CLOUD_ID",
  "YANDEX_SMS_SENDER",
  "SMS_SENDER",
  "SMS_PROVIDER",
  "SMS_RU_API_ID",
  "SMSC_LOGIN",
  "SMSC_PASSWORD",
  "EXOLVE_API_KEY",
  "SMSAERO_EMAIL",
  "SMSAERO_API_KEY",
  "WEBNESTDEV_SMS_TEST_MODE",
];

function clearEnv() {
  for (const name of CREDENTIAL_NAMES) delete process.env[name];
  resetYandexNotifyCache();
}

/** Runs `body` with global.fetch replaced by a stub that records the request. */
async function withFetch(
  responder: (url: string, init: RequestInit) => Response,
  body: (captured: () => { url: string; init: RequestInit }) => Promise<void>,
) {
  const original = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured = { url: String(input), init: init ?? {} };
    return responder(captured.url, captured.init);
  }) as typeof fetch;
  try {
    await body(() => {
      assert.ok(captured, "fetch was called");
      return captured as { url: string; init: RequestInit };
    });
  } finally {
    globalThis.fetch = original;
  }
}

test("without a credential the Yandex provider is not offered", () => {
  clearEnv();
  assert.equal(yandexNotifyConfigured(), false);
  const config = smsConfig();
  assert.notEqual(config.provider, "yandex");
  assert.equal(config.test, true);
});

test("an IAM token selects Yandex Cloud Notification Service as the provider", () => {
  clearEnv();
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.test-token";
  process.env.YANDEX_CLOUD_ID = "b1gcloud";
  const config = smsConfig();
  assert.equal(config.provider, "yandex");
  assert.equal(config.test, false);
  assert.equal(smsProviderLabel(config.provider), "Yandex Cloud Notification Service");
  assert.match(smsConfigHint() ?? "", /песочниц/i);
});

test("Publish is sent as an SNS-compatible request with the IAM token", async t => {
  clearEnv();
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.test-token";
  process.env.YANDEX_CLOUD_ID = "b1gcloud";
  process.env.YANDEX_SMS_SENDER = "WebNestdev";
  t.after(clearEnv);

  await withFetch(
    () => new Response(JSON.stringify({ ResponseMetadata: { RequestId: "r1" }, PublishResult: { MessageId: "m1" } }), { status: 200 }),
    async captured => {
      const result = await sendYandexSms("+79991234567", "Код входа в WebNestdev: 123456.");
      assert.equal(result.ok, true);
      const { url, init } = captured();
      assert.equal(url, "https://notifications.yandexcloud.net/");
      assert.equal(init.method, "POST");
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer t1.test-token");
      assert.match(headers["Content-Type"], /x-www-form-urlencoded/);
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("Action"), "Publish");
      assert.equal(form.get("ResponseFormat"), "JSON");
      assert.equal(form.get("PhoneNumber"), "+79991234567");
      assert.equal(form.get("Message"), "Код входа в WebNestdev: 123456.");
      assert.equal(form.get("Account"), "b1gcloud");
      // The SNS query encoding is what the service parses; the documented flat
      // `key`/`value` form is answered with "Invalid parameter 'SenderID'".
      assert.equal(form.get("MessageAttributes.entry.1.Name"), "AWS.SNS.SMS.SenderID");
      assert.equal(form.get("MessageAttributes.entry.1.Value.DataType"), "String");
      assert.equal(form.get("MessageAttributes.entry.1.Value.StringValue"), "WebNestdev");
      assert.equal(form.get("MessageAttributes.entry.2.Name"), "AWS.SNS.SMS.SMSType");
      assert.equal(form.get("MessageAttributes.entry.2.Value.DataType"), "String");
      assert.equal(form.get("MessageAttributes.entry.2.Value.StringValue"), "Transactional");
    },
  );
});

test("a channel with a common sender is addressed by the reserved shared name", async t => {
  clearEnv();
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.test-token";
  t.after(clearEnv);

  await withFetch(
    () => new Response(JSON.stringify({ ResponseMetadata: { RequestId: "r1" } }), { status: 200 }),
    async captured => {
      assert.equal((await sendYandexSms("+79991234567", "Код: 123456")).ok, true);
      const form = new URLSearchParams(String(captured().init.body));
      // Every Yandex SMS needs a SenderID; without a registered one it is cns.shared.
      assert.equal(form.get("MessageAttributes.entry.1.Value.StringValue"), "cns.shared");
      assert.equal(form.has("Account"), false);
    },
  );
});

test("the channel state is read without sending anything", async t => {
  clearEnv();
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.test-token";
  t.after(clearEnv);

  await withFetch(
    () => new Response(JSON.stringify({ attributes: { DefaultSenderID: "cns.shared" } }), { status: 200 }),
    async captured => {
      const result = await callYandexNotify("GetSMSAttributes");
      assert.equal(result.ok, true);
      const form = new URLSearchParams(String(captured().init.body));
      // Ни PhoneNumber, ни Message: это чтение состояния канала, а не отправка.
      assert.equal(form.get("Action"), "GetSMSAttributes");
      assert.equal(form.has("PhoneNumber"), false);
      assert.equal((captured().init.headers as Record<string, string>).Authorization, "Bearer t1.test-token");
    },
  );
});

test("a service account key wins over a leftover IAM token", async t => {
  clearEnv();
  // Так выглядит установка, которую чинили: токен вставлен когда-то и остался, а ключ
  // добавили позже. Токен живёт 12 часов, поэтому ключ обязан побеждать.
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.stale";
  process.env.YANDEX_SA_KEY = AUTHORIZED_KEY;
  t.after(clearEnv);

  assert.equal(yandexNotifyCredentialKind(), "key");
  assert.equal(smsConfig().test, false);

  await withFetch(
    url => url.includes("iam/v1/tokens")
      ? new Response(JSON.stringify({ iamToken: "t1.fresh-from-key" }), { status: 200 })
      : new Response(JSON.stringify({ ResponseMetadata: { RequestId: "r1" } }), { status: 200 }),
    async captured => {
      const result = await sendYandexSms("+79991234567", "Код: 123456");
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      const headers = captured().init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer t1.fresh-from-key");
    },
  );
});

test("an expired ready-made token is explained as such, not as a generic refusal", async t => {
  clearEnv();
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.expired-by-time";
  t.after(clearEnv);

  assert.equal(yandexNotifyCredentialKind(), "token");
  // Экран входа получает объяснение до отправки: замена токена на ключ — это настройка.
  assert.match(smsConfigHint() ?? "", /12 часов/);

  await withFetch(
    () => new Response(JSON.stringify({}), { status: 401 }),
    async () => {
      const result = await sendYandexSms("+79991234567", "Код: 123456");
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /12 часов/);
      assert.match(result.ok ? "" : result.error, /YANDEX_SA_KEY/);
    },
  );
});

test("a sandbox rejection is explained, not just passed through", async t => {
  clearEnv();
  process.env.YANDEX_NOTIFY_IAM_TOKEN = "t1.test-token";
  t.after(clearEnv);

  await withFetch(
    () => new Response(JSON.stringify({
      ErrorResponse: { RequestId: "r1", Error: { Code: "UserError", SubCode: "SMSSandboxNumberNotVerified", Message: "phone not verified" } },
    }), { status: 400 }),
    async () => {
      const result = await sendYandexSms("+79991234567", "Код: 123456");
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /песочниц/i);
    },
  );
});

test("a rejected authorization is reported as such", async t => {
  clearEnv();
  // Здесь авторизуемся ключом: у него нет срока жизни, поэтому отказ означает права
  // (роль editor на каталог), а не истёкший токен — сообщение говорит именно об этом.
  process.env.YANDEX_SA_KEY = AUTHORIZED_KEY;
  t.after(clearEnv);

  await withFetch(
    url => url.includes("iam/v1/tokens")
      ? new Response(JSON.stringify({ iamToken: "t1.fresh-from-key" }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 403 }),
    async () => {
      const result = await sendYandexSms("+79991234567", "Код: 123456");
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /авторизац/i);
      assert.match(result.ok ? "" : result.error, /editor/i);
    },
  );
});

test("a malformed service account key fails loudly before any SMS is attempted", async t => {
  clearEnv();
  process.env.YANDEX_SA_KEY = "not-json";
  t.after(clearEnv);

  const result = await sendYandexSms("+79991234567", "Код: 123456");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /authorized key/i);
});

test("an inline key cut off at the first line hands over to the configured key file", async t => {
  clearEnv();
  const directory = await mkdtemp(join(tmpdir(), "webnestdev-sa-key-"));
  const file = join(directory, "key.json");
  await writeFile(file, AUTHORIZED_KEY, "utf8");
  // A multi-line paste into a one-line field keeps only the opening brace.
  process.env.YANDEX_SA_KEY = "{";
  process.env.YANDEX_SA_KEY_FILE = file;
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    clearEnv();
  });

  assert.equal(yandexNotifyConfigured(), true);

  await withFetch(
    url => url.includes("iam/v1/tokens")
      ? new Response(JSON.stringify({ iamToken: "t1.from-key-file" }), { status: 200 })
      : new Response(JSON.stringify({ ResponseMetadata: { RequestId: "r1" }, PublishResult: { MessageId: "m1" } }), { status: 200 }),
    async captured => {
      const result = await sendYandexSms("+79991234567", "Код: 123456");
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      // The token exchanged from the file's key is what reaches the Publish call, so the
      // unusable inline value was skipped rather than signed into a broken JWT.
      const headers = captured().init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer t1.from-key-file");
    },
  );
});
