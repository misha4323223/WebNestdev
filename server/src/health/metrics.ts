import { activeRunTotal } from "../agent/active-runs.js";
import { runQueueStats } from "../agent/run-limiter.js";
import { sandboxQueueStats } from "../sandbox/sandbox-limiter.js";
import { sandboxJobCounts } from "../sandbox/jobs.js";
import { sandboxMemoryStats } from "../sandbox/memory-budget.js";
import { sandboxQueueRejections } from "../sandbox/queue-counters.js";

/**
 * Метрики для Prometheus без клиентской библиотеки: формат текстовый и стабильный, а лишняя
 * зависимость в сервере не нужна. Набор намеренно маленький — сборка, процесс и очереди
 * (запуски агента и контейнеры песочницы). Этого достаточно, чтобы отличить «сервер жив, но
 * работа ждёт свободного места» от «процесс упал», не открывая `/api/health` с его внутренними
 * путями. Числа очередей видит только эксплуатация: человеку ожидание не показывается — вместо
 * него нейтральные состояния подготовки (`agent/wait-activity.ts`).
 */
type MetricsInput = {
  build: string;
  node: string;
  uptimeSeconds?: number;
  memory?: NodeJS.MemoryUsage;
};

function label(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function gauge(name: string, help: string, value: number) {
  return ["# HELP " + name + " " + help, "# TYPE " + name + " gauge", name + " " + value];
}

/** Счётчик с одним лейблом `reason`: HELP и TYPE печатаются один раз на все значения. */
function counter(name: string, help: string, rows: Array<[string, number]>) {
  return [
    "# HELP " + name + " " + help,
    "# TYPE " + name + " counter",
    ...rows.map(([reason, value]) => name + '{reason="' + label(reason) + '"} ' + value),
  ];
}

export function renderPrometheusMetrics(input: MetricsInput): string {
  const memory = input.memory ?? process.memoryUsage();
  const uptime = input.uptimeSeconds ?? process.uptime();
  const queue = runQueueStats();
  const sandbox = sandboxQueueStats();
  const rejections = sandboxQueueRejections();
  const jobs = sandboxJobCounts();
  const sandboxMemory = sandboxMemoryStats();
  const lines = [
    "# HELP webnestdev_build_info Build and node currently serving requests.",
    "# TYPE webnestdev_build_info gauge",
    'webnestdev_build_info{build="' + label(input.build) + '",node="' + label(input.node) + '"} 1',
    ...gauge("webnestdev_uptime_seconds", "Process uptime in seconds.", uptime),
    ...gauge("webnestdev_process_resident_memory_bytes", "Resident memory of the server process.", memory.rss),
    ...gauge("webnestdev_process_heap_used_bytes", "V8 heap used by the server process.", memory.heapUsed),
    ...gauge("webnestdev_agent_runs_active", "Agent runs currently executing in this process.", activeRunTotal()),
    ...gauge("webnestdev_agent_run_slots", "Configured concurrent agent run slots.", queue.limit),
    ...gauge("webnestdev_agent_runs_queued", "Agent runs waiting for a slot.", queue.queued),
    ...gauge("webnestdev_agent_queue_slots", "Configured agent queue slots.", queue.queueLimit),
    ...gauge("webnestdev_sandbox_active_containers", "Sandbox containers running in this process.", sandbox.active),
    ...gauge("webnestdev_sandbox_slots", "Configured concurrent sandbox container slots.", sandbox.limit),
    ...gauge("webnestdev_sandbox_commands_waiting", "Sandbox commands waiting for a container slot.", sandbox.queued),
    ...gauge("webnestdev_sandbox_queue_slots", "Configured sandbox queue slots.", sandbox.queueLimit),
    ...gauge("webnestdev_sandbox_jobs_running", "Long-running terminal jobs holding a container.", jobs.running),
    ...gauge("webnestdev_sandbox_job_slots", "Configured long-running job slots.", jobs.limit),
    ...gauge("webnestdev_sandbox_memory_used_mb", "Memory ceilings reserved by sandbox containers and jobs.", sandboxMemory.usedMb),
    ...gauge("webnestdev_sandbox_memory_budget_mb", "Memory budget shared by sandbox commands and long jobs.", sandboxMemory.limitMb),
    ...gauge("webnestdev_sandbox_memory_waiting", "Sandbox containers waiting for memory budget.", sandboxMemory.waiting),
    ...counter("webnestdev_sandbox_rejected_total", "Sandbox commands that got no container place, by reason.", [
      ["queue_full", rejections.queueFull],
      ["wait_timeout", rejections.waitTimedOut],
    ]),
  ];
  return lines.join("\n") + "\n";
}
