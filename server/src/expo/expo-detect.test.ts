import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findExpoApps, locateExpoApp } from "./expo-detect.js";

/**
 * Проверка нужна из-за конкретного отказа: Expo-приложение лежало в `admin-app`, корень проекта
 * был обычным веб-приложением, и запуск не получал `expo.build`. Модель тогда пыталась создать
 * сборку через GraphQL/REST, где такого метода нет.
 */

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "expo-detect-"));
}

async function writeExpoApp(directory: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { expo: "~58.1.0" } }));
  await writeFile(path.join(directory, "app.json"), JSON.stringify({ expo: { slug: "app", extra: { eas: { projectId: "2c2b2bf0-e387-4b05-af01-78d7e8303136" } } } }));
}

test("приложение в подкаталоге находится и выбирается само", async () => {
  const root = await workspace();
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }));
    await writeExpoApp(path.join(root, "admin-app"));

    assert.deepEqual(await findExpoApps(root), ["admin-app"]);
    const found = await locateExpoApp(root);
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.cwd, "admin-app");
    assert.equal(found.auto, true);
    assert.equal(found.project.projectId, "2c2b2bf0-e387-4b05-af01-78d7e8303136");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("корень важнее вложенного приложения", async () => {
  const root = await workspace();
  try {
    await writeExpoApp(root);
    await writeExpoApp(path.join(root, "examples", "demo"));

    const found = await locateExpoApp(root);
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.cwd, "");
    assert.equal(found.auto, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node_modules, ios и android не считаются приложениями", async () => {
  const root = await workspace();
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    await writeExpoApp(path.join(root, "node_modules", "expo-app"));
    await writeExpoApp(path.join(root, "android"));

    assert.deepEqual(await findExpoApps(root), []);
    const found = await locateExpoApp(root);
    assert.equal(found.ok, false);
    if (found.ok) return;
    assert.match(found.problem, /нет приложения Expo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("несколько приложений: список каталогов вместо выбора наугад", async () => {
  const root = await workspace();
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    await writeExpoApp(path.join(root, "apps", "one"));
    await writeExpoApp(path.join(root, "apps", "two"));

    const found = await locateExpoApp(root);
    assert.equal(found.ok, false);
    if (found.ok) return;
    assert.deepEqual(found.candidates, [path.join("apps", "one"), path.join("apps", "two")]);
    assert.match(found.problem, /cwd/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("явный cwd не подменяется найденным рядом приложением", async () => {
  const root = await workspace();
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    await mkdir(path.join(root, "web"), { recursive: true });
    await writeFile(path.join(root, "web", "package.json"), "{}");
    await writeExpoApp(path.join(root, "admin-app"));

    const found = await locateExpoApp(root, "web");
    assert.equal(found.ok, false);
    if (found.ok) return;
    assert.match(found.problem, /web/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
