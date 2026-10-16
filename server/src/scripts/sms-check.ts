/**
 * Проверка отправки SMS для входа по номеру.
 *
 * Запуск:
 *   npm run sms:check --workspace=server
 *   npm run sms:check --workspace=server -- --to +79991234567
 *
 * Без `--to` ничего не отправляется: печатается активный провайдер, способ аутентификации и
 * (для Yandex) состояние канала — это то, чего не хватало, чтобы отличить «канал в песочнице»,
 * «нет прав у сервисного аккаунта» и «ключ не дошёл до контейнера». С `--to` уходит настоящее
 * сообщение: оно тратит деньги, поэтому только по явному флагу.
 *
 * Последняя строка — машинный вердикт `SMS-CHECK=…`, как `MWS-ACCESS=…` у проверки МВС.
 */
import { sendLoginCode, smsConfig, smsConfigHint, smsProviderLabel, smsSummary } from "../auth/sms.js";
import { callYandexNotify } from "../auth/yandex-notify.js";

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const config = smsConfig();
const summary = smsSummary();
console.log("[sms] провайдер: " + smsProviderLabel(config.provider) + " (" + (config.provider ?? "не подключён") + "), отправитель: " + config.sender);
console.log("[sms] тестовый режим: " + (config.test ? "да — сообщения не отправляются, код пишется в лог сервера" : "нет"));
console.log("[sms] аутентификация: " + (summary.credentialKind === null ? "не нужна" : summary.credentialKind === "key" ? "ключ сервисного аккаунта (токен берётся сам)" : "готовый IAM-токен"));
const hint = smsConfigHint();
if (hint) console.log("[sms] ограничение провайдера: " + hint);

if (!config.provider) {
  console.log("SMS-CHECK=no-provider");
  process.exit(1);
}

if (config.provider === "yandex") {
  // Чтение состояния канала: ни одного сообщения не отправляется, но видно, что настроено
  // в Yandex Cloud. Песочница отдаёт отказ именно на отправке, а права и канал — здесь.
  const attributes = await callYandexNotify("GetSMSAttributes");
  const body = attributes.body.replace(/\s+/g, " ").slice(0, 400);
  console.log("[sms] состояние канала Yandex (GetSMSAttributes): HTTP " + attributes.status + " " + body);
}

const to = flag("--to")?.replace(/[\s()-]/g, "");
if (!to) {
  console.log("[sms] отправка не проверялась: добавьте --to <номер>, чтобы отправить настоящее сообщение");
  console.log("SMS-CHECK=" + (config.test ? "test-mode" : "configured"));
  process.exit(config.test ? 1 : 0);
}

// Код здесь заведомо нерабочий: цель — увидеть, принимает ли провайдер сообщение на этот
// номер, а не выдать кому-то вход.
const result = await sendLoginCode(to, "000000");
console.log("[sms] отправка на " + to + ": " + (result.ok ? "провайдер принял сообщение" : "отказ — " + result.error));
console.log("SMS-CHECK=" + (result.ok ? "sent" : "rejected"));
process.exit(result.ok ? 0 : 1);
