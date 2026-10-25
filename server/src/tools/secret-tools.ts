import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { requestSecret } from "../secrets/pending-secrets.js";

/**
 * Секрет попадает только в хранилище секретов проекта и оттуда — в файл окружения при запуске:
 * запись в другое место означала бы, что модель выбирает цель для чужого значения. Список ровно
 * тот, который читают dev-сервер, сборка и хостинг.
 */
const ENV_FILE = /^\.env(\.(local|development|production|test|staging))?$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{1,63}$/;

const requestSchema = z.object({
  variable: z.string().trim().max(64),
  purpose: z.string().trim().max(400).optional(),
  file: z.string().trim().max(40).optional(),
});

registerTool({
  name: "secrets.request",
  description:
    "Ask the user for a secret — an API key, access token, webhook secret or password — through a secure modal window on their screen. " +
    "The user pastes the value there; the server stores it encrypted for the project and returns only a confirmation, so the value is never " +
    "shown to you and must never be requested in chat. Call this whenever a task needs a credential you do not have: input " +
    "{variable: the environment variable name in UPPER_SNAKE_CASE, purpose: one short line explaining what it is for, file: the env file the app will see, " +
    "'.env.local' by default}. After it returns ok:true, read the key in the project code from process.env.<VARIABLE>. " +
    "If the user cancels, do not ask again in chat: continue without the key or say exactly what stays blocked.",
  parameters: {
    type: "object",
    properties: {
      variable: { type: "string", description: "Environment variable name, for example STRIPE_SECRET_KEY.", pattern: "^[A-Z][A-Z0-9_]{1,63}$" },
      purpose: { type: "string", description: "One short line shown in the modal: what the key is used for." },
      file: { type: "string", description: "Env file to write into, '.env.local' by default.", enum: [".env", ".env.local", ".env.development", ".env.production", ".env.test", ".env.staging"] },
    },
    required: ["variable"],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const parsed = requestSchema.parse(input ?? {});
    if (!VARIABLE.test(parsed.variable)) {
      throw new Error("Имя переменной должно состоять из заглавных латинских букв, цифр и подчёркиваний и начинаться с буквы, например STRIPE_SECRET_KEY");
    }
    const file = parsed.file || ".env.local";
    if (!ENV_FILE.test(file)) {
      throw new Error("Ключ можно записать только в файл окружения проекта: .env, .env.local, .env.development, .env.production, .env.test или .env.staging");
    }
    const purpose = parsed.purpose || "Ключ нужен агенту, чтобы продолжить работу над проектом.";
    const { request, answer } = requestSecret({
      projectId: context.projectId,
      userId: context.userId,
      variable: parsed.variable,
      purpose,
      file,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    // Модальное окно открывает панель по этому событию; значение пойдёт в зашифрованное
    // хранилище проекта, а не в чат и не в результат инструмента.
    context.emit?.({
      type: "secret.requested",
      runId: context.runId,
      requestId: request.id,
      variable: request.variable,
      purpose: request.purpose,
      file: request.file,
      expiresAt: request.expiresAt,
    });

    const resolution = await answer;
    if (resolution.ok) {
      return {
        ok: true,
        stored: true,
        variable: resolution.variable,
        file: resolution.file,
        note:
          "Значение сохранено в зашифрованном хранилище проекта и будет доступно приложению как process.env." + resolution.variable +
          " (при запуске — в файле " + resolution.file + "). Ты его не видишь: не спрашивай значение и не печатай его. " +
          "Используй переменную в коде и не коммить env-файлы.",
      };
    }
    if ("cancelled" in resolution) {
      return {
        ok: false,
        cancelled: true,
        note:
          "Пользователь отказался вводить ключ. Не проси его в чате: продолжи работу без этого ключа или коротко скажи, " +
          "что именно осталось заблокированным и какие шаги требуют ключа.",
      };
    }
    return {
      ok: false,
      error: resolution.error,
      note: "Ключ не сохранён. Не проси его в чате: предложи повторить запрос позже или объясни, что осталось заблокированным.",
    };
  },
});
