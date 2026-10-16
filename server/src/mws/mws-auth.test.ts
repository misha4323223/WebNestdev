import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mwsCredentialKind, mwsIamToken, mwsRequest, mwsSummary, parseMwsAuthorizedKey, resetMwsTokenCache, signMwsJwt } from "./mws-auth.js";

/**
 * Ключ МВС: как его пишет консоль — `keyId` вида
 * `projects/<проект>/serviceAccounts/<аккаунт>/authorizedKeys/<ключ>` и `privateKey`
 * как base64 от PKCS8 DER. Проверки подписывают JWT настоящим ключом P-256, поэтому
 * ловится и неверный алгоритм подписи, и DER вместо сырой пары R||S.
 */
const PAIR = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_KEY = PAIR.publicKey;
const AUTHORIZED_KEY = JSON.stringify({
  keyId: "projects/webnestdev/serviceAccounts/sa-agent/authorizedKeys/key-1",
  privateKey: PAIR.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  publicKey: PUBLIC_KEY.export({ format: "der", type: "spki" }).toString("base64"),
  expirationTime: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  algorithm: "ES256",
});

/**
 * Каждое имя, которое читает mws-auth.ts, а не только «основные»: рекомендуемая форма
 * ключа — две однострочные переменные (MWS_SA_KEY_ID + MWS_SA_PRIVATE_KEY), и если их не
 * гасить, тесты видят ключ из окружения разработчика и падают на «без ключа доступ не
 * предложен» именно там, где доступ настроен правильно.
 */
const ENV_NAMES = [
  "MWS_SA_KEY",
  "MWS_SA_KEY_FILE",
  "MWS_SA_KEY_ID",
  "MWS_SA_PRIVATE_KEY",
  "MWS_SA_KEY_ALGORITHM",
  "MWS_SA_KEY_EXPIRATION",
  "MWS_IAM_TOKEN",
  "MWS_IAM_HOST",
];

function clearEnv() {
  for (const name of ENV_NAMES) delete process.env[name];
  resetMwsTokenCache();
}

/** Подменяет global.fetch заглушкой, которая записывает запрос. */
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

test("без ключа доступ к МВС не предложен", () => {
  clearEnv();
  assert.equal(mwsCredentialKind(), null);
  assert.deepEqual(mwsSummary(), { configured: false });
});

test("из ключа МВС выводятся проект, сервисный аккаунт и имя ключа", () => {
  clearEnv();
  const key = parseMwsAuthorizedKey(AUTHORIZED_KEY);
  assert.equal(key.project, "webnestdev");
  assert.equal(key.serviceAccountName, "sa-agent");
  assert.equal(key.serviceAccount, "projects/webnestdev/serviceAccounts/sa-agent");
  assert.equal(key.keyName, "key-1");

  process.env.MWS_SA_KEY = AUTHORIZED_KEY;
  assert.equal(mwsCredentialKind(), "key");
  const summary = mwsSummary() as Record<string, unknown>;
  assert.equal(summary.configured, true);
  assert.equal(summary.credentialKind, "key");
  assert.equal(summary.source, "inline");
  assert.equal(summary.project, "webnestdev");
  assert.equal(summary.serviceAccount, "sa-agent");
  assert.equal(summary.keyName, "key-1");
  assert.equal(typeof summary.keyExpiresAt, "string");
});

test("JWT подписан ES256 с kid и sub сервисного аккаунта", () => {
  clearEnv();
  const key = parseMwsAuthorizedKey(AUTHORIZED_KEY);
  const now = 1_700_000_000;
  const token = signMwsJwt(key, now);
  const [header, payload, signature] = token.split(".");

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "ES256", typ: "JWT", kid: "key-1" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; iat: number; exp: number };
  assert.equal(claims.sub, "projects/webnestdev/serviceAccounts/sa-agent");
  assert.equal(claims.iat, now);
  assert.ok(claims.exp > now);

  // Подпись обязана быть сырой парой R||S (JWS): DER, который Node отдаёт по умолчанию,
  // проверяется здесь тем же способом, каким его проверяет сервер MWS.
  const ok = verifySignature("sha256", Buffer.from(header + "." + payload, "utf8"), { key: PUBLIC_KEY, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
});

test("IAM-токен запрашивается по спецификации МВС и кешируется", async t => {
  clearEnv();
  process.env.MWS_SA_KEY = AUTHORIZED_KEY;
  t.after(clearEnv);

  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      return new Response(JSON.stringify({ accessToken: "t1.mws-token", expirationTs: new Date(Date.now() + 3600 * 1000).toISOString() }), { status: 200 });
    },
    async captured => {
      assert.equal(await mwsIamToken(), "t1.mws-token");
      const { url, init } = captured();
      const parsed = new URL(url);
      // `:` — отдельный сегмент пути: без него шлюз МВС отвечает 404 на любой ключ,
      // поэтому форма взята из живого API, а не из краткой записи спецификации.
      assert.equal(parsed.origin + parsed.pathname, "https://iam.mwsapis.ru/iam/v2/tokens/:issueServiceAccountToken");
      assert.equal(parsed.searchParams.get("serviceAccount"), "projects/webnestdev/serviceAccounts/sa-agent");
      assert.equal(init.method, "GET");
      const headers = init.headers as Record<string, string>;
      // Подписанный JWT отправляется без префикса «Bearer »: с ним шлюз МВС отвечает
      // 401 «Для авторизации используйте IAM token» (проверено на живом API).
      assert.match(headers.Authorization, /^eyJ/);
      assert.doesNotMatch(headers.Authorization, /^Bearer /);
      const jwtPayload = JSON.parse(Buffer.from(headers.Authorization.split(".")[1], "base64url").toString("utf8")) as { sub: string };
      assert.equal(jwtPayload.sub, "projects/webnestdev/serviceAccounts/sa-agent");

      // Второй вызов берёт токен из кеша: обмен на каждый запрос — лишний круг и лишний
      // отказ по лимитам, а токен живёт часами.
      assert.equal(await mwsIamToken(), "t1.mws-token");
      assert.equal(calls, 1);
    },
  );
});

test("ключ можно проверить, не занося его в окружение", async t => {
  clearEnv();
  const directory = await mkdtemp(join(tmpdir(), "webnestdev-mws-key-"));
  const file = join(directory, "key.json");
  await writeFile(file, AUTHORIZED_KEY, "utf8");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    clearEnv();
  });

  assert.equal(mwsSummary().configured, false);
  await withFetch(
    () => new Response(JSON.stringify({ accessToken: "t1.from-file", expirationTs: new Date(Date.now() + 3600 * 1000).toISOString() }), { status: 200 }),
    async captured => {
      assert.equal(await mwsIamToken({ keyFile: file }), "t1.from-file");
      assert.match((captured().init.headers as Record<string, string>).Authorization, /^eyJ/);
    },
  );
});

test("отказ IAM объяснён по-разному для 401 и 403", async t => {
  clearEnv();
  process.env.MWS_SA_KEY = AUTHORIZED_KEY;
  t.after(clearEnv);

  await withFetch(
    () => new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 }),
    async () => {
      await assert.rejects(mwsIamToken(), /истёк|подпись/i);
    },
  );
});

test("сервисный аккаунт без прав назван отдельно от истёкшего ключа", async t => {
  clearEnv();
  process.env.MWS_SA_KEY = AUTHORIZED_KEY;
  t.after(clearEnv);

  await withFetch(
    () => new Response(JSON.stringify({ message: "permission denied" }), { status: 403 }),
    async () => {
      await assert.rejects(mwsIamToken(), /нет прав/i);
    },
  );
});

test("готовый токен принимается без обмена и без ключа", async t => {
  clearEnv();
  process.env.MWS_IAM_TOKEN = "t1.ready";
  t.after(clearEnv);

  assert.equal(mwsCredentialKind(), "token");
  await withFetch(
    () => new Response("{}", { status: 200 }),
    async captured => {
      const result = await mwsRequest({ path: "/rm/v3/projects" });
      assert.equal(result.ok, true);
      assert.equal((captured().init.headers as Record<string, string>).Authorization, "Bearer t1.ready");
    },
  );
});

test("ключ без keyId и ключ не на P-256 отвергаются с объяснением", () => {
  clearEnv();
  assert.throws(
    () => parseMwsAuthorizedKey(JSON.stringify({ keyId: "не-ключ", privateKey: "AAAA", algorithm: "ES256" })),
    /projects\/<проект>\/serviceAccounts/,
  );
  assert.throws(
    () => parseMwsAuthorizedKey(JSON.stringify({ keyId: "projects/p/serviceAccounts/s/authorizedKeys/k", privateKey: PAIR.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), algorithm: "RS256" })),
    /RS256/,
  );
  assert.throws(
    () => parseMwsAuthorizedKey(JSON.stringify({ keyId: "projects/p/serviceAccounts/s/authorizedKeys/k", privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), algorithm: "ES256" })),
    /P-256/,
  );
});

test("значение, вставленное не полностью, названо по форме, а не повторением формата", () => {
  clearEnv();
  // Именно так выглядела реальная вставка: вместо файла в переменную попал идентификатор
  // ключа. Сообщение обязано назвать это, иначе причина остаётся невидимой.
  assert.throws(() => parseMwsAuthorizedKey("projects/p/serviceAccounts/s/authorizedKeys/k"), /идентификатор авторизованного ключа/);
  assert.throws(() => parseMwsAuthorizedKey("eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature"), /JWT/);
  assert.throws(() => parseMwsAuthorizedKey("AAAA"), /не похоже на JSON-файл ключа/);
  // Настоящий случай: многострочный key.json вставили в однострочное поле, и от файла
  // остался только символ «{». Сообщение обязано назвать именно это.
  assert.throws(() => parseMwsAuthorizedKey("{"), /только первый символ файла/);
  assert.throws(() => parseMwsAuthorizedKey('{"keyId":"projects/p/serviceAccounts/s/authorizedKeys/k"'), /обрезалось при вставке/);
});

test("запросы разрешены только к хостам МВС", async t => {
  clearEnv();
  process.env.MWS_IAM_TOKEN = "t1.ready";
  t.after(clearEnv);

  await assert.rejects(mwsRequest({ host: "example.com", path: "/steal" }), /mwsapis\.ru/);
  await assert.rejects(mwsRequest({ path: "../secret" }), /путь/i);
});
