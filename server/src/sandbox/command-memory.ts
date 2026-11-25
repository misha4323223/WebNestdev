/**
 * Память контейнера по классу команды.
 *
 * Раньше любой контейнер песочницы занимал полный потолок (`SANDBOX_MEMORY_MB`, 1024 МБ) —
 * и `git status`, и `npm run build`. Потолок — это резервация в общем бюджете памяти
 * (`memory-budget.ts`), поэтому один `ls` вытеснял сборку: в бюджет 2048 МБ влезало всего два
 * контейнера независимо от того, что они делают.
 *
 * Здесь дешёвые команды получают меньший потолок. Правило сознательно одностороннее: лёгкий
 * класс выдаётся только когда **каждый** кусок команды — известная дешёвая программа, и нигде в
 * строке нет ни одной потенциально тяжёлой или произвольной конструкции (`npm`, `node`, `xargs`,
 * `-exec`, перенаправления, подстановки, сборщики). Всё неизвестное, составное с тяжёлым куском и
 * любая сборка остаются на полном потолке: лучше не сэкономить память, чем получить OOM там,
 * где вчера всё собиралось.
 *
 * Потолок лёгкого класса — `SANDBOX_MEMORY_LIGHT_MB` (по умолчанию 256 МБ, минимум 64). Он никогда
 * не поднимается выше базового потолка, а базовым считается `SANDBOX_MEMORY`, если он задан, иначе
 * `config.memoryMb`: в production `SANDBOX_MEMORY=1g` — это потолок по умолчанию, а не запрет
 * деления (проверено на node-1 25.11.2026). Потолок команды передаётся в Docker отдельным
 * аргументом и перекрывает `SANDBOX_MEMORY` (см. `docker/options.ts`), поэтому резервация в
 * бюджете и реальный `--memory` совпадают. Полный выключатель — `SANDBOX_COMMAND_MEMORY_CLASS=0`.
 *
 * Минус, который надо помнить: под 256 МБ загрузка кучи не падает быстро, а тянет время. Замер на
 * node-1: выделение ~380 МБ под потолком 256 МБ закончилось кодом 134 через 30 с, под 1024 МБ —
 * успехом за 6.7 с. Поэтому список лёгких команд узкий, а любой сомнительный случай идёт с полным
 * потолком.
 *
 * Средний класс намеренно отсутствует. «Немного уменьшить всем» — это ровно тот вариант, где
 * ошибка в оценке превращается в падение сборки у части проектов, а выигрыш никто не измерил.
 */

import { memoryLimitMb } from "./memory-budget.js";

export type CommandMemoryClass = "light" | "normal";

const DEFAULT_LIGHT_MB = 256;
const MIN_LIGHT_MB = 64;

/**
 * Программы, которые читают файлы потоком или обходят каталог: их память не растёт вместе с
 * размером входа. Сортировка и разбор JSON сюда не входят — они держат данные целиком.
 */
const LIGHT_COMMANDS = new Set([
  "ls", "cat", "pwd", "echo", "printf", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg",
  "find", "fd", "file", "stat", "du", "df", "tree", "wc", "cut", "tr", "sed", "awk", "uniq",
  "which", "whereis", "type", "command", "printenv", "date", "whoami", "id", "uname", "hostname",
  "realpath", "readlink", "dirname", "basename", "nproc", "seq", "test", "[", "true", "false",
  "sleep", "cd",
]);

/** У `git` дешёвая только читающая часть; ветки, клоны и переключения — обычный класс. */
const LIGHT_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "branch", "remote",
  "describe", "blame", "shortlog", "config", "cat-file", "show-ref", "name-rev", "merge-base",
  "for-each-ref", "whatchanged",
]);

/**
 * Строки, после которых команда перестаёт быть предсказуемо дешёвой. Проверяются по всему
 * тексту, а не по первому слову: `echo hi > out.txt` пишет файл, `ls | xargs rm` удаляет файлы.
 */
const DENIED_IN_LIGHT = [
  /-exec\b/i, /-delete\b/i, /\bxargs\b/i, />/, /\$\(/, /`/,
  /\bsudo\b/i, /\bdocker\b/i, /\bnode\b/i, /\bnpm\b/i, /\bnpx\b/i, /\bpnpm\b/i, /\byarn\b/i,
  /\bbun\b/i, /\bdeno\b/i, /\bpython[0-9.]*\b/i, /\bpip[0-9.]*\b/i, /\btsc\b/i, /\bvite\b/i,
  /\bwebpack\b/i, /\bplaywright\b/i, /\bcurl\b/i, /\bwget\b/i, /\bmake\b/i, /\bgcc\b/i,
  /\bg\+\+\b/i, /\bcargo\b/i, /\bsort\b/i, /\bjq\b/i,
];

function segmentIsLight(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (DENIED_IN_LIGHT.some(pattern => pattern.test(trimmed))) return false;
  // `FOO=1 ls` — то же самое, что `ls`, только с переменной для одного процесса.
  let rest = trimmed;
  for (let index = 0; index < 3; index += 1) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
    if (!assignment) break;
    rest = rest.slice(assignment[0].length);
  }
  const [rawName = ""] = rest.split(/\s+/);
  if (!rawName || rawName.startsWith("-")) return false;
  const name = rawName.split("/").pop() ?? "";
  if (name === "git") {
    const subcommand = rest.split(/\s+/).slice(1).find(token => !token.startsWith("-"));
    return Boolean(subcommand && LIGHT_GIT_SUBCOMMANDS.has(subcommand));
  }
  return LIGHT_COMMANDS.has(name);
}

/**
 * Класс команды. Пустая команда — обычный класс: неизвестное не должно получать поблажку.
 * Разделители режут строку на куски, и каждый кусок проверяется отдельно: `ls && npm test`
 * остаётся обычным классом из-за второго куска.
 */
export function commandMemoryClass(command: string): CommandMemoryClass {
  if (process.env.SANDBOX_COMMAND_MEMORY_CLASS?.trim() === "0") return "normal";
  const text = command.trim();
  if (!text) return "normal";
  const parts = text.split(/\|\||&&|;|\||\n|&/);
  if (!parts.length) return "normal";
  return parts.every(segmentIsLight) ? "light" : "normal";
}

/** Потолок лёгкого класса; меньше 64 МБ контейнеру с shell не выдаём. */
export function lightCommandMemoryMb(): number {
  const raw = Number(process.env.SANDBOX_MEMORY_LIGHT_MB);
  if (Number.isFinite(raw) && raw > 0) return Math.max(MIN_LIGHT_MB, Math.floor(raw));
  return DEFAULT_LIGHT_MB;
}

/**
 * Потолок памяти для конкретной команды. Базовый `config.memoryMb` действует, если администратор не
 * задал единый потолок `SANDBOX_MEMORY` (`1g` в production): тогда базой считается он. Обычные
 * команды и всё неизвестное получают базу без изменений — это и есть гарантия «вчера работало,
 * сегодня работает».
 */
export function commandMemoryMb(command: string, baseMb: number): number {
  const base = Math.max(1, Math.floor(memoryLimitMb(process.env.SANDBOX_MEMORY, baseMb)));
  if (commandMemoryClass(command) !== "light") return base;
  return Math.min(base, lightCommandMemoryMb());
}
