import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health.js";

/**
 * Публичный health не должен быть картой внутреннего устройства: пути песочниц, очереди и
 * адреса предпросмотров остаются только для запроса с loopback. Заодно проверяется, что
 * `build` — по-прежнему в обоих ответах: на нём держится сверка выкатки.
 */
/**
 * Почта в health: откуда взят ключ, чем представляется письмо и настроена ли рассылка. Разбор
 * «ответ из админки не уходит» начинался с чтения .env на ВМ — теперь эти ответы видны снаружи.
 */
// Чистятся и ключи рассылки: на машине разработчика может быть свой ключ сервисного аккаунта,
// и тогда «каким ключом подписано» проверяло бы окружение, а не тест.
const MAIL_ENV = [
  "MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_FROM", "MAIL_FROM_NAME",
  "POSTBOX_KEY_ID", "POSTBOX_SECRET", "POSTBOX_SENDER", "POSTBOX_FROM_NAME",
  "POSTBOX_IAM_TOKEN", "POSTBOX_STATIC_KEY_ID", "POSTBOX_STATIC_SECRET",
  "POSTBOX_SA_KEY", "POSTBOX_SA_KEY_FILE", "YANDEX_SA_KEY", "YANDEX_SA_KEY_FILE",
] as const;

async function withMailEnv<T>(values: Partial<Record<(typeof MAIL_ENV)[number], string>>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(MAIL_ENV.map(name => [name, process.env[name]]));
  try {
    for (const name of MAIL_ENV) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("health отличает ключ SMTP от ключа рассылки и говорит, готова ли почта", async () => {
  const app = Fastify();
  try {
    await registerHealthRoutes(app);
    await app.ready();

    await withMailEnv({ POSTBOX_KEY_ID: "aje-key", POSTBOX_SECRET: "aje-secret", POSTBOX_SENDER: "noreply@nestdev.ru" }, async () => {
      const response = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.10" });
      const mail = (response.json() as { mail: Record<string, unknown> }).mail;
      assert.equal(mail.provider, "postbox");
      assert.equal(mail.sender, "noreply@nestdev.ru");
      assert.equal(mail.credentialKind, "smtp-key", "пара POSTBOX_KEY_ID/SECRET — ключ SMTP, а не рассылки");
      assert.equal(mail.ready, true, "письма платформы на этом ключе работают");

      const campaigns = mail.campaigns as { configured: boolean; reason?: string };
      assert.equal(campaigns.configured, false, "для REST нужен другой ключ — иначе Postbox ответит 403");
      assert.match(campaigns.reason ?? "", /403|SMTP/);
    });

    await withMailEnv({ MAIL_SMTP_HOST: "postbox.cloud.yandex.net", MAIL_SMTP_USER: "key", MAIL_SMTP_PASSWORD: "secret", MAIL_FROM: "noreply@nestdev.ru" }, async () => {
      const response = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.10" });
      const mail = (response.json() as { mail: Record<string, unknown> }).mail;
      assert.equal(mail.credentialKind, "smtp-credentials");
      assert.equal(mail.credentialSource, "MAIL_SMTP");
      assert.equal(mail.ready, true);
    });

    await withMailEnv({}, async () => {
      const response = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.10" });
      const mail = (response.json() as { mail: Record<string, unknown> }).mail;
      assert.equal(mail.ready, false, "без ключей почта честно не готова");
      assert.equal(mail.sender, null);
    });
  } finally {
    await app.close();
  }
});

test("health отдаёт подробности только loopback-запросу", async () => {
  const app = Fastify();
  try {
    await registerHealthRoutes(app);
    await app.ready();

    const external = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.10" });
    assert.equal(external.statusCode, 200, external.body);
    const publicBody = external.json() as Record<string, unknown>;
    assert.equal(typeof publicBody.build, "string");
    assert.equal(publicBody.sandbox, undefined);
    assert.equal(publicBody.activity, undefined);

    const internal = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "127.0.0.1" });
    assert.equal(internal.statusCode, 200, internal.body);
    const internalBody = internal.json() as Record<string, unknown>;
    assert.equal(typeof internalBody.build, "string");
    assert.ok(internalBody.sandbox, "loopback-ответ содержит состояние песочницы");
    assert.ok(internalBody.activity, "loopback-ответ содержит метрики хоста");
  } finally {
    await app.close();
  }
});
