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
import { recordAudit } from "../security/audit-journal.js";
import { unregisterSandboxHost } from "../sandbox/host.js";
import { listPreviews } from "../preview/preview-store.js";
import { previewStartStats } from "../preview/preview-metrics.js";

const statusSchema = z.object({
  status: z.enum(["online", "draining", "offline"]),
  confirm: z.literal(true),
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

async function nodesWithProjects() {
  const [nodes, projectsByNode] = await Promise.all([listNodes(), countProjectsByNode()]);
  const previewsByNode = new Map<string, number>();
  for (const preview of listPreviews()) {
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
}
