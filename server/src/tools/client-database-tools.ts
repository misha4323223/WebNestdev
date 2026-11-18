// Клиентская база платформы глазами агента: статус, выдача и отключение.
// Полная строка подключения уходит только в зашифрованное хранилище проекта — в ответе её нет.
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { getSandbox } from "../sandbox-manager.js";
import { accountPlanFor } from "../billing/store.js";
import type { PlanId } from "../account/plans.js";
import {
  ClientDatabaseError,
  clientDatabaseStatus,
  connectClientDatabase,
  disconnectClientDatabase,
} from "../database/client-db/service.js";

const inputSchema = z.object({
  action: z.enum(["status", "provision", "disable"]).default("status"),
});

const HINT =
  "Клиентская база входит в тарифы «Плюс» (128 МБ) и «Премиум» (512 МБ). Строка подключения " +
  "хранится в зашифрованном хранилище проекта как DATABASE_URL: читайте её из process.env " +
  "и никогда не печатайте значение в ответе или коде.";

const UNAVAILABLE =
  "Клиентская база на этой установке не включена: администратору нужно задать " +
  "CLIENT_DB_ADMIN_URL и CLIENT_DB_PUBLIC_HOST. Пока предложите пользователю внешнюю базу " +
  "через database.status/database.env или подключение в «Настройки» → «Интеграции».";

async function projectContext(context: { projectId: string; userId: string }) {
  const sandbox = await getSandbox(context.projectId, context.userId);
  const plan: PlanId = await accountPlanFor(context.userId).catch(() => "free");
  return { userId: context.userId, projectId: context.projectId, root: sandbox.root, plan };
}

function failure(error: unknown) {
  if (error instanceof ClientDatabaseError) {
    return { ok: false, code: error.code, error: error.message, hint: HINT };
  }
  return { ok: false, code: "CLIENT_DATABASE_ERROR", error: error instanceof Error ? error.message : String(error), hint: HINT };
}

registerTool({
  name: "database.client",
  description:
    "Platform-managed PostgreSQL for this project (one schema per account, quota by plan). " +
    "action='status' (default) reports availability, provisioned schema, used bytes, quota and read-only state. " +
    "action='provision' creates the account schema and stores DATABASE_URL in the project's encrypted secret store. " +
    "action='disable' only removes DATABASE_URL from this project; the account's schema and data stay. " +
    "Call it when the project needs a database and the user has no external one, or when asked about the database quota. " +
    "The connection string is never returned — only a masked address. " +
    "Included in «Плюс» (128 MB) and «Премиум» (512 MB); free plan gets an error.",
  execute: async (input, context) => {
    const { action } = inputSchema.parse(input ?? {});
    try {
      const scope = await projectContext(context);
      if (action === "provision") {
        const result = await connectClientDatabase(scope);
        return { ...result, hint: HINT };
      }
      if (action === "disable") {
        const result = await disconnectClientDatabase(scope);
        return { ...result, action, hint: HINT };
      }
      const status = await clientDatabaseStatus(scope);
      if (!status.available) return { ...status, action, hint: UNAVAILABLE };
      return { ...status, action, hint: HINT };
    } catch (error) {
      return failure(error);
    }
  },
});
