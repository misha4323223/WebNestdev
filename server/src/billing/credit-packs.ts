import { creditPriceRub, creditSettings } from "./credit-settings.js";

/**
 * Старые идентификаторы пакетов кредитов.
 *
 * Новый интерфейс покупает любое количество кредитов, поэтому фиксированных цен здесь больше
 * нет: `priceRub` каждый раз считается по текущей ставке за 1000. Это сохраняет старым клиентам
 * привычный `packId`, но не даёт им обойти цену, которую владелец задал в админке.
 */
export type CreditPack = {
  id: string;
  credits: number;
  priceRub: number;
  name: string;
  note: string;
  recommended: boolean;
};

type CreditPackPreset = Omit<CreditPack, "priceRub">;

const PRESETS: readonly CreditPackPreset[] = [
  {
    id: "credits-1000",
    credits: 1_000,
    name: "1 000 кредитов",
    note: "Небольшая правка или короткая задача",
    recommended: false,
  },
  {
    id: "credits-5000",
    credits: 5_000,
    name: "5 000 кредитов",
    note: "Несколько задач без ожидания нового месяца",
    recommended: true,
  },
  {
    id: "credits-15000",
    credits: 15_000,
    name: "15 000 кредитов",
    note: "Для интенсивной работы над большим проектом",
    recommended: false,
  },
] as const;

export type PublicCreditPack = CreditPack & { priceLabel: string };

export function creditPackById(id: string): CreditPack | null {
  const preset = PRESETS.find(pack => pack.id === id);
  return preset ? { ...preset, priceRub: creditPriceRub(preset.credits) } : null;
}

export function publicCreditPacks(): PublicCreditPack[] {
  const settings = creditSettings();
  return PRESETS
    .filter(preset => preset.credits >= settings.minCredits && preset.credits <= settings.maxCredits)
    .map(preset => {
      const priceRub = creditPriceRub(preset.credits, settings);
      return {
        ...preset,
        priceRub,
        priceLabel: priceRub.toLocaleString("ru-RU") + " ₽",
      };
    });
}
