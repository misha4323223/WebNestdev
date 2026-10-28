import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Хранилище читает каталог данных при импорте, поэтому временный каталог ставится до него.
 * Отдельный процесс на файл теста (node --test) держит подмену локальной.
 */
const dir = await mkdtemp(path.join(tmpdir(), "nestdev-profile-"));
process.env.WEBNESTDEV_DATA_DIR = dir;
const { getUserProfile, saveUserProfile, updateUserProfile } = await import("./profile-store.js");

test("контакты знакомства сохраняются, обновляются и не смешиваются между аккаунтами", async () => {
  assert.equal(await getUserProfile("account-a"), null, "до знакомства профиля нет");

  const first = await saveUserProfile("account-a", {
    name: "  Анна ",
    email: "ANNA@Example.COM",
    newsletter: true,
    productUpdates: false,
  });
  assert.equal(first.name, "Анна", "пробелы по краям убираются");
  assert.equal(first.email, "anna@example.com", "почта хранится в нижнем регистре");
  assert.equal(first.newsletter, true);
  assert.equal(first.productUpdates, false);
  assert.equal(first.source, "", "старый вызов без источника не выдумывает ответ");

  const reopened = await getUserProfile("account-a");
  assert.deepEqual(reopened, first, "профиль читается после записи");

  const second = await saveUserProfile("account-a", {
    name: "Анна П.",
    email: "anna@example.com",
    newsletter: false,
    productUpdates: true,
    source: "ВКонтакте",
  });
  assert.equal(second.completedAt, first.completedAt, "дата знакомства не сдвигается при правке");
  assert.equal(second.newsletter, false);
  assert.equal(second.productUpdates, true);
  assert.equal(second.source, "ВКонтакте");

  const toggled = await updateUserProfile("account-a", { productUpdates: false });
  assert.equal(toggled?.productUpdates, false, "согласие отзывается одним полем");
  assert.equal(toggled?.name, "Анна П.", "остальные контакты не переписываются");
  assert.equal(toggled?.source, "ВКонтакте", "источник остаётся при смене согласия");
  assert.equal(await updateUserProfile("account-b", { productUpdates: true }), null, "без знакомства менять нечего");
  assert.equal(await getUserProfile("account-b"), null, "у другого аккаунта своих данных нет");
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
