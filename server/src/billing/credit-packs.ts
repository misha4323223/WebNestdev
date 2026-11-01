/**
 * Пакеты кредитов для докупки сверх месячного лимита тарифа.
 *
 * Цена и количество живут на сервере: браузер присылает только id пакета, а сумму для счёта
 * берёт отсюда. Так покупатель не может подменить стоимость запросом, а витрина и Робокасса
 * всегда говорят одну и ту же цифру.
 *
 * Докупленные кредиты не сгорают и не входят в месячный сброс. Они расходуются после кредитов
 * тарифа — см. `credit-store.ts` и `account/usage-store.ts`.
 */
export type CreditPack = {
  id: string;
  credits: number;
  priceRub: number;
  name: string;
  note: string;
  recommended: boolean;
};

export const CREDIT_PACKS: readonly CreditPack[] = [
  {
    id: "credits-1000",
    credits: 1_000,
    priceRub: 290,
    name: "1 000 кредитов",
    note: "Небольшая правка или короткая задача",
    recommended: false,
  },
  {
    id: "credits-5000",
    credits: 5_000,
    priceRub: 1_190,
    name: "5 000 кредитов",
    note: "Несколько задач без ожидания нового месяца",
    recommended: true,
  },
  {
    id: "credits-15000",
    credits: 15_000,
    priceRub: 2_990,
    name: "15 000 кредитов",
    note: "Для интенсивной работы над большим проектом",
    recommended: false,
  },
] as const;

export type PublicCreditPack = CreditPack & { priceLabel: string };

export function creditPackById(id: string): CreditPack | null {
  return CREDIT_PACKS.find(pack => pack.id === id) ?? null;
}

export function publicCreditPacks(): PublicCreditPack[] {
  return CREDIT_PACKS.map(pack => ({
    ...pack,
    priceLabel: pack.priceRub.toLocaleString("ru-RU") + " ₽",
  }));
}
