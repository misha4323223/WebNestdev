/**
 * Юридические документы и реквизиты продавца — в одном месте.
 *
 * Ссылки на документы стоят в подвале главной, на экране входа, в окне тарифов и в
 * cookie-баннере. Если бы каждая поверхность помнила свой адрес, половина ссылок вела бы в
 * никуда после переименования страницы, а реквизиты в оферте и в подвале разошлись бы. Поэтому
 * маршрут, название и данные продавца лежат здесь, а тексты — в features/legal/legal-docs.ts.
 */

export type LegalDocId =
  | "offer"
  | "terms"
  | "privacy"
  | "consent"
  | "cookies"
  | "payments"
  | "marketing"
  | "contacts";

export type LegalDocMeta = {
  id: LegalDocId;
  title: string;
  short: string;
  summary: string;
  group: "Договор" | "Данные" | "Оплата" | "Согласия" | "Сведения";
};

export const SITE = {
  name: "NestDev",
  domain: "nestdev.ru",
  url: "https://nestdev.ru",
  /** Редакция документов: одна дата на все страницы, чтобы не расходились версии. */
  updated: "20 октября 2026 г.",
  version: "1.0",
};

/**
 * Реквизиты продавца. Пустые поля не выдумываются: на странице они показываются заметной
 * пометкой «заполните», иначе недозаполненная оферта выглядит как готовая.
 *
 * Статус взят из документации проекта по оплате (docs/ROBOKASSA.md): самозанятый на НПД,
 * поэтому ОГРНИП не нужен, а чек формируется в «Мой налог». Если продавец — ИП или ООО,
 * здесь меняются status, fullName и ogrnip, а в docs/LEGAL.md описан чек-лист.
 */
export const SELLER = {
  status: "Самозанятый (плательщик налога на профессиональный доход)",
  /** Для НПД обязательны ФИО полностью и ИНН; ОГРНИП у самозанятого отсутствует. */
  fullName: "Пимашин Михаил Игоревич",
  inn: "711612442203",
  ogrnip: "",
  city: "",
  email: "nestdev@mail.ru",
  phone: "+7 953 181-41-36",
  phoneHref: "+79531814136",
  supportHours: "Пн–Пт, 10:00–19:00 (МСК)",
  site: "https://nestdev.ru",
};

/**
 * Подписи для незаполненных реквизитов. Пустая строка в оферте выглядит как готовая редакция,
 * поэтому на странице вместо неё стоит заметная пометка с тем, что именно нужно вписать.
 */
export const REQUISITE_HINTS = {
  fullName: "ФИО полностью",
  city: "город",
  ogrnip: "ОГРНИП, если продавец — ИП",
};

export function requisite(value: string, hint: string): { pending: boolean; text: string } {
  return value.trim() ? { pending: false, text: value.trim() } : { pending: true, text: hint };
}

export const LEGAL_DOCS: LegalDocMeta[] = [
  {
    id: "offer",
    title: "Публичная оферта",
    short: "Оферта",
    summary: "Договор возмездного оказания услуг: предмет, оплата, приёмка, возврат и ответственность.",
    group: "Договор",
  },
  {
    id: "terms",
    title: "Пользовательское соглашение",
    short: "Соглашение",
    summary: "Правила работы с аккаунтом, проектами, ИИ-функциями и допустимое использование сервиса.",
    group: "Договор",
  },
  {
    id: "privacy",
    title: "Политика обработки персональных данных",
    short: "Персональные данные",
    summary: "Какие данные собираем, зачем, кому передаём, сколько храним и как отозвать согласие.",
    group: "Данные",
  },
  {
    id: "consent",
    title: "Согласие на обработку персональных данных",
    short: "Согласие",
    summary: "Текст согласия, которое вы даёте при регистрации по номеру телефона.",
    group: "Данные",
  },
  {
    id: "cookies",
    title: "Политика cookie",
    short: "Cookie",
    summary: "Какие cookie и локальные настройки нужны для входа, предпросмотра и удобства.",
    group: "Данные",
  },
  {
    id: "payments",
    title: "Оплата, подписка и возврат",
    short: "Оплата и возврат",
    summary: "Тарифы, способы оплаты, автопродление, чеки и порядок возврата денег.",
    group: "Оплата",
  },
  {
    id: "marketing",
    title: "Согласие на рекламные сообщения",
    short: "Реклама",
    summary: "Как согласиться на письма о продукте и как отказаться в один клик.",
    // Согласие на рекламу — не документ об оплате: подпись группы стоит над заголовком
    // страницы и при печати, и «ОПЛАТА» над текстом, где ничего не оплачивают, путала.
    group: "Согласия",
  },
  {
    id: "contacts",
    title: "Реквизиты и контакты",
    short: "Реквизиты",
    summary: "Продавец, ИНН, контакты поддержки и порядок юридически значимых обращений.",
    group: "Сведения",
  },
];

export function legalDoc(id: LegalDocId): LegalDocMeta {
  const found = LEGAL_DOCS.find(doc => doc.id === id);
  if (!found) throw new Error("Неизвестный документ: " + id);
  return found;
}

export const legalPath = (id: LegalDocId) => "/legal/" + id;

/** Юридические страницы живут по обычным адресам: их можно открыть без входа и дать ссылку. */
export function isLegalPath(pathname: string): boolean {
  return pathname === "/legal" || pathname === "/legal/" || pathname.startsWith("/legal/");
}

export function legalDocFromPath(pathname: string): LegalDocId | null {
  const slug = pathname.replace(/^\/legal\/?/, "").replace(/\/+$/, "");
  return LEGAL_DOCS.some(doc => doc.id === slug) ? (slug as LegalDocId) : null;
}

/** Ссылки для подвала и форм: короткий список того, что нужно видеть до оплаты. */
export const LEGAL_FOOTER_LINKS: LegalDocId[] = ["offer", "terms", "privacy", "payments", "cookies", "contacts"];
