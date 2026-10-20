/**
 * Партнёрские слоты в сайдбаре.
 *
 * Спонсоров пока нет, поэтому слоты заполнены приглашениями: человек видит, как выглядит и работает
 * показ (карточка, счётчик, ротация раз в 10 минут, переход по клику), а будущая админка будет
 * писать в эту же форму — компонент и стили менять не придётся, достаточно заменить массив.
 *
 * Адрес заявки — единственное место, где он задаётся. Когда появится почта для партнёрств или форма,
 * меняется только `PARTNER_CONTACT`.
 */

/** Сколько один слот висит на экране до перехода к следующему. */
export const PARTNER_SLOT_MS = 10 * 60 * 1000;

const PARTNER_CONTACT = "mailto:partner@nestdev.ru?subject=" + encodeURIComponent("Партнёрский слот в NestDev");

export type PartnerAccent = "mint" | "amber" | "sky";

export type PartnerSlot = {
  id: string;
  /**
   * `slot` — свободное место с приглашением, `partner` — настоящий партнёр. У настоящего партнёра
   * карточка подписана «РЕКЛАМА»: это требование к рекламе, а не украшение, и его нельзя терять при
   * добавлении первого платного слота.
   */
  kind: "slot" | "partner";
  /** Короткий знак в квадрате: инициалы бренда или номер слота. */
  logo: string;
  brand: string;
  tagline: string;
  /** Подпись у перехода: что человек получит, если нажмёт. */
  cta: string;
  href: string;
  accent: PartnerAccent;
};

export const PARTNER_SLOTS: PartnerSlot[] = [
  {
    id: "invite",
    kind: "slot",
    logo: "01",
    brand: "Ваш продукт здесь",
    tagline: "Карточка в панели, где работают каждый день",
    cta: "Обсудить размещение",
    href: PARTNER_CONTACT,
    accent: "mint",
  },
  {
    id: "format",
    kind: "slot",
    logo: "02",
    brand: "Без баннеров и попапов",
    tagline: "Один спокойный слот рядом с агентом и файлами",
    cta: "Форматы и цены",
    href: PARTNER_CONTACT,
    accent: "amber",
  },
  {
    id: "cross",
    kind: "slot",
    logo: "03",
    brand: "Партнёрам NestDev",
    tagline: "Кросс-промо, совместные запуски и подписка",
    cta: "Написать нам",
    href: PARTNER_CONTACT,
    accent: "sky",
  },
];

const storageKey = "webnestdev.partnerSlot";

/**
 * Какой слот показать сейчас. Состояние переживает перезагрузку: хранится номер слота и время
 * показа, поэтому открытая через час вкладка не начинает ротацию с первого слота заново.
 */
export function partnerSlotAt(now = Date.now()): { index: number; elapsedMs: number } {
  if (!PARTNER_SLOTS.length) return { index: 0, elapsedMs: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { index?: unknown; at?: unknown } | null;
    if (!raw || typeof raw.index !== "number" || typeof raw.at !== "number") return { index: 0, elapsedMs: 0 };
    const elapsed = Math.max(0, now - raw.at);
    const steps = Math.floor(elapsed / PARTNER_SLOT_MS);
    return {
      index: (Math.floor(raw.index) + steps) % PARTNER_SLOTS.length,
      elapsedMs: elapsed % PARTNER_SLOT_MS,
    };
  } catch {
    return { index: 0, elapsedMs: 0 };
  }
}

export function rememberPartnerSlot(index: number, at = Date.now()) {
  try { localStorage.setItem(storageKey, JSON.stringify({ index, at })); } catch {}
}
