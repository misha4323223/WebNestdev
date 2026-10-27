import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LetterSend } from "./notify.js";
import type { SubscriptionRecord } from "./store.js";

/**
 * Письма читают аккаунты и контакты из общего каталога данных, поэтому у файла свой:
 * `node --test` даёт каждому файлу отдельный процесс, и переменная встаёт раньше, чем хранилище
 * вычислит путь. Импорт поэтому динамический — статический выполнился бы до присваивания.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-notify-"));
process.env.WEBNESTDEV_DATA_DIR = root;
const { createUser } = await import("../auth/auth-store.js");
const { saveUserProfile } = await import("../account/profile-store.js");
const { autoRenewRefusal, notifyPaymentPaid, reachableEmailFor, renewalNoticeDays, sendRenewalNotice } = await import("./notify.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const MANAGED = ["MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_FROM", "BILLING_NOTICE_DAYS"] as const;

async function withEnv<T>(values: Partial<Record<(typeof MANAGED)[number], string>>, run: () => T | Promise<T>): Promise<T> {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const POSTBOX = {
  MAIL_SMTP_HOST: "postbox.cloud.yandex.net",
  MAIL_SMTP_USER: "key-id",
  MAIL_SMTP_PASSWORD: "key-secret",
  MAIL_FROM: "noreply@nestdev.ru",
};

const serviceEmail = () => "billing-" + randomUUID() + "@phone.webnestdev.local";
const realEmail = () => "billing-" + randomUUID() + "@example.com";

function capture() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const send: LetterSend = async input => { sent.push(input); };
  return { sent, send };
}

test("служебный адрес входа не считается почтой, а контакт из знакомства — да", async () => {
  const phone = await createUser(serviceEmail(), "password-123");
  assert.equal(await reachableEmailFor(phone), null, "по телефону письмо не дойдёт");

  await saveUserProfile(phone.id, { name: "Анна", email: "Anna@Example.com", newsletter: false, productUpdates: false });
  assert.equal(await reachableEmailFor(phone), "anna@example.com", "почта знакомства приводится к нижнему регистру");

  const mail = await createUser(realEmail(), "password-123");
  assert.equal(await reachableEmailFor(mail), mail.email, "настоящий адрес входа годится сам по себе");
});

test("письмо об оплате называет тариф, сумму и дату, а без почты не отправляется", async () => {
  const user = await createUser(realEmail(), "password-123");
  const { sent, send } = capture();
  const delivered = await notifyPaymentPaid(
    { userId: user.id, plan: "pro", amount: 990, invId: 100001, renewsAt: "2026-11-15T10:00:00.000Z", autoRenew: true },
    send,
  );
  assert.equal(delivered, true);
  assert.equal(sent[0]?.to, user.email);
  assert.match(sent[0]?.subject ?? "", /Оплата принята/);
  assert.match(sent[0]?.subject ?? "", /Плюс/);
  assert.match(sent[0]?.text ?? "", /990 ₽/);
  assert.match(sent[0]?.text ?? "", /Оплачено до: 15 ноября 2026/);
  assert.match(sent[0]?.text ?? "", /Автопродление включено/);

  // Аккаунту без почты отправить некуда — это не ошибка, а честный отказ.
  const silent = await createUser(serviceEmail(), "password-123");
  const skipped = await notifyPaymentPaid(
    { userId: silent.id, plan: "pro", amount: 990, invId: 100002, renewsAt: "2026-11-15T10:00:00.000Z", autoRenew: false },
    async () => { throw new Error("письма быть не должно"); },
  );
  assert.equal(skipped, false);
});

test("предупреждение о списании объясняет, сколько, когда и как отключить", async () => {
  const user = await createUser(realEmail(), "password-123");
  const record: SubscriptionRecord = {
    userId: user.id,
    plan: "team",
    status: "active",
    startedAt: "2026-10-01T09:00:00.000Z",
    renewsAt: "2026-11-01T09:00:00.000Z",
    autoRenew: true,
    parentInvId: 100001,
    noticeAt: null,
    renewalAttempts: 0,
    updatedAt: "2026-10-01T09:00:00.000Z",
  };
  const { sent, send } = capture();
  assert.equal(await sendRenewalNotice(record, send), true);
  // Сумма печатается с неразрывным пробелом между разрядами — проверяем вид, а не код символа.
  assert.match(sent[0]?.subject ?? "", /Скоро спишем 2[\s\u00A0\u202F]990[\s\u00A0\u202F]₽/);
  assert.match(sent[0]?.text ?? "", /Дата списания: 1 ноября 2026/);
  assert.match(sent[0]?.text ?? "", /отключите его в личном кабинете/);
  assert.match(sent[0]?.text ?? "", /бесплатный тариф/, "честно сказано, чем закончится неудача карты");
});

test("включить автопродление нельзя без почтовой службы и без адреса", async () => {
  const mail = await createUser(realEmail(), "password-123");
  const phone = await createUser(serviceEmail(), "password-123");

  await withEnv({}, async () => {
    assert.match(String(await autoRenewRefusal(mail)), /почтовая служба платформы не настроена/);
  });
  await withEnv(POSTBOX, async () => {
    assert.match(String(await autoRenewRefusal(phone)), /нужна почта/);
    assert.equal(await autoRenewRefusal(mail), null, "с адресом и настроенной почтой продление можно включать");

    await saveUserProfile(phone.id, { name: "Иван", email: "ivan@example.com", newsletter: false, productUpdates: false });
    assert.equal(await autoRenewRefusal(phone), null, "контакт из знакомства тоже годится");
  });
});

test("срок предупреждения: по умолчанию три дня, из ключа — своё значение", async () => {
  await withEnv({}, () => assert.equal(renewalNoticeDays(), 3));
  await withEnv({ BILLING_NOTICE_DAYS: "7" }, () => assert.equal(renewalNoticeDays(), 7));
  await withEnv({ BILLING_NOTICE_DAYS: "сто" }, () => assert.equal(renewalNoticeDays(), 3, "мусор не гадаем"));
  await withEnv({ BILLING_NOTICE_DAYS: "120" }, () => assert.equal(renewalNoticeDays(), 3, "за месяц никто не предупреждает"));
});
