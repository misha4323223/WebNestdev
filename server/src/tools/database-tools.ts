import { mkdir, readFile, writeFile } from "node:fs/promises";
// The connection string is the only secret this tool writes; it is never echoed back.
import path from "node:path";
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { getDatabaseConnection } from "../database/database-connection-store.js";
import { databaseSchemeLabel, databaseStatus, getDatabaseUrl, maskDatabaseUrl } from "../database/database-api.js";
import { envVariables, mergeEnvFile } from "../database/env-file.js";

/** Providers the product recommends when the user has to create a database. */
const PROVIDER_GUIDE =
  "Российские варианты: Yandex Cloud (Managed PostgreSQL или Serverless YDB), VK Cloud, Selectel, Timeweb Cloud, Cloud.ru. " +
  "Если аккаунт Yandex Cloud подключён и пользователь разрешил изменения, кластер Managed PostgreSQL можно создать и через yandex.request " +
  "(mdb.api.cloud.yandex.net, POST /managed-postgresql/v1/clusters).";

const CONNECT_HINT =
  "База данных не подключена. Скажите пользователю, где её взять, и предложите: " + PROVIDER_GUIDE + " " +
  "Подключение происходит в рабочей области: «Настройки» → «Интеграции» → «База данных», где пользователь вставляет строку подключения " +
  "(она шифруется на сервере), после чего database.env записывает её в файл окружения проекта. " +
  "Если интеграцию подключать не хотят, строку подключения запрашивают инструментом secrets.request с именем DATABASE_URL — значение " +
  "попадёт прямо в файл окружения и останется невидимым для вас. Никогда не просите строку подключения и пароль в чате.";

const envSchema = z.object({ path: z.string().max(200).optional() });

registerTool({
  name: "database.status",
  description:
    "Report the database the user connected for this project: engine, host, port, database name and whether TLS is on. " +
    "The password is never returned. Call it before writing persistence code and whenever the project needs to store data: if nothing is " +
    "connected, explain the options and ask the user to connect one. " + PROVIDER_GUIDE,
  execute: async (_input, context) => {
    const status = await databaseStatus(context.userId);
    if (!status.connected) return { connected: false, hint: CONNECT_HINT };
    return {
      ...status,
      hint:
        "Подключение сохранено. Запишите строку подключения в файл окружения проекта инструментом database.env и читайте её из process.env." +
        (status.provider === "yandex-postgresql" || status.provider === "yandex-ydb"
          ? " Провайдер — Yandex Cloud: проверьте, что база и кластер в одном каталоге с проектом, и откройте доступ по сети безопасности."
          : ""),
    };
  },
});

registerTool({
  name: "database.env",
  description:
    "Write the connected database's connection string into the project's environment file so the application can use it. " +
    "Input: {path?:string} — the file to merge into, '.env.local' by default. Only DATABASE_URL and the engine's conventional alias " +
    "(MONGODB_URI, REDIS_URL, YDB_CONNECTION_STRING) are written; other lines are preserved. The password is written to the file and is never echoed back, " +
    "so never print the file contents in your answer.",
  execute: async (input, context) => {
    const { path: requested } = envSchema.parse(input ?? {});
    const connection = await getDatabaseConnection(context.userId);
    if (!connection) return { ok: false, error: "База данных не подключена", hint: CONNECT_HINT };
    const url = await getDatabaseUrl(context.userId);
    if (!url) return { ok: false, error: "База данных не подключена", hint: CONNECT_HINT };

    const relative = requested?.trim() || ".env.local";
    const sandbox = await getSandbox(context.projectId, context.userId);
    const target = assertInsideSandbox(sandbox.root, path.join(sandbox.root, relative));
    let existing = "";
    try { existing = await readFile(target, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(target), { recursive: true });
    const variables = envVariables(connection.scheme, url);
    await writeFile(target, mergeEnvFile(existing, variables), "utf8");

    return {
      ok: true,
      path: relative,
      variables: Object.keys(variables),
      engine: databaseSchemeLabel(connection.scheme),
      maskedUrl: maskDatabaseUrl(connection),
      note:
        "Файл обновлён. Остальные строки сохранены. В ответах и в коде используйте process.env.DATABASE_URL — " +
        "не печатайте значение и не коммитьте файл: проверьте, что он указан в .gitignore проекта.",
    };
  },
});
