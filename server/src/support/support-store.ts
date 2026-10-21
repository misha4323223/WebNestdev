import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Обращения в поддержку лежат рядом с остальными данными сервера: один JSON на тикет и файл
 * скриншота рядом с ним. Это не часть рабочей области проекта, поэтому сканировать их для
 * пользователя не нужно — читает их только администратор платформы.
 */
export type SupportCategory = "bug" | "idea";

export type SupportScreenshot = { file: string; mime: string; bytes: number };

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
export async function listSupportTickets(limit = 50): Promise<SupportTicketSummary[]> {
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
  return tickets
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map(({ screenshot, ...rest }) => ({ ...rest, screenshot: { mime: screenshot.mime, bytes: screenshot.bytes } }));
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
