import { apiJson } from "./api";

/**
 * Добровольная поддержка проекта. `paymentUrl` есть только когда на сервере настроен приём
 * платежей; без него сумма и сообщение сохраняются, а окно говорит об этом честно.
 */
export type DonationResult = {
  ok: boolean;
  id: string;
  status: "recorded" | "pending" | "paid";
  amount: number;
  paymentUrl: string | null;
};

export const sendDonation = (input: { amount: number; message: string }) => apiJson<DonationResult>("/api/donations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input),
});
