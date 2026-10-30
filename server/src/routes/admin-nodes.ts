import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { nodeId } from "../nodes/identity.js";
import {
  countProjectsByNode,
  listNodes,
  setNodeStatus,
  type SandboxNodeStatus,
} from "../nodes/node-store.js";
import { isNodeFresh } from "../nodes/placement.js";
import { recordAudit } from "../security/audit-journal.js";

const statusSchema = z.object({
  status: z.enum(["online", "draining", "offline"]),
  confirm: z.literal(true),
});

async function nodesWithProjects() {
  const [nodes, projectsByNode] = await Promise.all([listNodes(), countProjectsByNode()]);
  return nodes.map(node => ({
    ...node,
    projects: projectsByNode.get(node.id) ?? 0,
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

  app.post("/api/admin/nodes/:id/status", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = statusSchema.parse(request.body);
    const node = await setNodeStatus(params.id, body.status as SandboxNodeStatus);
    if (!node) return reply.code(404).send({ error: "Узел не найден" });

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
