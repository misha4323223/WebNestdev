import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Хранилище секретов и подключений читает каталог данных при каждом вызове, поэтому
// подменяем его до импорта модуля: иначе тест писал бы в рабочий `.webnestdev`.
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "wnd-expo-credential-data-"));
const { getExpoCredential, expoTokenFromProjectSecrets } = await import("./expo-api.js");

const TOKEN = "expo_token_abcdef123";

async function projectRoot(content?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-expo-project-"));
  if (content !== undefined) await writeFile(path.join(root, ".env.local"), content, "utf8");
  return root;
}

test("EXPO_TOKEN из секретов проекта читается как токен Expo", async () => {
  const root = await projectRoot("EXPO_TOKEN=" + TOKEN + "\nOTHER_KEY=1\n");
  assert.equal(await expoTokenFromProjectSecrets("p-expo-token", root), TOKEN);
});

test("без карточки и без секрета подключения нет", async () => {
  const root = await projectRoot();
  assert.equal(await getExpoCredential("p-expo-none", "u-expo-none", root), null);
});

test("секрет проекта заменяет карточку интеграции и помечается источником", async () => {
  const root = await projectRoot("EXPO_TOKEN=" + TOKEN + "\n");
  const credential = await getExpoCredential("p-expo-secret", "u-expo-secret", root);
  assert.equal(credential?.token, TOKEN);
  assert.equal(credential?.source, "project-secret");
  assert.equal(credential?.account, "");
});
