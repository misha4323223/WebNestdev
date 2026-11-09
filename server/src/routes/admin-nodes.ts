import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { nodeId } from "../nodes/identity.js";
import {
  countProjectsByNode,
  getNode,
  listNodes,
  setNodeStatus,
  upsertNode,
  type SandboxNodeStatus,
} from "../nodes/node-store.js";
import { isNodeFresh } from "../nodes/placement.js";
import { getProject, reassignProjectNode } from "../project-store.js";
import { hydratePreview, listPreviewsAcrossReplicas } from "../preview/preview-store.js";
import { listSandboxJobs } from "../sandbox/jobs.js";
import { sandboxMemoryMb } from "../sandbox/config.js";
import { recordAudit } from "../security/audit-journal.js";
import { unregisterSandboxHost } from "../sandbox/host.js";
import { listPreviews } from "../preview/preview-store.js";
import { previewStartStats } from "../preview/preview-metrics.js";
import { powerOnNode, readNodePower } from "../nodes/mws-power.js";
import { readSwitchover, requestSwitchover, switchoverStatus } from "../nodes/switchover.js";

const statusSchema = z.object({
  status: z.enum(["online", "draining", "offline"]),
  confirm: z.literal(true),
});

const moveSchema = z.object({
  node: z.string().trim().min(1).max(120),
});

const powerSchema = z.object({
  action: z.literal("on"),
  confirm: z.literal(true),
  reason: z.string().trim().max(200).optional(),
});

const switchoverSchema = z.object({
  confirm: z.literal(true),
  reason: z.string().trim().max(200).optional(),
});

const registerSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Недопустимый id узла"),
  address: z.string().trim().min(1).max(300),
  status: z.enum(["online", "draining", "offline"]).optional(),
});

function validRunnerAddress(value: string) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : "http://" + value);
    return Boolean(parsed.hostname) && !parsed.username && !parsed.password && (parsed.pathname === "/" || parsed.pathname === "");
  } catch {
    return false;
  }
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function nodesWithProjects() {
  const [nodes, projectsByNode] = await Promise.all([listNodes(), countProjectsByNode()]);
  const previewsByNode = new Map<string, number>();
  for (const preview of await listPreviewsAcrossReplicas()) {
    const key = preview.node ?? nodeId();
    previewsByNode.set(key, (previewsByNode.get(key) ?? 0) + 1);
  }
  const starts = previewStartStats();
  return nodes.map(node => ({
    ...node,
    projects: projectsByNode.get(node.id) ?? 0,
    previews: previewsByNode.get(node.id) ?? 0,
    previewStarts: starts.get(node.id) ?? { count: 0, p95Ms: null, failures: 0 },
    freeMemoryMb: Math.max(0, node.memoryTotalMb - node.memoryUsedMb),
    fresh: isNodeFresh(node),
  }));
}

/**
 * The operator's view of placement. `draining` is the safe way to remove a machine: new
 * projects are not placed there, while projects already pinned to it keep their files until a
 * later stage moves or archives them.
 */
export async function registerAdminNodeRoutes(app: FastifyInstance) {
  app.get("/api/admin/nodes", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return { localNodeId: nodeId(), nodes: await nodesWithProjects() };
  });

  /**
   * Register a runner that the API can poll. The runner never writes the registry: it has no
   * database, and the API's heartbeat is the single writer of observed metrics. The node is
   * online but starts with zero capacity, so placement will not use it until the first
   * successful heartbeat reports memory.
   */
  app.post("/api/admin/nodes", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const body = registerSchema.parse(request.body);
    if (body.id === nodeId()) return reply.code(400).send({ error: "Нельзя зарегистрировать локальный узел как удалённый" });
    if (!validRunnerAddress(body.address)) return reply.code(400).send({ error: "Адрес runner должен быть host:port или http(s)://host:port" });
    const existing = await getNode(body.id);
    const now = new Date().toISOString();
    const node = await upsertNode({
      id: body.id,
      address: body.address.replace(/\/+$/, ""),
      status: body.status ?? existing?.status ?? "online",
      memoryTotalMb: existing?.memoryTotalMb ?? 0,
      memoryUsedMb: existing?.memoryUsedMb ?? 0,
      containers: existing?.containers ?? 0,
      // A new registration has not been polled yet: lastSeenAt stays at registration time and
      // placement's freshness window decides when it is eligible.
      lastSeenAt: existing?.lastSeenAt ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await recordAudit({
      action: "node.register",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: node.id,
      targetLabel: node.address,
      ip: request.ip,
      details: { status: node.status },
    });
    return reply.code(existing ? 200 : 201).send({ node: { ...node, projects: 0, previews: 0, previewStarts: { count: 0, p95Ms: null, failures: 0 }, freeMemoryMb: Math.max(0, node.memoryTotalMb - node.memoryUsedMb), fresh: isNodeFresh(node) } });
  });

  app.get("/api/admin/nodes/switchover", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return { operation: switchoverStatus(await readSwitchover()) };
  });

  /**
   * Planned handoff from the current primary to another node. This endpoint only
   * writes a request: the HA controller performs replication catch-up, stops the
   * old PostgreSQL, promotes the target and keeps the old node as API/runner.
   * It never calls MWS fencing and never promotes directly from HTTP.
   */
  app.post("/api/admin/nodes/:id/switchover", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = switchoverSchema.parse(request.body);
    const target = await getNode(params.id);
    if (!target) return reply.code(404).send({ error: "Узел не найден" });
    if (target.id === nodeId()) {
      return reply.code(409).send({ error: "Целевой узел совпадает с узлом, обслуживающим API", code: "TARGET_IS_LOCAL" });
    }
    if (target.status !== "online" || !isNodeFresh(target)) {
      return reply.code(409).send({
        error: "Целевой узел должен быть online и fresh: " + target.id,
        code: "TARGET_NOT_READY",
      });
    }
    let operation;
    try {
      operation = await requestSwitchover({
        target: target.id,
        requestedBy: auth.admin.email,
        ...(body.reason ? { reason: body.reason } : {}),
      });
    } catch (error) {
      const message = errorText(error);
      return reply.code(409).send({ error: message, code: "SWITCHOVER_BUSY" });
    }
    await recordAudit({
      action: "node.switchover",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: target.id,
      targetLabel: target.id,
      ip: request.ip,
      details: { operationId: operation.id, target: target.id },
    });
    return reply.code(202).send({ operation: switchoverStatus(operation) });
  });

  app.get("/api/admin/nodes/:id/power", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().trim().min(1).max(120) }).parse(request.params);
    const node = await getNode(params.id);
    if (!node) return reply.code(404).send({ error: "Узел не найден" });
    try {
      return { node: node.id, ...(await readNodePower(node.id)) };
    } catch (error) {
      return reply.code(502).send({ error: errorText(error) });
    }
  });

  /**
   * Power-on only. Turning a VM off is deliberately not exposed here: the
   * current primary must be handed over first, otherwise the operator can kill
   * the only healthy API with one request.
   */
  app.post("/api/admin/nodes/:id/power", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = powerSchema.parse(request.body);
    const node = await getNode(params.id);
    if (!node) return reply.code(404).send({ error: "Узел не найден" });
    try {
      const state = await powerOnNode(node.id);
      await recordAudit({
        action: "node.power",
        actorType: "admin",
        actorId: auth.admin.id,
        actorLabel: auth.admin.email,
        target: node.id,
        targetLabel: node.id,
        ip: request.ip,
        details: { action: body.action, power: state.power },
      });
      return { node: node.id, power: state.power };
    } catch (error) {
      return reply.code(502).send({ error: errorText(error) });
    }
  });

  app.post("/api/admin/nodes/:id/status", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = statusSchema.parse(request.body);
    const node = await setNodeStatus(params.id, body.status as SandboxNodeStatus);
    if (!node) return reply.code(404).send({ error: "Узел не найден" });
    if (node.status === "offline") unregisterSandboxHost(node.id);

    await recordAudit({
      action: "node.status",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: node.id,
      targetLabel: node.id,
      ip: request.ip,
      details: { status: node.status },
    });

    const nodes = await nodesWithProjects();
    const online = nodes.filter(item => item.status === "online" && item.fresh).length;
    return {
      node: nodes.find(item => item.id === node.id) ?? { ...node, projects: 0, freeMemoryMb: 0 },
      warning: online === 0
        ? "Ни одного онлайн-узла не осталось: новые проекты не будут размещены, пока узел не вернут в online."
        : undefined,
    };
  });

  /**
   * Move a project's pin to another node. This is the API for the external operator panel: the
   * panel ships separately, so no UI is coupled to it here. Files do not move — every node sees
   * one shared workspace, so the pin is the whole change. A live preview or a running job blocks
   * the move: those containers belong to the old node and would be orphaned silently.
   */
  app.post("/api/admin/projects/:id/node", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = moveSchema.parse(request.body);
    const project = await getProject(params.id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });
    const target = await getNode(body.node);
    if (!target) return reply.code(404).send({ error: "Узел не найден" });
    if (target.status !== "online") {
      return reply.code(409).send({
        error: "Узел " + target.id + " в статусе " + target.status + ": перенос возможен только на online",
        code: "NODE_NOT_ONLINE",
      });
    }
    if (!isNodeFresh(target)) {
      return reply.code(409).send({
        error: "Узел " + target.id + " не отвечает: последний heartbeat " + target.lastSeenAt,
        code: "NODE_STALE",
      });
    }
    const current = project.node || nodeId();
    const freeMemoryMb = Math.max(0, target.memoryTotalMb - target.memoryUsedMb);
    if (current === target.id) {
      return {
        moved: false,
        project: { id: project.id, name: project.name, node: current },
        node: { id: target.id, freeMemoryMb },
      };
    }
    if (await hydratePreview(project.id) || listSandboxJobs(project.id).length) {
      return reply.code(409).send({
        error: "У проекта есть активный предпросмотр или задание: остановите их и повторите — перенос не трогает живые контейнеры",
        code: "PROJECT_BUSY",
      });
    }
    const moved = await reassignProjectNode(project.id, project.userId, target.id);
    if (!moved) return reply.code(409).send({ error: "Проект изменился во время переноса, повторите" });
    await recordAudit({
      action: "project.node",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: project.id,
      targetLabel: project.name,
      ip: request.ip,
      details: { from: current, to: target.id },
    });
    return {
      moved: true,
      project: { id: moved.id, name: moved.name, node: moved.node },
      node: { id: target.id, freeMemoryMb },
      warning: freeMemoryMb < sandboxMemoryMb()
        ? "На целевом узле меньше " + sandboxMemoryMb() + " МБ свободной памяти: проект может не запуститься."
        : undefined,
    };
  });
}
