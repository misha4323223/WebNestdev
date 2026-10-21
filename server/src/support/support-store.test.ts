import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Каталог задаётся до первого вызова хранилища: путь читается лениво, поэтому тест не трогает
// рабочие данные разработчика.
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "wnd-support-"));
const { createSupportTicket, listSupportTickets, readSupportScreenshot, SUPPORT_SCREENSHOT_MAX_BYTES } = await import("./support-store.js");

/** 1×1 прозрачный PNG: достаточная сигнатура, чтобы проверка файла прошла. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const base = {
  userId: "u1",
  email: "probe@example.com",
  category: "bug" as const,
  severity: 7,
  description: "Кнопка отправки не работает на телефоне",
  steps: "Открыть проект, написать сообщение, нажать отправить",
  context: "Chrome 153, iPhone 13",
  page: "https://nestdev.ru/",
  projectId: "p1",
  userAgent: "test-agent",
  screenshot: PNG,
};

test("обращение сохраняется вместе со скриншотом и читается администратором", async () => {
  const { id } = await createSupportTicket(base);
  const tickets = await listSupportTickets();
  const ticket = tickets.find(item => item.id === id);
  assert.ok(ticket);
  assert.equal(ticket.category, "bug");
  assert.equal(ticket.severity, 7);
  assert.equal(ticket.description, base.description);
  assert.equal(ticket.screenshot.mime, "image/png");
  assert.ok(ticket.screenshot.bytes > 0);
  const screenshot = await readSupportScreenshot(id);
  assert.ok(screenshot);
  assert.equal(screenshot.mime, "image/png");
  assert.equal(screenshot.buffer.length, ticket.screenshot.bytes);
});

test("свежие обращения идут первыми, а чужой идентификатор не открывает файл", async () => {
  const first = await createSupportTicket({ ...base, description: "Старое обращение про вёрстку" });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await createSupportTicket({ ...base, description: "Новое обращение про сборку" });
  const tickets = await listSupportTickets();
  const firstIndex = tickets.findIndex(item => item.id === first.id);
  const secondIndex = tickets.findIndex(item => item.id === second.id);
  assert.ok(firstIndex >= 0 && secondIndex >= 0);
  assert.ok(secondIndex < firstIndex);
  assert.equal(await readSupportScreenshot("../users"), null);
  assert.equal(await readSupportScreenshot("00000000-0000-0000-0000-000000000000"), null);
});

test("не-картинка и поддельная сигнатура отклоняются", async () => {
  await assert.rejects(createSupportTicket({ ...base, screenshot: "data:text/plain;base64,SGVsbG8=" }), /PNG, JPEG или WebP/);
  await assert.rejects(createSupportTicket({ ...base, screenshot: "data:image/png;base64,SGVsbG8sIG5vdCBhbiBpbWFnZQ==" }), /не похож на изображение/);
});

test("скриншот больше лимита отклоняется до записи", async () => {
  const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(SUPPORT_SCREENSHOT_MAX_BYTES)]);
  await assert.rejects(createSupportTicket({ ...base, screenshot: "data:image/png;base64," + oversized.toString("base64") }), /больше 4 МБ/);
});
