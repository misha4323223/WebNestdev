import type { ChangeCheckpoint } from "../../lib/project-api";
import type { ChatMessage } from "../../lib/types";

/** То, что нужно карточке под ответом; полный checkpoint читается только в «Истории». */
export type CheckpointNotice = {
  sha: string;
  shortSha: string;
  subject?: string;
  filesChanged: number;
  createdAt?: string;
};

export function checkpointNotice(checkpoint: Pick<ChangeCheckpoint, "sha" | "shortSha" | "subject" | "filesChanged" | "createdAt">): CheckpointNotice {
  return {
    sha: checkpoint.sha,
    shortSha: checkpoint.shortSha,
    subject: checkpoint.subject,
    filesChanged: checkpoint.filesChanged,
    createdAt: checkpoint.createdAt,
  };
}

/**
 * Чекпоинт создаётся сразу после последнего ответа запуска. По времени сообщений его можно
 * вернуть к тому же ответу после перезагрузки: это важно, иначе карточка отката оставалась
 * только у конца чата и исчезала при следующем запуске.
 *
 * Старые чаты без времени сообщений получают только последнюю точку — лучше показать одну
 * правильную карточку, чем расставить несколько к чужим ответам.
 */
export function checkpointCardsByMessage({
  checkpoints,
  conversationId,
  messages,
  messageTimes,
}: {
  checkpoints: ChangeCheckpoint[];
  conversationId: string;
  messages: ChatMessage[];
  messageTimes?: string[];
}): Map<number, CheckpointNotice> {
  const result = new Map<number, CheckpointNotice>();
  const relevant = checkpoints
    .filter(item => item.kind === "task" && item.conversationId === conversationId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!relevant.length) return result;

  const assistants = messages
    .map((message, index) => ({ message, index }))
    .filter(item => item.message.role === "assistant")
    .map(item => item.index);
  if (!assistants.length) return result;

  // Время git-коммита хранится с точностью до секунды, а сообщение — с миллисекундами.
  // Небольшой запас не даёт точке «перескочить» на предыдущий ответ в ту же секунду.
  const CLOCK_SKEW_MS = 1_500;
  const timed = assistants.filter(index => {
    const value = Date.parse(messageTimes?.[index] ?? "");
    return Number.isFinite(value);
  });

  if (timed.length) {
    const used = new Set<number>();
    for (const checkpoint of relevant) {
      const at = Date.parse(checkpoint.createdAt);
      if (!Number.isFinite(at)) continue;
      const match = [...timed].reverse().find(index => {
        if (used.has(index)) return false;
        const time = Date.parse(messageTimes?.[index] ?? "");
        return Number.isFinite(time) && time <= at + CLOCK_SKEW_MS;
      });
      if (match === undefined) continue;
      result.set(match, checkpointNotice(checkpoint));
      used.add(match);
    }
    return result;
  }

  // Старый чат без времени: runId из сохранённых размышлений ещё может указать ответ,
  // иначе остаётся последняя точка у последнего ответа.
  const runId = relevant[0]?.runId;
  const byRun = runId
    ? [...assistants].reverse().find(index => {
        const message = messages[index];
        return message?.role === "assistant" && Boolean(message.reasoningBlocks?.some(block => block.runId === runId));
      })
    : undefined;
  result.set(byRun ?? assistants[assistants.length - 1], checkpointNotice(relevant[0]));
  return result;
}
