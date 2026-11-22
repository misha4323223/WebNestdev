import { activeRunTotal } from "../agent/active-runs.js";
import { runQueueStats } from "../agent/run-limiter.js";

/**
 * Метрики для Prometheus без клиентской библиотеки: формат текстовый и стабильный, а лишняя
 * зависимость в сервере не нужна. Набор намеренно маленький — сборка, процесс и очередь
 * агента. Этого достаточно, чтобы отличить «сервер жив, но запуски стоят в очереди» от
 * «процесс упал», не открывая `/api/health` с его внутренними путями.
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

export function renderPrometheusMetrics(input: MetricsInput): string {
  const memory = input.memory ?? process.memoryUsage();
  const uptime = input.uptimeSeconds ?? process.uptime();
  const queue = runQueueStats();
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
  ];
  return lines.join("\n") + "\n";
}
