import {
  Activity,
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
import type { AgentAction, PlanState } from "../../lib/types";

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
 * Plans persist in localStorage per conversation so they survive page reloads,
 * tab switches and workspace remounts. The key is scoped to the conversation id.
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

export function PlanCard({ plan }: { plan: PlanState }) {
  const done = plan.items.filter(item => item.status === "done").length;
  const total = plan.items.length;
  return <div className="agent-plan">
    <div className="agent-plan-head">
      <ListChecks size={13}/>
      <strong>План задач</strong>
      <span className="agent-plan-count">{done} из {total} выполнено</span>
    </div>
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
  </div>;
}

export function ActionsCard({ actions, running, progress }: { actions: AgentAction[]; running: boolean; progress: { step: number; maxSteps: number } | null }) {
  const failed = actions.filter(action => action.status === "failed").length;
  return <div className="agent-actions">
    <div className="agent-actions-head">
      <Activity size={13}/>
      <strong>Действия агента</strong>
      <span className="agent-actions-state">
        {running
          ? <><LoaderCircle size={12} className="agent-spin"/> выполняется{progress ? " · шаг " + progress.step + " из " + progress.maxSteps : ""}</>
          : "завершено"}
      </span>
      {failed > 0 && <span className="agent-actions-error"><CircleAlert size={12}/> с ошибкой: {failed}</span>}
    </div>
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
  </div>;
}
