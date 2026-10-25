import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { getProject } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import { SERVICE_CATEGORIES, SERVICES, findService, serviceEnvValues } from "../services/catalog.js";
import { getServiceConnection, listServiceConnections } from "../services/connections.js";
import { listProjectSecrets, saveProjectSecrets } from "../secrets/project-secrets.js";

/**
 * Подключённые сервисы пользователя: файлы, почта, оплата, AI, карты, CRM. Агент видит, что
 * доступно, и умеет перенести ключи сервиса в переменные окружения проекта — значения при этом
 * не попадают ни в контекст модели, ни в ответ инструмента.
 */

const envSchema = z.object({ service: z.string().trim().min(1).max(80) });

registerTool({
  name: "service.status",
  description:
    "List the external services the user connected in «Интеграции» → «Сервисы» (файлы/S3, почта, оплата, AI, карты, CRM, сборки Expo/EAS) " +
    "with the account each key belongs to and the environment variable names the service provides. " +
    "Call it before writing code that needs storage, email, payments, AI or maps, and when the user asks what is already connected. " +
    "It never returns the credential itself.",
  execute: async (_input, context) => {
    const connections = await listServiceConnections(context.userId);
    const connected = connections.map(connection => {
      const service = findService(connection.service);
      return {
        service: connection.service,
        name: service?.name ?? connection.service,
        category: service?.category ?? "unknown",
        account: connection.account,
        env: service ? service.env.map(entry => entry.name) : [],
        connectedAt: connection.updatedAt,
      };
    });
    const notConnected = SERVICES
      .filter(service => !connections.some(connection => connection.service === service.id))
      .map(service => ({ service: service.id, name: service.name, category: service.category }));
    return {
      connected,
      categories: SERVICE_CATEGORIES,
      notConnected,
      hint: connected.length
        ? "Ключи сервиса переносятся в проект инструментом service.env — значения при этом тебе не показываются."
        : "Ни один сервис не подключён: попросите пользователя открыть «Интеграции» → «Сервисы» и вставить ключ провайдера.",
    };
  },
});

registerTool({
  name: "service.env",
  description:
    "Copy the environment variables of a connected service into the current project's encrypted secret store, so the app reads them as " +
    "process.env.<NAME> at run time. Input: {service}. Use it right after the user connected a service and the project needs it: " +
    "for example storage gives S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, email gives the provider's API key, " +
    "payments give shop credentials. The values never enter your context — only the names are returned. " +
    "Call service.status first to see what is connected; if the service is missing, ask the user to connect it instead of inventing a key.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["service"],
    properties: {
      service: { type: "string", description: "Идентификатор подключённого сервиса, например timeweb-storage или yookassa" },
    },
  },
  execute: async (input, context) => {
    const { service: serviceId } = envSchema.parse(input ?? {});
    const service = findService(serviceId);
    if (!service) throw new Error("Неизвестный сервис: " + serviceId + ". Список доступных — в service.status.");
    const connection = await getServiceConnection(context.userId, service.id);
    if (!connection) {
      throw new Error("Сервис " + service.name + " не подключён: попросите пользователя открыть «Интеграции» → «Сервисы» и подключить его.");
    }
    const project = await getProject(context.projectId);
    if (!project || project.userId !== context.userId) throw new Error("Проект не найден или недоступен");
    const root = (await getSandbox(project.id, project.userId)).root;

    const fields = JSON.parse(connection.secret) as Record<string, string>;
    const variables = serviceEnvValues(service, fields);
    if (!Object.keys(variables).length) {
      return { ok: false, service: service.id, hint: "У сервиса нет переменных окружения — его ключи используются только своими инструментами." };
    }
    const stored = await saveProjectSecrets(project.id, root, variables);
    return {
      ok: true,
      service: service.id,
      name: service.name,
      added: Object.keys(variables),
      variables: stored.map(secret => ({ name: secret.name, file: secret.file })),
      note:
        "Переменные записаны в зашифрованное хранилище проекта и будут доступны как process.env при запуске. " +
        "Значения тебе не показываются: не спрашивай их и не печатай. Используй имена переменных в коде, например process.env.S3_ENDPOINT.",
    };
  },
});

registerTool({
  name: "service.secrets",
  description:
    "List the project's secret variable names (never the values) — use it to check whether a connected service's variables are already " +
    "in the project before writing code that reads process.env, and after service.env to confirm what was written.",
  execute: async (_input, context) => {
    const project = await getProject(context.projectId);
    if (!project || project.userId !== context.userId) throw new Error("Проект не найден или недоступен");
    const root = (await getSandbox(project.id, project.userId)).root;
    const secrets = await listProjectSecrets(project.id, root);
    return { variables: secrets.map(secret => ({ name: secret.name, file: secret.file, preview: secret.preview })) };
  },
});
