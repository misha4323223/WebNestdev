import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  Download,
  FileSymlink,
  FileText,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MonitorCheck,
  MousePointerClick,
  Newspaper,
  Package,
  PowerOff,
  Rocket,
  ScanSearch,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import type { AgentAction, ChatMessage, PlanState } from "../../lib/types";
import { commandLines, diffLines, fileLines, previewToText, readLines, textLines, type CodePreview } from "./agent-diff";

type IconComponent = typeof Globe;
type ActionDescriptor = { icon: IconComponent; label: string };

/**
 * What the user sees for each tool: a planet for browsing the web, a wrench for writing
 * code, a file for reading one, a terminal for commands. Unmapped tools still get an
 * icon from the prefix rules, so a row never renders empty.
 */
const TOOL_ICONS: Record<string, ActionDescriptor> = {
  "fs.list": { icon: FolderTree, label: "Смотрит файлы" },
  "fs.read": { icon: FileText, label: "Читает файл" },
  "fs.write": { icon: Wrench, label: "Пишет код" },
  "fs.rename": { icon: FileSymlink, label: "Переименовывает файл" },
  "fs.delete": { icon: Trash2, label: "Удаляет файл" },
  "terminal.exec": { icon: SquareTerminal, label: "Команда в терминале" },
  "npm.install": { icon: Package, label: "Ставит зависимости" },
  "pip.install": { icon: Package, label: "Ставит Python-зависимости" },
  "net.request": { icon: Send, label: "Запрашивает внешний API" },
  "net.download": { icon: Download, label: "Скачивает файл" },
  "preview.start": { icon: Rocket, label: "Запускает превью" },
  "preview.stop": { icon: PowerOff, label: "Останавливает превью" },
  "project.verify": { icon: ShieldCheck, label: "Проверяет доступность" },
  "browser.open": { icon: Globe, label: "Открывает страницу" },
  "browser.inspect": { icon: ScanSearch, label: "Разбирает HTML" },
  "browser.runtime": { icon: MonitorCheck, label: "Проверяет в Chromium" },
  "browser.scenario": { icon: MousePointerClick, label: "Прогоняет сценарий пользователя" },
  // Поиск и чтение страниц — тот же интернет, но разные действия: лупа и газета, как у остальных
  // инструментов, чтобы в списке было видно, что агент искал, а что читал найденное.
  "web.search": { icon: Search, label: "Ищет в интернете" },
  "web.read": { icon: Newspaper, label: "Читает страницу" },
  "plan.update": { icon: ListChecks, label: "Обновляет план задач" },
  "secrets.request": { icon: KeyRound, label: "Запрашивает ключ" },
};

const PREFIX_ICONS: Array<[string, ActionDescriptor]> = [
  ["git.", { icon: GitBranch, label: "Работа с Git" }],
  ["browser.", { icon: Globe, label: "Проверяет в браузере" }],
  ["preview.", { icon: Rocket, label: "Управляет превью" }],
  ["project.", { icon: FolderOpen, label: "Работа с проектом" }],
  ["web.", { icon: Search, label: "Работа с интернетом" }],
  ["net.", { icon: Globe, label: "Работа с внешним API" }],
  ["fs.", { icon: FileText, label: "Работа с файлами" }],
];

const FALLBACK_ICON: ActionDescriptor = { icon: Sparkles, label: "Выполняет действие" };

export function describeAction(name: string): ActionDescriptor {
  return TOOL_ICONS[name] ?? PREFIX_ICONS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? FALLBACK_ICON;
}

/** One short line describing what the action touched: a path, a command, a url, a package. */
export function actionTarget(name: string, input: unknown): string {
  const value = (input ?? {}) as Record<string, unknown>;
  const text = (candidate: unknown) => (typeof candidate === "string" ? candidate.trim() : "");

  if (name === "fs.rename") {
    const from = text(value.from);
    const to = text(value.to);
    if (from || to) return [from, to].filter(Boolean).join(" → ");
  }
  if (name === "npm.install") {
    const packages = [value.packages, value.dependencies].find(Array.isArray) as unknown[] | undefined;
    const list = (packages ?? []).map(text).filter(Boolean);
    if (list.length) return list.join(", ");
  }
  // `question` — строка инструмента question.ask: в списке действий видно, о чём агент спросил,
  // а не безымянный набор ключей.
  for (const key of ["command", "path", "url", "query", "question", "message", "branch", "name", "title", "variable"]) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  const keys = Object.keys(value);
  return keys.length ? "{" + keys.slice(0, 4).join(", ") + "}" : "";
}

/**
 * The actions of a past run are rebuilt from the conversation itself: every assistant
 * turn keeps the tool calls it made, and every tool call keeps its result as a separate
 * message. That is why the action list survives a reload instead of living only in the
 * browser tab that watched the run.
 */
export function deriveActions(messages: ChatMessage[]): AgentAction[] {
  const results = new Map<string, { failed: boolean; output: unknown }>();
  for (const message of messages) {
    // A tool result is its own `tool` turn, keyed by the call it answers. Reading it from an
    // assistant turn left every restored action without a result — and therefore without the
    // content or the diff its expanded row is supposed to show.
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const parsed = parseToolResult(message.content);
    results.set(message.tool_call_id, { failed: hasError(parsed), output: parsed });
  }
  const actions: AgentAction[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.name === "plan.update") continue;
      const result = results.get(call.id);
      const before = call.name === "fs.write" || call.name === "fs.delete"
        ? knownFileContent(actions, filePathOf(call.arguments))
        : undefined;
      actions.push({
        id: call.id,
        name: call.name,
        target: actionTarget(call.name, call.arguments).slice(0, 200),
        // A call without a stored result was interrupted: it is not reported as done.
        status: !result ? "running" : result.failed ? "failed" : "done",
        startedAt: 0,
        input: call.arguments,
        ...(result ? { output: result.output } : {}),
        ...(before !== undefined ? { before } : {}),
      });
    }
  }
  return actions;
}

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

/** A tool result is a JSON payload; an `error` key means the call itself failed. */
function hasError(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const value = parsed as { error?: unknown; ok?: unknown };
  if ("error" in value && value.error) return true;
  return value.ok === false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function filePathOf(input: unknown) {
  return stringValue(asRecord(input).path).replace(/^\.\//, "");
}

/**
 * The last full content of a file from earlier actions. A read window that starts at zero
 * and is not truncated is complete; a write carries the full new file.
 */
export function knownFileContent(actions: AgentAction[], path: string): string | undefined {
  const normalized = path.replace(/^\.\//, "");
  if (!normalized) return undefined;
  for (let index = actions.length - 1; index >= 0; index--) {
    const action = actions[index];
    if (action.status === "failed" || filePathOf(action.input) !== normalized) continue;
    if (action.name === "fs.write") {
      const content = asRecord(action.input).content;
      if (typeof content === "string") return content;
    }
    if (action.name === "fs.read") {
      const output = asRecord(action.output);
      if (output.offset === 0 && output.truncated === false && typeof output.content === "string") return output.content;
    }
    // A later deletion means the file did not exist when the current action started: the
    // next write creates it again, so its previous content is known to be empty.
    if (action.name === "fs.delete") return "";
  }
  return undefined;
}

/** Content the action is about to replace or remove, when an earlier action read it. */
export function contentBefore(actions: AgentAction[], name: string, input: unknown): string | undefined {
  if (name !== "fs.write" && name !== "fs.delete") return undefined;
  return knownFileContent(actions, filePathOf(input));
}

/**
 * Plans persist in localStorage per conversation, so the panel still shows something
 * when the server plan is missing (an old conversation, or an offline API).
 */
function planKey(conversationId: string) {
  return "webnestdev.plan." + conversationId;
}

export function readPlan(conversationId: string): PlanState | null {
  try {
    const raw = localStorage.getItem(planKey(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlanState;
    if (Array.isArray(parsed.items) && parsed.items.length) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writePlan(conversationId: string, plan: PlanState) {
  try {
    localStorage.setItem(planKey(conversationId), JSON.stringify(plan));
  } catch {
    // storage full or unavailable — plan still shows in-memory for this session
  }
}

/**
 * The two windows of a run that sit next to the composer: the plan and the actions. The model's
 * thinking is not one of them — it belongs to the answer it produced and lives in the message itself.
 */
export type PanelId = "plan" | "actions";
export type PanelState = Record<PanelId, boolean>;
export type PanelToggles = { collapsed: PanelState; onToggle: (id: PanelId) => void };

function RunPanel({ id, icon, title, meta, status, collapsed, onToggle, children }: {
  id: PanelId;
  icon: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
} & PanelToggles) {
  const open = !collapsed[id];
  return <section className={"run-panel run-panel-" + id + (open ? " run-panel-open" : "")}>
    <button type="button" className="run-panel-head" onClick={() => onToggle(id)} aria-expanded={open}>
      {open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
      {icon}
      <strong>{title}</strong>
      {status}
      {meta && <span className="run-panel-meta">{meta}</span>}
    </button>
    {open && <div className="run-panel-body">{children}</div>}
  </section>;
}

export function PlanPanel({ plan, collapsed, onToggle }: { plan: PlanState } & PanelToggles) {
  const done = plan.items.filter(item => item.status === "done").length;
  const total = plan.items.length;
  return <RunPanel
    id="plan"
    icon={<ListChecks size={13}/>}
    title="План задач"
    meta={done + " из " + total + " выполнено"}
    collapsed={collapsed}
    onToggle={onToggle}
  >
    <div className="agent-plan-bar" role="presentation"><span style={{ width: Math.round((done / total) * 100) + "%" }}/></div>
    <ul>
      {plan.items.map((item, index) => <li key={index} className={"plan-item plan-" + item.status}>
        <span className="plan-icon">
          {item.status === "done"
            ? <CircleCheck size={14}/>
            : item.status === "in_progress"
              ? <LoaderCircle size={14} className="agent-spin"/>
              : <CircleDashed size={14}/>}
        </span>
        <span className="plan-text">
          <span className="plan-title">{item.title}</span>
          {item.note && <small className="plan-note">{item.note}</small>}
        </span>
        {item.status === "in_progress" && <span className="plan-now">сейчас</span>}
      </li>)}
    </ul>
  </RunPanel>;
}

type ActionDetailData = {
  title: string;
  note?: string;
  preview?: CodePreview;
  copyText?: string;
  empty?: string;
  /** PNG проверки: тот же адрес, по которому снимок открывает панель «Файлы». */
  imageUrl?: string;
};

/** Снимок из результата browser.screenshot / browser.runtime: только собственный маршрут снимков. */
function screenshotUrlOf(output: Record<string, unknown> | null) {
  const screenshot = asRecord(output?.screenshot);
  const url = stringValue(screenshot?.url);
  return url.startsWith("/api/projects/") ? url : "";
}

function prettyValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function changeNote(added: number, removed: number) {
  if (!added && !removed) return "Содержимое не изменилось";
  return "+" + added + " · −" + removed;
}

/** What the expanded row shows: a read window, a line diff, a command result or a call payload. */
function actionDetail(action: AgentAction): ActionDetailData {
  const input = asRecord(action.input);
  const output = asRecord(action.output);
  const error = stringValue(output.error);
  if (error) return {
    title: "Ошибка инструмента",
    note: error,
    preview: textLines(error, "error"),
    copyText: error,
  };

  if (action.name === "fs.read") {
    const content = stringValue(output.content);
    if (!content) return {
      title: "Чтение файла",
      note: action.status === "running" ? "Ждём содержимое…" : "Файл пуст",
      empty: action.status === "running" ? "Агент ещё читает этот файл." : "Файл не содержит текста.",
    };
    const offset = typeof output.offset === "number" ? output.offset : 0;
    const total = typeof output.totalChars === "number" ? output.totalChars : content.length;
    return {
      title: "Содержимое файла",
      note: "окно с " + offset.toLocaleString("ru-RU") + " · " + total.toLocaleString("ru-RU") + " символов",
      preview: readLines(content),
      copyText: content,
    };
  }

  if (action.name === "fs.write") {
    const content = stringValue(input.content);
    if (typeof action.before === "string") {
      const diff = diffLines(action.before, content);
      return {
        title: "Изменения файла",
        note: changeNote(diff.added, diff.removed),
        preview: diff,
        copyText: previewToText(diff),
        empty: "Содержимое файла не изменилось.",
      };
    }
    return {
      title: "Новая версия файла",
      note: "предыдущая версия не загружена — показан весь файл",
      preview: fileLines(content, "add"),
      copyText: content,
    };
  }

  if (action.name === "fs.delete") {
    if (typeof action.before === "string") {
      if (!action.before) return {
        title: "Удалённое содержимое",
        note: "файл был пуст",
        empty: "Файл был пуст.",
      };
      const preview = fileLines(action.before, "remove");
      return {
        title: "Удалённое содержимое",
        note: "−" + preview.removed + " строк",
        preview,
        copyText: action.before,
      };
    }
    return {
      title: "Файл удалён",
      note: "содержимое до удаления не загружено",
      empty: "Агент удалил файл, но не читал его содержимое в этом диалоге.",
    };
  }

  if (action.name === "fs.rename") {
    const from = stringValue(input.from);
    const to = stringValue(input.to);
    return {
      title: "Переименование",
      note: from && to ? from + " → " + to : undefined,
      empty: from && to ? "Путь файла изменён без изменения содержимого." : "Путь не указан.",
    };
  }

  if (action.name === "terminal.exec" || action.name === "npm.install") {
    const command = stringValue(input.command) || "npm install";
    const stdout = stringValue(output.stdout);
    const stderr = stringValue(output.stderr);
    if (action.output === undefined) return {
      title: "Команда",
      note: command,
      empty: "Ждём завершения команды…",
      copyText: command,
    };
    const exit = typeof output.exitCode === "number" ? output.exitCode : null;
    return {
      title: "Команда",
      note: [command, exit !== null ? "код " + exit : ""].filter(Boolean).join(" · "),
      preview: commandLines(stdout, stderr),
      copyText: [stdout, stderr].filter(Boolean).join("\n"),
      empty: "Команда завершилась без вывода.",
    };
  }

  if (action.name === "fs.list" && Array.isArray(action.output)) {
    const text = action.output.map(item => {
      const entry = asRecord(item);
      const name = stringValue(entry.name);
      return (entry.type === "directory" ? "📁 " : "📄 ") + name;
    }).join("\n");
    return { title: "Содержимое каталога", note: action.output.length + " элементов", preview: textLines(text), copyText: text };
  }

  const payload = action.output !== undefined ? action.output : action.input;
  const text = prettyValue(payload);
  const imageUrl = screenshotUrlOf(output);
  return {
    title: action.output !== undefined ? "Результат вызова" : "Параметры вызова",
    note: action.status === "running" ? "Ждём результат…" : imageUrl ? "Снимок страницы" : undefined,
    preview: text ? textLines(text) : undefined,
    copyText: text || undefined,
    empty: "У этого действия нет текстового результата.",
    ...(imageUrl ? { imageUrl } : {}),
  };
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function ActionDetailView({ action }: { action: AgentAction }) {
  const detail = actionDetail(action);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [action.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const lines = detail.preview?.lines.slice(0, 400) ?? [];
  const hidden = detail.preview ? Math.max(0, detail.preview.total - lines.length) : 0;
  return <div className="action-detail">
    <div className="action-detail-head">
      <div className="action-detail-title">
        <strong>{detail.title}</strong>
        {detail.note && <span title={detail.note}>{detail.note}</span>}
      </div>
      {detail.copyText && <button type="button" className="action-copy" onClick={() => { void copyToClipboard(detail.copyText ?? "").then(ok => { if (ok) setCopied(true); }); }} title="Копировать содержимое">
        {copied ? <Check size={12}/> : <Copy size={12}/>}{copied ? "Скопировано" : "Копировать"}
      </button>}
    </div>
    {detail.imageUrl && <a className="action-screenshot" href={detail.imageUrl} target="_blank" rel="noreferrer" title="Открыть снимок в новой вкладке">
      <img src={detail.imageUrl} alt="Снимок страницы, сделанный агентом" loading="lazy"/>
    </a>}
    {detail.preview && lines.length > 0 && <div className="action-code" role="region" aria-label={detail.title}>
      {lines.map((line, index) => <div key={line.line + ":" + index} className={"code-line code-" + line.kind}>
        <span className="code-no">{line.line}</span>
        <span className="code-sign">{line.sign}</span>
        <code>{line.text || " "}</code>
      </div>)}
      {hidden > 0 && <div className="action-code-more">Показаны первые {lines.length} из {detail.preview.total} строк</div>}
    </div>}
    {detail.empty && (!detail.preview || lines.length === 0) && <p className="action-detail-empty">{detail.empty}</p>}
  </div>;
}

/** «1 действие / 2 действия / 5 действий»: счётчик в шапке читается как фраза, а не как число. */
function actionCountLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "действие" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "действия" : "действий";
  return count + " " + word;
}

/**
 * Действия агента — док под полем ввода, а не панель над ним: это статус текущей работы, и он
 * должен стоять там, где уже находится рука. Разворачивается вверх, поверх переписки, и
 * закрывается нажатием в любом месте вне дока — не только своей стрелкой.
 */
export function ActionsDock({ actions, running, progress, open, onOpenChange }: {
  actions: AgentAction[];
  running: boolean;
  progress: { step: number; maxSteps: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const failed = actions.filter(action => action.status === "failed").length;
  // Открытый список держится у последнего действия: агент пишет сверху вниз, и новое должно быть
  // видно без ручной прокрутки.
  useEffect(() => {
    if (!open) return;
    const box = listRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [open, actions.length]);

  return <>
    {open && <div className="actions-popover" id="agent-actions-popover" role="region" aria-label="Действия агента">
      <div className="actions-popover-head">
        <span className="eyebrow">ДЕЙСТВИЯ АГЕНТА</span>
        <span className="actions-popover-count">{actions.length ? actionCountLabel(actions.length) : "пока пусто"}</span>
        <button type="button" className="icon-button" onClick={() => onOpenChange(false)} title="Свернуть" aria-label="Свернуть действия"><ChevronDown size={14}/></button>
      </div>
      <ul className="actions-popover-list" ref={listRef}>
      {actions.map(action => {
        const { icon: Icon, label } = describeAction(action.name);
        const expanded = openId === action.id;
        const detailId = "action-detail-" + action.id;
        // Снимок виден в самой строке действия: человек не должен раскрывать вызов, чтобы
        // посмотреть, как выглядит страница после проверки.
        const thumbUrl = screenshotUrlOf(asRecord(action.output));
        return <li key={action.id} className={"action-row action-" + action.status + (expanded ? " action-open" : "")}>
          <button type="button" className="action-summary" onClick={() => setOpenId(expanded ? null : action.id)} aria-expanded={expanded} aria-controls={detailId}>
            <span className="action-chevron">{expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}</span>
            <span className="action-icon"><Icon size={13}/></span>
            <span className="action-label">{label}</span>
            {action.target && <code className="action-target" title={action.target}>{action.target}</code>}
            {thumbUrl && <img className="action-thumb" src={thumbUrl} alt="Снимок страницы" loading="lazy"/>}
            <span className="action-status">
              {action.status === "running"
                ? <LoaderCircle size={12} className="agent-spin"/>
                : action.status === "failed"
                  ? <CircleAlert size={12}/>
                  : <CircleCheck size={12}/>}
              {action.status !== "running" && typeof action.durationMs === "number" && <small>{(action.durationMs / 1000).toFixed(1)} с</small>}
            </span>
          </button>
          {expanded && <div id={detailId}><ActionDetailView action={action}/></div>}
        </li>;
      })}
      </ul>
    </div>}
    <button type="button" className={"actions-dock-trigger" + (open ? " open" : "")} onClick={() => onOpenChange(!open)} aria-expanded={open} aria-controls="agent-actions-popover" title={open ? "Свернуть действия агента" : "Развернуть действия агента"}>
      <Activity size={13} className={running ? "actions-dock-live" : ""}/>
      <strong>Действия агента</strong>
      {actions.length > 0 && <span className="actions-dock-meta">{actionCountLabel(actions.length)}</span>}
      <span className="actions-dock-state">
        {running
          ? <><LoaderCircle size={12} className="agent-spin"/>выполняется{progress ? " · шаг " + progress.step + "/" + progress.maxSteps : ""}</>
          : "завершено"}
      </span>
      {failed > 0 && <span className="actions-dock-error" title={"Действий с ошибкой: " + failed} aria-label={"Действий с ошибкой: " + failed}><CircleAlert size={12}/>{failed}</span>}
      <ChevronUp size={13} className="actions-dock-chevron"/>
    </button>
  </>;
}

/**
 * The chain of thought of one answer, shown **above** it — the model thinks first and writes after, so
 * the thinking sits where the answer will appear rather than in a separate window far from the text it
 * explains — and one click folds it away.
 *
 * Строка размышления не спорит с ответом за внимание: это одно слово «Размышляю…» в цвете темы и
 * стрелка «развернуть». Ни пилюли, ни рамки, ни служебных чисел — развернув, пользователь читает сам
 * поток мыслей; свёрнутая строка лишь говорит, что модель думает.
 *
 * Пока модель не прислала ни строчки размышления, остаётся та же надпись без стрелки: разворачивать
 * нечего. Выбор пользователя сильнее умолчания: если блок свернули руками, он таким и останется.
 */
export function MessageThinking({ text, running }: {
  text: string;
  /** The answer this block belongs to is being written right now. */
  running?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(running));
  const [chosen, setChosen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!chosen) setOpen(Boolean(running)); }, [running, chosen]);
  // Поток мыслей длиннее окна: пока модель говорит, видны её последние строки, а не начало абзаца.
  useEffect(() => {
    const box = bodyRef.current;
    if (!box || !running) return;
    box.scrollTop = box.scrollHeight;
  }, [text, running]);
  const said = Boolean(text.trim());
  // Ни строчки размышления — не повод для пустого окна с обещанием: пока модель молчит, видно только
  // слово, которое само пульсирует, пока идёт работа. Разворачивать нечего, поэтому без стрелки.
  if (!said && running) return <div className="thinking-waiting" role="status"><span className="thinking-title">Размышляю…</span></div>;
  // A finished turn without thinking says nothing: an empty folded row would only be noise.
  if (!said) return null;
  return <div className={"thinking" + (open ? " thinking-open" : "") + (running ? " thinking-live" : "")}>
    <button type="button" className="thinking-head" title={open ? "Свернуть размышления" : "Развернуть размышления"} onClick={() => { setChosen(true); setOpen(value => !value); }} aria-expanded={open}>
      <span className="thinking-title">{running ? "Размышляю…" : "Размышления"}</span>
      <span className="thinking-toggle"><ChevronDown size={12}/></span>
    </button>
    {open && <div className="thinking-body" ref={bodyRef}>
      <div className="thinking-text">{text}{running && <span className="thinking-cursor" aria-hidden="true"/>}</div>
    </div>}
  </div>;
}
