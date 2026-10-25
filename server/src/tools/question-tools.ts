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
  // Только публичный http(s) или собственный маршрут снимка: локальный файл и data-URL
  // раздувают событие и не должны становиться способом показать что угодно из песочницы.
  imageUrl: z.string().trim().max(2000).refine(value => /^https?:\/\//i.test(value) || value.startsWith("/api/projects/"), {
    message: "Изображение варианта должно быть http(s)-адресом или адресом снимка проекта",
  }).optional(),
});

const requestSchema = z.object({
  question: z.string().trim().min(1).max(400),
  options: z.array(optionSchema).min(2).max(8),
  multiSelect: z.boolean().optional(),
  maxSelections: z.number().int().min(1).max(8).optional(),
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
    "Input: {question: one short sentence, options: 2–8 items of {label, description?, imageUrl?}, multiSelect: whether several answers are allowed, maxSelections?: cap for multiSelect, allowCustom: let them write their own answer, default true}. " +
    "Use imageUrl to show two visual variants side by side (a screenshot URL from browser.screenshot works); it must be an http(s) URL or the project's own /api/projects/... screenshot. " +
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
            imageUrl: { type: "string", description: "Optional http(s) image or a /api/projects/... screenshot URL to show the variant." },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      multiSelect: { type: "boolean", description: "true when several options may be selected at once." },
      maxSelections: { type: "integer", minimum: 1, maximum: 8, description: "Maximum number of selected options when multiSelect is true." },
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

    const multiSelect = Boolean(parsed.multiSelect);
    // Лимит имеет смысл только при множественном выборе и не может быть больше числа вариантов.
    const maxSelections = multiSelect
      ? Math.min(parsed.maxSelections ?? labels.length, labels.length)
      : undefined;
    const { question, answer } = askUser({
      projectId: context.projectId,
      userId: context.userId,
      question: parsed.question,
      options: parsed.options.map(option => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.imageUrl ? { imageUrl: option.imageUrl } : {}),
      })),
      multiSelect,
      ...(maxSelections === undefined ? {} : { maxSelections }),
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
      ...(question.maxSelections === undefined ? {} : { maxSelections: question.maxSelections }),
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
