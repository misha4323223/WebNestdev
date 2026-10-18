import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { askUser } from "../questions/pending-questions.js";

/**
 * Вопрос — тоже разговор с пользователем, поэтому он идёт через панель, а не через переписку:
 * окно над полем ввода показывает варианты, а выбранное возвращается инструменту. Так модель
 * не выдумывает ответ за человека и не задаёт вопрос, который тот не увидит.
 */
const optionSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(240).optional(),
});

const requestSchema = z.object({
  question: z.string().trim().min(1).max(400),
  options: z.array(optionSchema).min(2).max(8),
  multiSelect: z.boolean().optional(),
  allowCustom: z.boolean().optional(),
});

/** Один ответ человека словами: выбранные подписи и, если он написал сам, этот текст. */
function answerText(selected: string[], custom?: string) {
  const parts = [...selected];
  if (custom && !parts.includes(custom)) parts.push(custom);
  return parts.join("; ");
}

registerTool({
  name: "question.ask",
  description:
    "Ask the user a question with ready-made options when their decision changes what you build next — layout, content, stack, naming, which of two approaches. " +
    "The question opens as a panel above their message box and pauses the run until they choose or skip. " +
    "Input: {question: one short sentence, options: 2–8 items of {label, description?}, multiSelect: whether several answers are allowed, allowCustom: let them write their own answer, default true}. " +
    "Use it for real choices, not for permission to proceed, not for facts you can find in the project, and not more than once or twice per run. " +
    "If the answer is cancelled or times out, do not repeat the question in chat: pick the most reasonable default yourself and say which one you picked.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short sentence shown at the top of the panel." },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 8,
        description: "Short answers the user can pick. A description clarifies a non-obvious option.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "The answer itself, up to a few words." },
            description: { type: "string", description: "Optional one-line clarification." },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      multiSelect: { type: "boolean", description: "true when several options may be selected at once." },
      allowCustom: { type: "boolean", description: "Whether the user may type their own answer instead, true by default." },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const parsed = requestSchema.parse(input ?? {});
    // Одинаковые подписи сделали бы ответ неоднозначным: пользователь видит два одинаковых пункта,
    // а модель получает одну строку и не знает, какой из них выбран.
    const labels = parsed.options.map(option => option.label);
    if (new Set(labels).size !== labels.length) {
      throw new Error("Варианты ответа должны отличаться друг от друга");
    }

    const { question, answer } = askUser({
      projectId: context.projectId,
      userId: context.userId,
      question: parsed.question,
      options: parsed.options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      multiSelect: Boolean(parsed.multiSelect),
      allowCustom: parsed.allowCustom !== false,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    // Панель открывает окно по этому событию и отвечает отдельным HTTP-запросом.
    context.emit?.({
      type: "question.asked",
      runId: context.runId,
      requestId: question.id,
      question: question.question,
      options: question.options,
      multiSelect: question.multiSelect,
      allowCustom: question.allowCustom,
      expiresAt: question.expiresAt,
    });

    const resolution = await answer;
    if (resolution.ok) {
      const text = answerText(resolution.selected, resolution.custom);
      return {
        ok: true,
        answer: text,
        selected: resolution.selected,
        ...(resolution.custom ? { custom: resolution.custom } : {}),
        note:
          text
            ? "Ответ пользователя: «" + text + "». Продолжай задачу по этому ответу."
            : "Пользователь не выбрал вариант. Продолжай, выбрав самый разумный вариант по умолчанию, и коротко скажи, какой выбрал.",
      };
    }
    if ("cancelled" in resolution) {
      return {
        ok: false,
        cancelled: true,
        note:
          "Пользователь пропустил вопрос. Не повторяй его в чате: выбери самый разумный вариант по умолчанию, " +
          "продолжи задачу и коротко скажи, что выбрал.",
      };
    }
    return {
      ok: false,
      error: resolution.error,
      note: "Ответа нет. Не повторяй вопрос в чате: продолжай с разумным значением по умолчанию и скажи, что выбрал.",
    };
  },
});
