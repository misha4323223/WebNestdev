/**
 * Деньги — не тот ресурс, которым распоряжается агент.
 *
 * Разрешение на изменения в карточке интеграции означает «создавай и настраивай ресурсы
 * проекта», а не «меняй тариф, привяжи карту или оплати счёт». Проверка стоит в одном месте,
 * чтобы облака и Yandex Cloud отвечали одинаково: чтение биллинга разрешено (человеку полезно
 * видеть баланс), а любой меняющий вызов отклоняется до сети.
 */

const BILLING_PATH = /(^|\/)(billing|payments?|invoices?|tariffs?|subscriptions?|balance)(\/|$)/i;
const READ_METHODS = new Set(["GET", "HEAD"]);

export function isBillingPath(path: string) {
  return BILLING_PATH.test(path.trim());
}

export function assertNoBillingChange(method: string, path: string) {
  if (!READ_METHODS.has(method.toUpperCase()) && isBillingPath(path)) {
    throw new Error(
      "Оплата, тарифы и биллинг меняются только человеком в кабинете провайдера — агент этого не делает даже с разрешением на изменения.",
    );
  }
}
