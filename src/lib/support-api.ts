import { apiJson } from "./api";

export type SupportCategory = "bug" | "idea";

export type SupportTicketInput = {
  category: SupportCategory;
  /** 1 — мелочь, 10 — блокирует работу. */
  severity: number;
  description: string;
  steps?: string;
  context?: string;
  page?: string;
  projectId?: string;
  /** data URL картинки: сервер проверяет сигнатуру и размер. */
  screenshot: string;
};

export const sendSupportTicket = (input: SupportTicketInput) =>
  apiJson<{ ok: true; id: string; createdAt: string }>("/api/support", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
