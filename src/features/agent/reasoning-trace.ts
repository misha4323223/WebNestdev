import type { ChatMessage, ReasoningBlock } from "../../lib/types";

/** Один шаг (или субагент) внутри раскрытого блока размышлений. */
export type ReasoningTraceStep = {
  id: string;
  title: string;
  text: string;
  /** Этот шаг пишется прямо сейчас. */
  running?: boolean;
  children?: ReasoningTraceStep[];
};

/**
 * Набор шагов одного запуска. Якорь — сообщение, над которым показывается весь набор:
 * первый видимый ответ запуска (или живой ход, если ответа ещё нет).
 */
export type ReasoningTrace = {
  anchor: number;
  steps: ReasoningTraceStep[];
  /** Индексы сообщений, чьи размышления уже вошли в этот набор и не должны дублироваться. */
  covers: number[];
  running: boolean;
};

function countNodes(steps: ReasoningTraceStep[]): number {
  return steps.reduce((sum, step) => sum + 1 + countNodes(step.children ?? []), 0);
}

function buildBlockTree(blocks: Array<{ index: number; block: ReasoningBlock }>, liveIndex: number) {
  const ids = new Set(blocks.map(item => item.block.id));
  const children = new Map<string, Array<{ index: number; block: ReasoningBlock }>>();
  for (const item of blocks) {
    const parent = item.block.parentId;
    if (!parent || !ids.has(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }

  const toStep = (item: { index: number; block: ReasoningBlock }, seen: Set<string>): ReasoningTraceStep => {
    const nested = (children.get(item.block.id) ?? []).filter(child => !seen.has(child.block.id));
    const nextSeen = new Set(seen).add(item.block.id);
    return {
      id: item.block.id,
      title: item.block.title,
      text: item.block.text,
      running: item.block.status === "running" && item.index === liveIndex,
      ...(nested.length ? { children: nested.map(child => toStep(child, nextSeen)) } : {}),
    };
  };

  return blocks
    .filter(item => !item.block.parentId || !ids.has(item.block.parentId))
    .map(item => toStep(item, new Set()));
}

/**
 * Собирает размышления по ходам пользователя. Новые сообщения несут `reasoningBlocks` —
 * сохранённое дерево шагов; старые чаты приходят с плоским `reasoning`, и для них работает
 * прежняя группировка. В обоих случаях это только представление: история не меняется.
 */
export function buildReasoningTraces(messages: ChatMessage[], liveIndex: number): Map<number, ReasoningTrace> {
  const traces = new Map<number, ReasoningTrace>();
  let runStart = 0;

  const flush = (runEnd: number) => {
    const assistant: Array<{ index: number; message: ChatMessage }> = [];
    for (let i = runStart; i < runEnd; i++) {
      const message = messages[i];
      if (message.role === "assistant") assistant.push({ index: i, message });
    }
    if (!assistant.length) return;

    const blockEntries = assistant.flatMap(item =>
      (item.message.reasoningBlocks ?? []).map(block => ({ index: item.index, block })),
    );
    const legacy = assistant.filter(item => !item.message.reasoningBlocks?.length && item.message.reasoning?.trim());
    if (blockEntries.length + legacy.length < 2) return;

    // Якорь должен быть видимым: пустые ходы с одним вызовом инструмента в переписке скрыты.
    // Пока запуск идёт, якорь — живой ход: размышление должно быть рядом с тем ответом, который
    // пишется сейчас. После завершения — первый ответ запуска, чтобы все шаги остались над ним.
    const liveAssistant = assistant.find(item => item.index === liveIndex);
    const anchor = liveAssistant?.index
      ?? assistant.find(item => Boolean(item.message.content.trim()))?.index
      ?? blockEntries[0]?.index
      ?? legacy[0]?.index;
    if (anchor === undefined) return;

    const legacySteps: ReasoningTraceStep[] = legacy.map(item => ({
      id: "legacy-" + item.index,
      title: "Шаг " + (assistant.findIndex(entry => entry.index === item.index) + 1),
      text: item.message.reasoning ?? "",
      running: item.index === liveIndex,
    }));
    const steps = [...buildBlockTree(blockEntries, liveIndex), ...legacySteps];
    if (countNodes(steps) < 2) return;

    traces.set(anchor, {
      anchor,
      covers: [...blockEntries.map(item => item.index), ...legacy.map(item => item.index)],
      running: assistant.some(item => item.index === liveIndex),
      steps,
    });
  };

  for (let i = 0; i <= messages.length; i++) {
    if (i === messages.length || messages[i].role === "user") {
      flush(i);
      runStart = i + 1;
    }
  }
  return traces;
}
