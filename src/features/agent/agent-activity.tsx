import { useState } from "react";
import {
  Activity,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FileSymlink,
  FileText,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  ListChecks,
  LoaderCircle,
  MonitorCheck,
  MousePointerClick,
  Package,
  PowerOff,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import type { AgentAction, ChatMessage, PlanState } from "../../lib/types";

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
  "preview.start": { icon: Rocket, label: "Запускает превью" },
  "preview.stop": { icon: PowerOff, label: "Останавливает превью" },
  "project.verify": { icon: ShieldCheck, label: "Проверяет доступность" },
  "browser.open": { icon: Globe, label: "Открывает страницу" },
  "browser.inspect": { icon: ScanSearch, label: "Разбирает HTML" },
  "browser.runtime": { icon: MonitorCheck, label: "Проверяет в Chromium" },
  "browser.scenario": { icon: MousePointerClick, label: "Прогоняет сценарий пользователя" },
  "plan.update": { icon: ListChecks, label: "Обновляет план задач" },
};

const PREFIX_ICONS: Array<[string, ActionDescriptor]> = [
  ["git.", { icon: GitBranch, label: "Работа с Git" }],
  ["browser.", { icon: Globe, label: "Проверяет в браузере" }],
  ["preview.", { icon: Rocket, label: "Управляет превью" }],
  ["project.", { icon: FolderOpen, label: "Работа с проектом" }],
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
  for (const key of ["command", "path", "url", "query", "message", "branch", "name", "title"]) {
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
  const results = new Map<string, { failed: boolean }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_call_id) continue;
    results.set(message.tool_call_id, { failed: hasError(message.content) });
  }
  const actions: AgentAction[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.name === "plan.update") continue;
      const result = results.get(call.id);
      actions.push({
        id: call.id,
        name: call.name,
        target: actionTarget(call.name, call.arguments).slice(0, 200),
        // A call without a stored result was interrupted: it is not reported as done.
        status: !result ? "running" : result.failed ? "failed" : "done",
        startedAt: 0,
      });
    }
  }
  return actions;
}

/** A tool result is a JSON payload; an `error` key means the call itself failed. */
function hasError(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { error?: unknown; ok?: unknown };
    if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) return true;
    if (parsed && typeof parsed === "object" && parsed.ok === false) return true;
    return false;
  } catch {
    return false;
  }
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

/** The three windows of a run: the plan, the actions and the model's thinking. */
export type PanelId = "plan" | "actions" | "thinking";
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

export function ActionsPanel({ actions, running, progress, collapsed, onToggle }: {
  actions: AgentAction[];
  running: boolean;
  progress: { step: number; maxSteps: number } | null;
} & PanelToggles) {
  const failed = actions.filter(action => action.status === "failed").length;
  const status = <span className="run-panel-state">
    {running
      ? <><LoaderCircle size={12} className="agent-spin"/> выполняется{progress ? " · шаг " + progress.step + " из " + progress.maxSteps : ""}</>
      : "завершено"}
    {failed > 0 && <span className="run-panel-error"><CircleAlert size={12}/> с ошибкой: {failed}</span>}
  </span>;
  return <RunPanel
    id="actions"
    icon={<Activity size={13}/>}
    title="Действия агента"
    meta={actions.length ? actions.length + " действий" : undefined}
    status={status}
    collapsed={collapsed}
    onToggle={onToggle}
  >
    <ul>
      {actions.map(action => {
        const { icon: Icon, label } = describeAction(action.name);
        return <li key={action.id} className={"action-row action-" + action.status}>
          <span className="action-icon"><Icon size={13}/></span>
          <span className="action-label">{label}</span>
          {action.target && <code className="action-target" title={action.target}>{action.target}</code>}
          <span className="action-status">
            {action.status === "running"
              ? <LoaderCircle size={12} className="agent-spin"/>
              : action.status === "failed"
                ? <CircleAlert size={12}/>
                : <CircleCheck size={12}/>}
            {action.status !== "running" && typeof action.durationMs === "number" && <small>{(action.durationMs / 1000).toFixed(1)} с</small>}
          </span>
        </li>;
      })}
    </ul>
  </RunPanel>;
}

/** The model's chain of thought, streamed while it works. */
export function ThinkingPanel({ text, running, collapsed, onToggle }: {
  text: string;
  running: boolean;
} & PanelToggles) {
  return <RunPanel
    id="thinking"
    icon={<Brain size={13}/>}
    title="Размышления агента"
    status={<span className="run-panel-state">{running ? <><LoaderCircle size={12} className="agent-spin"/> думает</> : "готово"}</span>}
    collapsed={collapsed}
    onToggle={onToggle}
  >
    <div className="agent-thinking">{text}</div>
  </RunPanel>;
}

/** The thinking of one past turn, folded away under its answer. */
export function MessageThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return <div className={"message-thinking" + (open ? " message-thinking-open" : "")}>
    <button type="button" className="message-thinking-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
      <Brain size={12}/>
      <span>Размышления</span>
    </button>
    {open && <div className="agent-thinking">{text}</div>}
  </div>;
}
