import { registerTool } from "../tool-registry.js";

/**
 * Мост между основным агентом и read-only разведчиком.
 *
 * Сам цикл живёт в `agent/scout.ts`: инструмент только проверяет вход и передаёт задачу тому
 * runner'у, который создан на этот запуск. Так у разведчика один контекст и один бюджет на
 * запуск, а не новый на каждый вызов.
 *
 * `kind` — это профиль, а не отдельный инструмент: одна схема дешевле, чем две, и модели не
 * нужно выбирать между почти одинаковыми описаниями. `web` открывает публичные страницы только
 * при включённом поиске в интернете; без него runtime отвечает понятным отказом.
 */
registerTool({
  name: "agent.scout",
  description:
    "Delegate one focused, read-only investigation to a subagent with its own small context. " +
    "Use it when the answer needs several files or a broad search away from the current thread, " +
    "not for a file you can read in one call. The scout cannot change anything and cannot call " +
    "other subagents. Returns {ok, summary, files, findings, sources?}: a compact JSON answer " +
    "instead of the files or pages it had to read. " +
    "kind: 'code' (default) searches the project with fs/project/git tools. " +
    "kind: 'web' searches public pages with web.search and web.read and returns the urls it actually read in sources; " +
    "it requires the user's internet-search switch in the «Режимы» menu and is refused without it. " +
    "Use web only for facts outside the project, never for project source code.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description: "Конкретный вопрос: что найти, где и зачем. Чем уже вопрос, тем короче разведка.",
      },
      focus: {
        type: "string",
        description: "Необязательное уточнение: каталоги, имена символов, гипотезы или адреса, которые нужно проверить.",
      },
      kind: {
        type: "string",
        enum: ["code", "web"],
        description: "Профиль разведки: code — исходники проекта (по умолчанию), web — публичные страницы при включённом поиске в интернете.",
      },
    },
  },
  execute: async (input, context) => {
    const value = (input ?? {}) as { task?: unknown; focus?: unknown; kind?: unknown };
    const task = typeof value.task === "string" ? value.task.trim() : "";
    if (!task) throw new Error("agent.scout: нужна задача для разведки");
    if (value.kind !== undefined && value.kind !== "code" && value.kind !== "web") {
      throw new Error("agent.scout: kind должен быть 'code' или 'web'");
    }
    if (!context.scout) {
      throw new Error("Субагент-разведчик недоступен в этом запуске. Исследуй проект сам через fs.grep, fs.outline и fs.read.");
    }
    const focus = typeof value.focus === "string" ? value.focus.trim() : "";
    const kind = value.kind === "web" ? "web" : "code";
    return context.scout({ task, kind, ...(focus ? { focus } : {}) });
  },
});
