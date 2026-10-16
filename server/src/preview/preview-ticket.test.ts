import test from "node:test";
import assert from "node:assert/strict";
import { mintPreviewTicket, previewTicketProject, previewTicketTtlMs, previewTicketUrl } from "./preview-ticket.js";

/** Ключ шифрования задаётся тестом: иначе в рабочем каталоге появился бы файл с ключом разработчика. */
const KEY = "WEBNESTDEV_ENCRYPTION_KEY";
const TTL_KEY = "PREVIEW_TICKET_TTL_MS";
process.env[KEY] = "0".repeat(64);

function withEnv(values: Record<string, string | undefined>, body: () => void) {
  const before = new Map<keyof typeof values & string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    before.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("билет открывает ровно тот проект, для которого выпущен", () => {
  const ticket = mintPreviewTicket("p1");
  assert.equal(previewTicketProject(ticket), "p1");
  assert.notEqual(ticket, mintPreviewTicket("p1"), "билеты не должны повторяться: содержимое шифруется с новым вектором");
});

test("истёкший билет не открывает ничего", () => {
  withEnv({ [TTL_KEY]: "1000" }, () => {
    const now = Date.now();
    const ticket = mintPreviewTicket("p1", now);
    assert.equal(previewTicketProject(ticket, now + 500), "p1");
    assert.equal(previewTicketProject(ticket, now + 2000), "");
  });
});

test("подделанный или незашифрованный билет отвергается", () => {
  const ticket = mintPreviewTicket("p1");
  const flipped = ticket.slice(0, -2) + (ticket.endsWith("AA") ? "BB" : "AA");
  assert.equal(previewTicketProject(flipped), "");
  // Значение без префикса шифрования `decryptSecret` вернул бы как есть (так читаются старые
  // записи), и подписал бы его кто угодно: для доступа такое значение не годится.
  assert.equal(previewTicketProject(JSON.stringify({ projectId: "p1", expiresAt: Date.now() + 60_000 })), "");
  assert.equal(previewTicketProject(""), "");
  assert.equal(previewTicketProject(undefined), "");
  assert.equal(previewTicketProject("x".repeat(5000)), "");
});

test("срок жизни билета настраивается переменной окружения", () => {
  withEnv({ [TTL_KEY]: "5000" }, () => assert.equal(previewTicketTtlMs(), 5000));
  withEnv({ [TTL_KEY]: "0" }, () => assert.equal(previewTicketTtlMs(), 12 * 60 * 60 * 1000));
  withEnv({ [TTL_KEY]: undefined }, () => assert.equal(previewTicketTtlMs(), 12 * 60 * 60 * 1000));
});

test("ссылка с билетом — это адрес предпросмотра плюс параметр", () => {
  const url = previewTicketUrl("https://p1.preview.nestdev.ru", "enc:v1:a:b:c");
  assert.equal(url, "https://p1.preview.nestdev.ru/?ticket=enc%3Av1%3Aa%3Ab%3Ac");
});
