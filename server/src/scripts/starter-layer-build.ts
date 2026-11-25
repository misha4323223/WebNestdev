/**
 * Сборка предустановленного слоя зависимостей на ноде.
 *
 *   npm run layer:build -- --kit ./starter-kit/spa
 *
 * Набор — каталог с `package.json`. Скрипт ставит зависимости тем же образом, что и проект,
 * записывает полученный `package-lock.json` **в сам набор** и считает хэш по тому же
 * контракту, что `dependencyLockHash` (образ + package.json + lock + shrinkwrap), кладя
 * готовое дерево в `<слой>/<хэш>/node_modules`. Запись lock в набор — не побочный эффект, а
 * условие: без него хэш набора (с локом) никогда не совпал бы с хэшем проекта (без лока), и
 * слой не получил бы никто.
 *
 * Каталог слоя лежит рядом с кэшем проектов, но не внутри него: уборщик кэша считает каждый
 * каталог в корне кэша проектом и удалил бы слой как сироту.
 *
 * Права: файлы `0444`, каталоги `0775`. Файл нельзя переписать на месте — это общий inode
 * для всех проектов; каталоги остаются удаляемыми для владельца слоя, иначе дерево нельзя
 * убрать при пересборке или смене набора без root.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, chmod, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dependencyHashFrom } from "../preview/dependency-cache.js";
import { starterKitDir, starterLayerRoot } from "../preview/starter-layer.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const kit = path.resolve(argument("--kit") ?? starterKitDir(process.env) ?? "");
if (!argument("--kit") && !starterKitDir(process.env)) {
  console.error("Укажите набор: --kit <каталог с package.json> или WEBNESTDEV_STARTER_KIT_DIR.");
  process.exit(1);
}
const packageJson = await readFile(path.join(kit, "package.json"), "utf8").catch(() => null);
if (packageJson === null) {
  console.error("В наборе нет package.json: " + kit);
  process.exit(1);
}

const root = starterLayerRoot(process.env);
await mkdir(root, { recursive: true });
const work = path.join(root, ".build-" + process.pid);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await writeFile(path.join(work, "package.json"), packageJson, "utf8");
for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
  const content = await readFile(path.join(kit, name), "utf8").catch(() => null);
  if (content !== null) await writeFile(path.join(work, name), content, "utf8");
}

console.log("Ставим набор в " + work + " …");
const code = await new Promise<number>((resolve, reject) => {
  const child = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
  child.on("error", reject);
  child.on("close", value => resolve(value ?? 1));
});
if (code !== 0) {
  await rm(work, { recursive: true, force: true });
  console.error("npm install завершился с кодом " + code);
  process.exit(code);
}

// Lock возвращается в набор: проект, созданный из набора, приносит те же байты и тот же хэш.
for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
  const generated = await readFile(path.join(work, name), "utf8").catch(() => null);
  if (generated !== null) await writeFile(path.join(kit, name), generated, "utf8");
}
const lock = await readFile(path.join(work, "package-lock.json"), "utf8").catch(() => "");
if (!lock) {
  await rm(work, { recursive: true, force: true });
  console.error("Установка не создала package-lock.json: без него хэш не совпадёт с проектом.");
  process.exit(1);
}
const shrinkwrap = await readFile(path.join(kit, "npm-shrinkwrap.json"), "utf8").catch(() => "");
const hash = dependencyHashFrom({ packageJson, lock, shrinkwrap });
const target = path.join(root, hash);
await rm(target, { recursive: true, force: true });
await rename(work, target);

/** Слой только читают: файлы `0444`, каталоги `0775` (удаляемые владельцем). */
async function readonly(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await readonly(full);
      await chmod(full, 0o775).catch(() => undefined);
    } else if (!entry.isSymbolicLink()) {
      await chmod(full, 0o444).catch(() => undefined);
    }
  }
}
await readonly(target);

const modules = await stat(path.join(target, "node_modules")).catch(() => null);
if (!modules?.isDirectory()) {
  await rm(target, { recursive: true, force: true });
  console.error("Установка не создала node_modules: набор без зависимостей? Слой из такого набора не нужен.");
  process.exit(1);
}
const size = await directorySize(path.join(target, "node_modules"));
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024) + " МБ";
console.log("\nСлой готов: " + target);
console.log("Хэш: " + hash + " (совпадение с проектом — это тот же package.json и lock)");
console.log("Размер: " + mb(size));
console.log("\nВключить слой:");
console.log("  WEBNESTDEV_STARTER_KIT_DIR=" + kit);
console.log("  WEBNESTDEV_STARTER_LAYER_DIR=" + root);
console.log("Проект получит слой, только если его package.json и lock совпадают с набором байт в байт,");
console.log("то есть если он создан из этого набора, а не написан агентом с собственными версиями.");

async function directorySize(dir: string): Promise<number> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return 0;
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}
