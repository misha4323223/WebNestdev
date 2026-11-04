import { randomUUID } from "node:crypto";
import type { ReasoningBlock, ReasoningBlockKind, ReasoningBlockStatus } from "../types.js";

/**
 * Человеческая подпись шага. В истории видно не только «Шаг 2», но и чем он занимался:
 * прочитал файл, запустил команду, проверил сборку. Неизвестный инструмент остаётся своим
 * именем — это лучше, чем потерять шаг из-за новой возможности.
 */
const TOOL_TITLES: Record<string, string> = {
  "fs.list": "просмотр файлов",
  "fs.read": "чтение файла",
  "fs.grep": "поиск по коду",
  "fs.outline": "карта файла",
  "fs.write": "запись файла",
  "fs.edit": "правка кода",
  "fs.rename": "переименование",
  "fs.delete": "удаление файла",
  "terminal.exec": "команда",
  "terminal.start": "запуск команды",
  "terminal.tail": "чтение вывода",
  "npm.install": "установка зависимостей",
  "pip.install": "Python-зависимости",
  "net.request": "запрос API",
  "net.download": "скачивание файла",
  "web.search": "поиск в интернете",
  "web.read": "чтение страницы",
  "image.generate": "генерация изображения",
  "image.inspect": "проверка изображения",
  "project.check": "проверка TypeScript",
  "project.verify": "проверка приложения",
  "browser.runtime": "проверка в браузере",
  "browser.scenario": "сценарий в браузере",
  "preview.start": "запуск превью",
  "git.status": "состояние git",
  "git.diff": "просмотр изменений",
};

export function reasoningBlockTitle(step: number, calls: Array<{ name: string }> = []): string {
  const first = calls[0]?.name;
  if (!first) return "Шаг " + step + " · ответ";
  const label = TOOL_TITLES[first] ?? first;
  const more = calls.length > 1 ? " +" + (calls.length - 1) : "";
  return "Шаг " + step + " · " + label + more;
}

/** Собирает узел дерева для одного шага модели. */
export function createReasoningBlock(input: {
  /** Тот же id, который уже ушёл в поток: история и live-блок должны совпадать. */
  id?: string;
  runId: string;
  step: number;
  text: string;
  calls?: Array<{ name: string }>;
  startedAt?: string;
  finishedAt?: string;
  status?: ReasoningBlockStatus;
  title?: string;
  parentId?: string;
  kind?: ReasoningBlockKind;
}): ReasoningBlock {
  const now = new Date().toISOString();
  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    kind: input.kind ?? "step",
    title: input.title ?? reasoningBlockTitle(input.step, input.calls),
    text: input.text,
    step: input.step,
    status: input.status ?? "done",
    startedAt: input.startedAt ?? now,
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
  };
}
