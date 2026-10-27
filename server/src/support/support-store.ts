import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanId } from "../account/plans.js";

/**
 * Обращения в поддержку лежат рядом с остальными данными сервера: один JSON на тикет и файл
 * скриншота рядом с ним. Это не часть рабочей области проекта, поэтому сканировать их для
 * пользователя не нужно — читает их только администратор платформы.
 */
export type SupportCategory = "bug" | "idea";

export type SupportScreenshot = { file: string; mime: string; bytes: number };

/** Как аккаунт входил на платформу. Пароль у телефонного и Яндекс-входа случайный. */
export type SupportSignIn = "password" | "phone" | "yandex";

/**
 * Снимок аккаунта на момент отправки обращения. Хранится вместе с тикетом, потому что через
 * месяц поддержке важно видеть, кем человек был тогда: тариф и проекты могли измениться, а
 * профиль — удалиться. Полная карточка на чтении собирается заново (support-user.ts).
 */
export type SupportReporter = {
  id: string;
  email: string;
  name: string | null;
  /** Почта для связи из знакомства; может отличаться от почты входа. */
  contactEmail: string | null;
  phone: string | null;
  signIn: SupportSignIn[];
  plan: PlanId;
  planName: string;
  accountCreatedAt: string;
  projects: number;
  lastActiveAt: string | null;
};

export type SupportTicket = {
  id: string;
  userId: string;
  email: string;
  category: SupportCategory;
  /** 1 — мелочь, 10 — блокирует работу. */
  severity: number;
  description: string;
  steps?: string;
  context?: string;
  /** Адрес страницы, на которой человек нажал «Поддержка», — помогает воспроизвести. */
  page?: string;
  projectId?: string;
  userAgent?: string;
  /** IP-адрес отправителя: нужен для разбора сетевых проблем и злоупотреблений. */
  ip?: string;
  /** У обращений до 2026-10-26 снимка нет; список дополняет их при чтении. */
  reporter?: SupportReporter;
  createdAt: string;
  screenshot: SupportScreenshot;
};

export type SupportTicketSummary = Omit<SupportTicket, "screenshot"> & { screenshot: { mime: string; bytes: number } };

/** Скриншот ограничен, чтобы обращение не превращалось в передачу мегабайтов через JSON. */
export const SUPPORT_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function supportDir() {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "support");
}

/**
 * Данные приходят из браузера, поэтому проверяется не только MIME из строки data URL, но и
 * сигнатура файла: под `image/png` иначе можно прислать что угодно.
 */
function decodeScreenshot(dataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) throw new Error("Скриншот должен быть изображением PNG, JPEG или WebP");
  const mime = match[1];
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("Скриншот пустой — приложите изображение ещё раз");
  if (buffer.length > SUPPORT_SCREENSHOT_MAX_BYTES) {
    throw new Error("Скриншот больше 4 МБ — приложите изображение меньшего размера");
  }
  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  const matches = (mime === "image/png" && isPng) || (mime === "image/jpeg" && isJpeg) || (mime === "image/webp" && isWebp);
  if (!matches) throw new Error("Файл не похож на изображение PNG, JPEG или WebP");
  return { mime, buffer, extension: extensions[mime] };
}

/** Идентификатор приходит из адреса, поэтому имя файла собирается только из безопасных символов. */
function safeTicketId(id: string) {
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
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

export async function createSupportTicket(input: Omit<SupportTicket, "id" | "createdAt" | "screenshot"> & { screenshot: string }) {
  const { screenshot, ...fields } = input;
  const image = decodeScreenshot(screenshot);
  const id = randomUUID();
  const dir = supportDir();
  const file = id + "." + image.extension;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), image.buffer, { mode: 0o600 });
  const ticket: SupportTicket = {
    ...fields,
    id,
    createdAt: new Date().toISOString(),
    screenshot: { file, mime: image.mime, bytes: image.buffer.length },
  };
  try {
    await writeAtomic(path.join(dir, id + ".json"), JSON.stringify(ticket, null, 2));
  } catch (error) {
    try { await unlink(path.join(dir, file)); } catch {}
    throw error;
  }
  return { id, createdAt: ticket.createdAt };
}

/**
 * Свежие обращения первыми. Повреждённый файл не должен ломать список: он пропускается, как и
 * в остальных хранилищах на диске.
 */
async function readAllSupportTickets(): Promise<SupportTicket[]> {
  const dir = supportDir();
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const tickets: SupportTicket[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const ticket = JSON.parse(await readFile(path.join(dir, name), "utf8")) as SupportTicket;
      if (ticket?.id && ticket.category && ticket.createdAt) tickets.push(ticket);
    } catch {}
  }
  return tickets.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function ticketSummary({ screenshot, ...rest }: SupportTicket): SupportTicketSummary {
  return { ...rest, screenshot: { mime: screenshot.mime, bytes: screenshot.bytes } };
}

export async function listSupportTickets(limit = 50): Promise<SupportTicketSummary[]> {
  const tickets = await readAllSupportTickets();
  return tickets
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map(ticketSummary);
}

/** Одно обращение: список отдаёт его целиком, скриншот читается отдельным запросом. */
export async function getSupportTicket(id: string): Promise<SupportTicketSummary | null> {
  const ticket = await readTicket(id);
  return ticket ? ticketSummary(ticket) : null;
}

/** Все обращения одного аккаунта — контекст для админки: повторные жалобы и их давность. */
export async function supportTicketsForUser(userId: string, limit = 20): Promise<{ total: number; tickets: SupportTicketSummary[] }> {
  const own = (await readAllSupportTickets()).filter(ticket => ticket.userId === userId);
  return {
    total: own.length,
    tickets: own.slice(0, Math.max(1, Math.min(200, limit))).map(ticketSummary),
  };
}

async function readTicket(id: string) {
  const safe = safeTicketId(id);
  if (!safe) return null;
  try {
    return JSON.parse(await readFile(path.join(supportDir(), safe + ".json"), "utf8")) as SupportTicket;
  } catch { return null; }
}

export async function readSupportScreenshot(id: string) {
  const ticket = await readTicket(id);
  if (!ticket?.screenshot?.file) return null;
  try {
    return { buffer: await readFile(path.join(supportDir(), path.basename(ticket.screenshot.file))), mime: ticket.screenshot.mime };
  } catch { return null; }
}

export type SupportMessageAuthor = "admin" | "user";
export type SupportMessageStatus = "sent" | "failed";

/**
 * Письмо в переписке обращения: ответ администратора человеку (а в будущем — и ответ человека).
 *
 * Хранится построчно (`<id>.messages.jsonl`) рядом с самим обращением. Дописывание не перезаписывает
 * предыдущие ответы, а одна повреждённая строка теряет только себя: для истории переписки это
 * важнее целостности одного файла. Неудачная отправка тоже записывается — иначе в диалоге не видно,
 * что письмо не ушло, и следующий человек отправит его повторно.
 */
export type SupportTicketMessage = {
  id: string;
  ticketId: string;
  author: SupportMessageAuthor;
  /** Почта администратора, а не слово «admin»: по переписке видно, кто именно ответил. */
  authorName: string;
  subject: string;
  body: string;
  /** Куда ушло письмо; пусто — письмо не ушло. */
  to: string;
  status: SupportMessageStatus;
  /** Причина отказа дословно: в переписке должно быть видно, что ответил Postbox. */
  error: string;
  messageId: string;
  createdAt: string;
};

function messagesFileName(id: string) {
  const safe = safeTicketId(id);
  if (!safe) throw new Error("Некорректный идентификатор обращения");
  return safe + ".messages.jsonl";
}

export async function addSupportMessage(
  input: Omit<SupportTicketMessage, "id" | "createdAt"> & { createdAt?: string },
): Promise<SupportTicketMessage> {
  const message: SupportTicketMessage = {
    ...input,
    id: randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const file = path.join(supportDir(), messagesFileName(input.ticketId));
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(message) + "\n", { encoding: "utf8", mode: 0o600 });
  return message;
}

async function readMessages(file: string): Promise<SupportTicketMessage[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const messages: SupportTicketMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as SupportTicketMessage;
      if (message?.id && message.createdAt && typeof message.body === "string") messages.push(message);
    } catch {
      // Повреждённая строка не должна скрывать остальную переписку.
    }
  }
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Переписка одного обращения: старые письма первыми — в этом порядке её читает человек. */
export async function listSupportMessages(ticketId: string): Promise<SupportTicketMessage[]> {
  const safe = safeTicketId(ticketId);
  return safe ? readMessages(path.join(supportDir(), safe + ".messages.jsonl")) : [];
}

/**
 * Переписка для страницы списка: один проход по каталогу вместо чтения файла на каждый тикет.
 * Для обращений без ответов возвращается пустой массив, а не отсутствующее поле: админке не нужно
 * различать «переписки нет» и «поле не пришло».
 */
export async function supportMessagesFor(ticketIds: string[]): Promise<Map<string, SupportTicketMessage[]>> {
  const wanted = new Set(ticketIds.filter(id => safeTicketId(id)));
  const result = new Map<string, SupportTicketMessage[]>();
  if (!wanted.size) return result;
  let names: string[] = [];
  try {
    names = await readdir(supportDir());
  } catch {
    return result;
  }
  const suffix = ".messages.jsonl";
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const id = name.slice(0, -suffix.length);
    if (!wanted.has(id)) continue;
    result.set(id, await readMessages(path.join(supportDir(), name)));
  }
  for (const id of wanted) if (!result.has(id)) result.set(id, []);
  return result;
}

/**
 * Сколько ответов поддержки ушло за сутки. Ответы считаются в тот же предел Postbox, что и
 * рассылка: у сервиса одна квота на аккаунт, и «ответы отдельно от рассылки» закончились бы
 * отказами 429 на живых людях.
 */
export async function countSupportMessagesSentSince(sinceIso: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(supportDir());
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".messages.jsonl")) continue;
    for (const message of await readMessages(path.join(supportDir(), name))) {
      if (message.status === "sent" && message.createdAt >= sinceIso) total += 1;
    }
  }
  return total;
}
