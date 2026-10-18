import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegruServers } from "./verify.js";

test("reg.ru cloud servers are counted for the card label", () => {
  assert.equal(parseRegruServers({ reglets: [{ id: 1 }, { id: 2 }] }), "REG.RU Облако · серверов: 2");
  assert.equal(parseRegruServers({ links: { actions: [] }, reglets: [] }), "REG.RU Облако · серверов: 0");
});

test("an answer without the server list is an error, not a fake zero", () => {
  assert.throws(() => parseRegruServers({ error: "unauthorized" }), /без списка серверов/);
  assert.throws(() => parseRegruServers(null), /без списка серверов/);
});
