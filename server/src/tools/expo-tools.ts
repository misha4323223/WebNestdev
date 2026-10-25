import { z } from "zod";
import path from "node:path";
import { registerTool } from "../tool-registry.js";
import { getSandbox } from "../sandbox-manager.js";
import { resolveInsideSandbox, writeFileInside } from "../sandbox/path-guard.js";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import {
  allBuilds,
  buildSummary,
  getExpoConnection,
  inspectExpoProject,
  parseEasJson,
  readBuildLog,
  runEas,
} from "../expo/expo-api.js";

/**
 * Expo/EAS для агента.
 *
 * Песочница не имеет сети для обычных команд, поэтому `terminal.exec` с `npx eas` не сработает.
 * Эти четыре инструмента — единственный путь: они включают сеть только для одного контейнера,
 * кладут токен в его окружение (не в файл и не в текст команды) и возвращают модели статус,
 * ссылку и хвост лога. Токен — интеграция пользователя, а не переменная приложения: в `.env`
 * проекта он не попадает. Ключи подписи Android/iOS остаются у EAS, агент их не читает.
 */

const cwdSchema = z.string().trim().max(200).optional();
const profileSchema = z.string().trim().max(64).regex(/^[A-Za-z0-9_-]+$/, "Профиль содержит недопустимые символы").optional();
const buildIdSchema = z.string().trim().max(500).optional();
const accountSchema = z.string().trim().max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Некорректное имя аккаунта Expo").optional();
const projectIdSchema = z.string().trim().regex(/^[0-9a-fA-F-]{8,64}$/, "Некорректный EAS project id").optional();

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, limit = 2500) {
  const value = text.trim();
  return value.length > limit ? value.slice(-limit) : value;
}

/**
 * Человек может вставить и id, и ссылку на сборку. EAS использует UUID, поэтому из ссылки
 * достаточно вытащить его, а не заставлять пользователя искать id в адресной строке.
 */
function normalizeBuildId(input?: string) {
  if (!input) return undefined;
  const match = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (!match) throw new Error("Нужен id сборки EAS (UUID) или ссылка на неё");
  return match[0];
}

/** Один POSIX-аргумент: значение из схемы не должно разбиться на слова или выйти из кавычек. */
function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Сеть и контейнер — только для этого вызова; без подключённого Expo дальше не идём. */
async function prepare(projectId: string, userId: string, relativeCwd = "") {
  const connection = await getExpoConnection(userId);
  if (!connection) {
    throw new Error(
      "Expo не подключён. Попросите пользователя подключить Expo через карточку в чате: " +
      "вызовите access.request {kind:'service', provider:'expo', purpose:'Сборка приложения через EAS Build'}. " +
      "Не просите токен текстом: значение вводится только в защищённой карточке.",
    );
  }
  const sandbox = await getSandbox(projectId, userId);
  const directory = await resolveInsideSandbox(sandbox.root, path.join(sandbox.root, relativeCwd));
  const project = await inspectExpoProject(sandbox.root, relativeCwd);
  if (!project.isExpo) {
    throw new Error(
      "В выбранном каталоге нет проекта Expo. Нужен package.json с зависимостью expo и app.json/app.config.*. " +
      "Если приложение лежит в подкаталоге, передайте cwd, например 'mobile'.",
    );
  }
  return { connection, sandbox, directory, project };
}

const defaultEasJson = {
  cli: { version: ">= 12.0.0", appVersionSource: "remote" },
  build: {
    development: { developmentClient: true, distribution: "internal" },
    preview: { distribution: "internal" },
    production: { autoIncrement: true },
  },
  submit: { production: {} },
};

registerTool({
  name: "expo.status",
  description:
    "Report whether Expo/EAS is connected for this user and what the project has for EAS Build: app config, EAS project id, slug, owner and build profiles. " +
    "Call it before a build. It does not submit anything and never returns the token. " +
    "If connected is false, ask for access with access.request {kind:'service', provider:'expo'} — never ask the user to paste a token in chat. " +
    "Expo Go QR preview is NOT available (the sandbox has no public tunnel); EAS Build is the supported path.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string", description: "Каталог Expo-приложения внутри проекта; по умолчанию корень проекта." },
    },
  },
  execute: async (input, context) => {
    const { cwd } = z.object({ cwd: cwdSchema }).parse(input ?? {});
    const connection = await getExpoConnection(context.userId).catch(error => {
      throw new Error(messageOf(error));
    });
    const sandbox = await getSandbox(context.projectId, context.userId);
    const project = await inspectExpoProject(sandbox.root, cwd ?? "");
    const profiles = project.profiles.length ? project.profiles : ["production"];
    return {
      connected: Boolean(connection),
      account: connection?.account ?? null,
      project: {
        isExpo: project.isExpo,
        appConfig: project.appConfigFile,
        hasEasJson: project.hasEasJson,
        easProjectId: project.projectId || null,
        slug: project.slug || null,
        owner: project.owner || null,
        buildProfiles: profiles,
      },
      expoGo: "not_available",
      note: !connection
        ? "Expo не подключён. Вызовите access.request {kind:'service', provider:'expo'}: пользователь вставит токен в защищённую карточку."
        : !project.isExpo
          ? "Expo подключён, но в этом каталоге не найден проект Expo. Укажите cwd подкаталога приложения."
          : !project.projectId
            ? "Проект Expo ещё не связан с EAS. Вызовите expo.setup, затем повторите сборку."
            : !project.hasEasJson
              ? "В проекте нет eas.json. Вызовите expo.setup — он создаст базовые профили development/preview/production."
              : "Всё готово к сборке: expo.build {platform, profile}.",
    };
  },
});

registerTool({
  name: "expo.setup",
  description:
    "Prepare an Expo project for EAS Build: create a minimal eas.json when it is missing and link the project to an EAS project with `eas init --non-interactive`. " +
    "This CREATES an EAS project in the user's Expo account when none is linked, so call it only when the user asked to set up mobile builds. " +
    "Input: {cwd?, account?: Expo username, projectId?: existing EAS project id to link}. " +
    "It returns the linked project id/slug/owner; the token is never returned. Requires Expo connected (access.request kind 'service', provider 'expo').",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string", description: "Каталог Expo-приложения внутри проекта." },
      account: { type: "string", description: "Аккаунт Expo, которому будет принадлежать проект; по умолчанию основной аккаунт токена." },
      projectId: { type: "string", description: "Связать с уже существующим EAS project id вместо создания нового." },
    },
  },
  execute: async (input, context) => {
    const parsed = z.object({ cwd: cwdSchema, account: accountSchema, projectId: projectIdSchema }).parse(input ?? {});
    const { connection, sandbox, directory, project } = await prepare(context.projectId, context.userId, parsed.cwd ?? "");
    if (!project.hasEasJson) {
      const target = path.join(directory, "eas.json");
      await writeFileInside(sandbox.root, target, JSON.stringify(defaultEasJson, null, 2) + "\n");
      await openDirsForSandbox(sandbox.root, path.dirname(target));
      await openFileForSandbox(target);
    }
    if (project.projectId && !parsed.projectId) {
      return {
        ok: true,
        alreadyLinked: true,
        projectId: project.projectId,
        slug: project.slug || null,
        owner: project.owner || null,
        easJsonCreated: !project.hasEasJson,
        note: "Проект уже связан с EAS. Профили: " + (project.profiles.length ? project.profiles.join(", ") : "production") + ". Запускайте expo.build.",
      };
    }

    const args = ["init", "--non-interactive", "--json"];
    if (parsed.projectId) args.push("--id", parsed.projectId, "--force");
    else if (parsed.account) args.push("--account", "$EAS_ACCOUNT");
    const env: Record<string, string> = {};
    if (parsed.account) env.EAS_ACCOUNT = parsed.account;
    const result = await runEas(sandbox, directory, connection.token, args, env, 5 * 60_000);
    if (!result.ok) {
      throw new Error("EAS init не завершился: " + tail(result.stderr || result.stdout));
    }
    const after = await inspectExpoProject(sandbox.root, parsed.cwd ?? "");
    let raw: unknown = null;
    try {
      raw = parseEasJson(result.stdout);
    } catch {
      raw = null;
    }
    return {
      ok: true,
      easJsonCreated: !project.hasEasJson,
      projectId: after.projectId || parsed.projectId || null,
      slug: after.slug || null,
      owner: after.owner || null,
      profiles: after.profiles.length ? after.profiles : ["production"],
      result: raw,
      note: "EAS init выполнен. Теперь можно вызвать expo.build. Ключи подписи EAS создаст сам при первой сборке.",
    };
  },
});

registerTool({
  name: "expo.build",
  description:
    "Start a cloud build on EAS Build and return its id and expo.dev link immediately (it does not wait for the build). " +
    "Requires Expo connected and an EAS-linked project (expo.status / expo.setup). " +
    "Input: {platform:'android'|'ios'|'all', profile?: build profile from eas.json (default 'production'), message?: short build description, cwd?: project subdirectory}. " +
    "The token stays in the integration store and is passed to EAS CLI through the container environment; never ask for it in chat. " +
    "After starting, use expo.build_status with the returned buildId to read status and logs. " +
    "Expo Go preview is not supported; this is a real EAS cloud build.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["platform"],
    properties: {
      platform: { type: "string", enum: ["android", "ios", "all"], description: "Платформа сборки." },
      profile: { type: "string", description: "Профиль из eas.json; по умолчанию production." },
      message: { type: "string", description: "Короткое сообщение к сборке, видно в EAS." },
      cwd: { type: "string", description: "Каталог Expo-приложения внутри проекта." },
    },
  },
  execute: async (input, context) => {
    const parsed = z.object({
      platform: z.enum(["android", "ios", "all"]),
      profile: profileSchema,
      message: z.string().trim().max(300).regex(/^[^\u0000-\u001f\u007f]*$/, "Сообщение содержит управляющие символы").optional(),
      cwd: cwdSchema,
    }).parse(input ?? {});
    const { connection, sandbox, directory, project } = await prepare(context.projectId, context.userId, parsed.cwd ?? "");
    if (!project.hasEasJson) {
      throw new Error("В проекте нет eas.json. Вызовите expo.setup — он создаст базовые профили, затем повторите expo.build.");
    }
    if (!project.projectId) {
      throw new Error(
        "Проект Expo не связан с EAS (нет expo.extra.eas.projectId). Вызовите expo.setup, чтобы создать или привязать проект, затем повторите сборку.",
      );
    }
    const profile = parsed.profile || "production";
    if (project.profiles.length && !project.profiles.includes(profile)) {
      throw new Error("В eas.json нет профиля «" + profile + "». Доступны: " + project.profiles.join(", ") + ".");
    }

    const args = ["build", "--platform", parsed.platform, "--profile", profile, "--non-interactive", "--no-wait", "--json"];
    if (parsed.message) args.push("--message", shellQuote(parsed.message));
    const result = await runEas(sandbox, directory, connection.token, args);
    if (!result.ok) {
      throw new Error("EAS не запустил сборку: " + tail(result.stderr || result.stdout));
    }
    const raw = parseEasJson(result.stdout);
    const builds = allBuilds(raw);
    if (!builds.length) {
      throw new Error("EAS ответил без данных сборки: " + tail(result.stdout));
    }
    const summaries = builds.map(buildSummary);
    return {
      ok: true,
      started: true,
      project: { id: project.projectId, slug: project.slug || null, owner: project.owner || null },
      profile,
      builds: summaries,
      buildId: summaries[0]?.id ?? null,
      url: summaries[0]?.url || null,
      note:
        "Сборка запущена на серверах EAS. Ссылка уже открывается в браузере. " +
        "Через 1–2 минуты вызовите expo.build_status {buildId, logs:true}, чтобы прочитать статус и хвост лога.",
    };
  },
});

registerTool({
  name: "expo.build_status",
  description:
    "Read one EAS build (or the latest build when buildId is omitted): status, error, artifacts, expo.dev link, and optionally the tail of the build log. " +
    "Input: {buildId?: id returned by expo.build, logs?: boolean (default true), cwd?: project subdirectory}. " +
    "The link and log tail are safe to show to the user. Use it after expo.build and again when the user asks whether the build finished. " +
    "Logs come from EAS through the server; the Expo token is never included in the result.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      buildId: { type: "string", description: "Идентификатор сборки из expo.build или ссылка на неё." },
      logs: { type: "boolean", description: "Вернуть хвост лога сборки; по умолчанию true." },
      cwd: { type: "string", description: "Каталог Expo-приложения внутри проекта." },
    },
  },
  execute: async (input, context) => {
    const parsed = z.object({ buildId: buildIdSchema, logs: z.boolean().optional(), cwd: cwdSchema }).parse(input ?? {});
    const buildId = normalizeBuildId(parsed.buildId);
    const { connection, sandbox, directory, project } = await prepare(context.projectId, context.userId, parsed.cwd ?? "");
    if (!project.projectId) {
      throw new Error("Проект Expo не связан с EAS. Вызовите expo.setup, затем повторите сборку.");
    }
    const args = buildId ? ["build:view", buildId, "--json"] : ["build:view", "--json"];
    const result = await runEas(sandbox, directory, connection.token, args, {}, 4 * 60_000);
    if (!result.ok) {
      throw new Error("Не удалось прочитать сборку EAS: " + tail(result.stderr || result.stdout));
    }
    const raw = parseEasJson(result.stdout);
    const build = allBuilds(raw)[0];
    if (!build) throw new Error("EAS не вернул сборку: " + tail(result.stdout));
    const summary = buildSummary(build);

    const withLogs = parsed.logs !== false;
    const logUrls = Array.isArray(build.logFiles) ? build.logFiles.slice(0, 2) : [];
    const logs = withLogs && logUrls.length
      ? await Promise.all(logUrls.map(async (url, index) => ({ index, ...(await readBuildLog(url, 6000)) })))
      : [];
    return {
      ok: true,
      build: summary,
      logs,
      note: !withLogs
        ? "Логи не запрашивались. Передайте logs:true, чтобы прочитать хвост."
        : !logUrls.length
          ? "EAS ещё не выложил файл лога (сборка в очереди). Повторите expo.build_status позже."
          : logs.every(item => !item.ok)
            ? "Статус получен, но файл лога сейчас недоступен. Ссылка на сборку выше открывает лог в браузере."
            : "Это хвост лога. Если сборка ещё идёт, повторите вызов позже — текст обновится.",
    };
  },
});
