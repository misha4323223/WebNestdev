import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { createSession, createUser } from "../auth/auth-store.js";
import { SESSION_COOKIE } from "../auth/auth.js";
import { getPayment, getSubscriptionRecord, planForUser } from "../billing/store.js";
import { resultSignatureBase, signValue } from "../billing/robokassa.js";
import { registerBillingRoutes } from "./billing.js";

const MANAGED = ["ROBOKASSA_LOGIN", "ROBOKASSA_PASSWORD_1", "ROBOKASSA_PASSWORD_2", "ROBOKASSA_HASH", "ROBOKASSA_TEST_MODE", "ROBOKASSA_RECURRING"] as const;
const PASSWORD2 = "pass2";

async function withShop<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  process.env.ROBOKASSA_LOGIN = "nestdev";
  process.env.ROBOKASSA_PASSWORD_1 = "pass1";
  process.env.ROBOKASSA_PASSWORD_2 = PASSWORD2;
  process.env.ROBOKASSA_HASH = "md5";
  delete process.env.ROBOKASSA_TEST_MODE;
  delete process.env.ROBOKASSA_RECURRING;
  try { return await run(); }
  finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function shopApp() {
  const app = Fastify();
  await app.register(cookie);
  await registerBillingRoutes(app);
  await app.ready();
  return app;
}

async function signedInUser() {
  const email = "billing-" + randomUUID() + "@example.com";
  const user = await createUser(email, "password-123");
  const session = await createSession(user.id);
  return { user, cookie: SESSION_COOKIE + "=" + session.id };
}

function resultBody(invId: number, outSum: string, signature = signValue(resultSignatureBase(outSum, invId, PASSWORD2), "md5")) {
  return new URLSearchParams({ OutSum: outSum, InvId: String(invId), SignatureValue: signature }).toString();
}

test("checkout requires a session and refuses to invent a price for the free plan", async () => {
  await withShop(async () => {
    const app = await shopApp();
    try {
      const anonymous = await app.inject({ method: "POST", url: "/api/billing/checkout", payload: { plan: "pro" } });
      assert.equal(anonymous.statusCode, 401);

      const { cookie } = await signedInUser();
      const free = await app.inject({ method: "POST", url: "/api/billing/checkout", headers: { cookie }, payload: { plan: "free" } });
      assert.equal(free.statusCode, 400, "бесплатный тариф не выставляется счётом");
    } finally { await app.close(); }
  });
});

test("checkout creates a pending invoice and returns a signed Robokassa link", async () => {
  await withShop(async () => {
    const app = await shopApp();
    try {
      const { user, cookie } = await signedInUser();
      const response = await app.inject({ method: "POST", url: "/api/billing/checkout", headers: { cookie }, payload: { plan: "pro" } });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { invId: number; paymentUrl: string; amount: number; currency: string };
      assert.equal(body.amount, 990);
      assert.equal(body.currency, "RUB");
      const url = new URL(body.paymentUrl);
      assert.equal(url.searchParams.get("InvId"), String(body.invId));
      assert.equal(url.searchParams.get("OutSum"), "990.00");
      assert.equal(url.searchParams.get("SignatureValue"), signValue("nestdev:990.00:" + body.invId + ":pass1", "md5"));

      const payment = await getPayment(body.invId);
      assert.equal(payment?.userId, user.id);
      assert.equal(payment?.status, "pending");
      assert.equal(await planForUser(user.id), "free", "до уведомления тариф не меняется");
    } finally { await app.close(); }
  });
});

test("a valid ResultURL activates the plan, answers OK{InvId} and is idempotent", async () => {
  await withShop(async () => {
    const app = await shopApp();
    try {
      const { user, cookie } = await signedInUser();
      const checkout = (await app.inject({ method: "POST", url: "/api/billing/checkout", headers: { cookie }, payload: { plan: "pro" } })).json() as { invId: number };

      const notification = await app.inject({
        method: "POST",
        url: "/api/billing/robokassa/result",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: resultBody(checkout.invId, "990.000000"),
      });
      assert.equal(notification.statusCode, 200);
      assert.equal(notification.body, "OK" + checkout.invId, "Робокасса ждёт ровно OK и номер счёта");
      assert.equal(await planForUser(user.id), "pro");
      const record = await getSubscriptionRecord(user.id);
      assert.ok(record && new Date(record.renewsAt).getTime() > Date.now());
      assert.equal(record?.autoRenew, false, "без услуги периодических платежей автопродление не включается");

      const repeated = await app.inject({
        method: "POST",
        url: "/api/billing/robokassa/result",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: resultBody(checkout.invId, "990.000000"),
      });
      assert.equal(repeated.statusCode, 200);
      assert.equal((await getSubscriptionRecord(user.id))?.renewsAt, record?.renewsAt, "повтор не продлевает второй раз");
    } finally { await app.close(); }
  });
});

test("a forged signature or a different amount never activates the plan", async () => {
  await withShop(async () => {
    const app = await shopApp();
    try {
      const { user, cookie } = await signedInUser();
      const checkout = (await app.inject({ method: "POST", url: "/api/billing/checkout", headers: { cookie }, payload: { plan: "team" } })).json() as { invId: number };

      const forged = await app.inject({
        method: "POST",
        url: "/api/billing/robokassa/result",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: resultBody(checkout.invId, "2990.00", "0".repeat(32)),
      });
      assert.equal(forged.statusCode, 400);
      assert.equal(await planForUser(user.id), "free", "поддельное уведомление ничего не включает");

      // Верная подпись на другую сумму: подпись сходится, но счёт был на 2 990.
      const cheap = await app.inject({
        method: "POST",
        url: "/api/billing/robokassa/result",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: resultBody(checkout.invId, "1.00"),
      });
      assert.equal(cheap.statusCode, 400);
      assert.match(cheap.body, /Amount mismatch/);
      assert.equal(await planForUser(user.id), "free");
      assert.equal((await getPayment(checkout.invId))?.status, "pending");
    } finally { await app.close(); }
  });
});

test("the browser return only redirects to the panel and enables nothing by itself", async () => {
  await withShop(async () => {
    const app = await shopApp();
    try {
      const success = await app.inject({ method: "GET", url: "/api/billing/robokassa/success?InvId=42" });
      assert.equal(success.statusCode, 302);
      assert.match(String(success.headers.location), /\/\?payment=success&inv=42$/);
      const fail = await app.inject({ method: "GET", url: "/api/billing/robokassa/fail?InvId=42" });
      assert.equal(fail.statusCode, 302);
      assert.match(String(fail.headers.location), /\/\?payment=fail&inv=42$/);
    } finally { await app.close(); }
  });
});

test("auto-renew cannot be promised before the shop enables recurring payments", async () => {
  await withShop(async () => {
    const app = await shopApp();
    try {
      const { cookie } = await signedInUser();
      const response = await app.inject({ method: "POST", url: "/api/billing/subscription", headers: { cookie }, payload: { autoRenew: true } });
      assert.equal(response.statusCode, 409);
      assert.match(response.body, /Периодические платежи/);
    } finally { await app.close(); }
  });
});
