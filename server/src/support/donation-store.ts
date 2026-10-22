import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Добровольная поддержка проекта.
 *
 * Донат — не подписка и не тариф: он ничего не включает, поэтому и не живёт в billing/store.
 * Здесь только сумма, сообщение и состояние платежа. Один файл на донат, как у обращений в
 * поддержку: сообщения позже будет забирать почтовый сервис, и ему не нужен общий список.
 *
 * `recorded` — приём платежей ещё не настроен, сумма и сообщение сохранены; `pending` — счёт в
 * Робокассе выставлен; `paid` — пришло уведомление с верной подписью.
 */
export type Donation = {
  id: string;
  userId: string;
  email: string;
  amount: number;
  message: string;
  status: "recorded" | "pending" | "paid";
  /** Номер счёта Робокассы; null, когда оплата ещё не подключена. */
  invId: number | null;
  createdAt: string;
  paidAt: string | null;
};

function donationsDir() {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "donations");
}

async function writeAtomic(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

/** Все сохранённые донаты. Повреждённый файл пропускается: он не должен ломать остальные. */
async function readAll(): Promise<Donation[]> {
  let names: string[] = [];
  try { names = await readdir(donationsDir()); } catch { return []; }
  const donations: Donation[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const donation = JSON.parse(await readFile(path.join(donationsDir(), name), "utf8")) as Donation;
      if (donation?.id && donation.createdAt && Number.isFinite(donation.amount)) donations.push(donation);
    } catch {}
  }
  return donations;
}

export async function createDonation(input: {
  userId: string;
  email: string;
  amount: number;
  message: string;
  invId: number | null;
}): Promise<Donation> {
  const donation: Donation = {
    id: randomUUID(),
    userId: input.userId,
    email: input.email,
    amount: input.amount,
    message: input.message,
    status: input.invId ? "pending" : "recorded",
    invId: input.invId,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  await writeAtomic(path.join(donationsDir(), donation.id + ".json"), JSON.stringify(donation, null, 2));
  return donation;
}

/** Уведомление Робокассы приходит по InvId, поэтому донат ищется по номеру счёта. */
export async function getDonationByInvoice(invId: number): Promise<Donation | null> {
  return (await readAll()).find(donation => donation.invId === invId) ?? null;
}

/** Подтверждение оплаты. Возвращает null, если счёт не наш — вызывающий сам решит, что это. */
export async function markDonationPaid(invId: number): Promise<Donation | null> {
  const donation = await getDonationByInvoice(invId);
  if (!donation) return null;
  if (donation.status === "paid") return donation;
  const paid: Donation = { ...donation, status: "paid", paidAt: new Date().toISOString() };
  await writeAtomic(path.join(donationsDir(), donation.id + ".json"), JSON.stringify(paid, null, 2));
  return paid;
}
