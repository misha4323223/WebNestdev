import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { listYandexResources, yandexFetch, yandexStatus } from "../yandex/yandex-api.js";

const METADATA_HOST = "operation.api.cloud.yandex.net";
const MAX_RESOURCE_ITEMS = 50;

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const requestSchema = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  host: z.string().max(120).optional(),
  path: z.string().min(1).max(1000),
  body: z.unknown().optional(),
});

const resourcesSchema = z.object({ folderId: z.string().max(120).optional() });

/**
 * Yandex Cloud is an external account, so the agent reads it through the linked
 * credential. Reads are always available once the user connected the account; every
 * call that creates, changes or deletes a resource needs the write consent switch in
 * the Yandex Cloud card, which is enforced inside yandexFetch.
 */
registerTool({
  name: "yandex.status",
  description:
    "Report the linked Yandex Cloud account for this user: whether it is connected, which credential kind it uses, " +
    "the cloud and folder the agent works in, and whether the user allowed the agent to change resources. " +
    "Call it before Yandex work when you are unsure whether the account is connected, and again if a Yandex call " +
    "reports that writes are disabled.",
  execute: async (_input, context) => {
    const status = await yandexStatus(context.userId);
    if (!status.connected) {
      return { connected: false, hint: "Yandex Cloud не подключён. Попросите пользователя подключить аккаунт в разделе «Интеграции» → «Yandex Cloud»." };
    }
    return { ...status, hint: status.allowWrites ? "Изменения разрешены." : "Разрешено только чтение: чтобы создавать, менять и удалять ресурсы, пользователь включает «Разрешить агенту изменять ресурсы»." };
  },
});

registerTool({
  name: "yandex.resources",
  description:
    "List the resources of the connected Yandex Cloud account: clouds and folders, and inside one folder the compute " +
    "instances, disks, Object Storage buckets and Serverless functions. Input: {folderId?:string}; without it the " +
    "folder saved in the connection is used. Use this to answer questions about the account and to find the ids " +
    "(folderId, subnetId, imageId) needed for further calls.",
  execute: async (input, context) => {
    const { folderId } = resourcesSchema.parse(input ?? {});
    const result = await listYandexResources(context.userId, folderId);
    return { ...result, note: result.folderId ? "Ограничено " + MAX_RESOURCE_ITEMS + " ресурсами на тип." : result.note };
  },
});

registerTool({
  name: "yandex.request",
  description:
    "Call a Yandex Cloud control-plane REST API with the linked account as the authenticated user. " +
    "Input: {method?:'GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE' (default GET), host?:string (a *.api.cloud.yandex.net host, " +
    "default resource-manager.api.cloud.yandex.net), path:string starting with '/', body?:object}. " +
    "Reads (GET/HEAD) always work on a connected account. Calls that create, change or delete resources are rejected " +
    "until the user allows changes in the Yandex Cloud integration card, and then run as that user — so confirm the " +
    "target resource before deleting anything. Examples of hosts and paths: create a bucket with POST " +
    "storage.api.cloud.yandex.net /storage/v1/buckets {name,folderId}; delete it with DELETE /storage/v1/buckets/{name}; " +
    "create a VM with POST compute.api.cloud.yandex.net /compute/v1/instances {folderId,name,zoneId,platformId," +
    "resourcesSpec,bootDiskSpec,networkInterfaceSpecs}; delete it with DELETE /compute/v1/instances/{instanceId}; " +
    "create a function with POST serverless-functions.api.cloud.yandex.net /functions/v1/functions {folderId,name}. " +
    "A mutating call usually returns an Operation: poll GET " + METADATA_HOST + " /operation/v1/operations/{operationId} " +
    "until done is true, then read its metadata or response for the created or deleted resource id.",
  execute: async (input, context) => {
    const request = requestSchema.parse(input ?? {});
    const method = request.method ?? "GET";
    const result = await yandexFetch(context.userId, { method, host: request.host, path: request.path, body: request.body });
    const operation = result.body && typeof result.body === "object" ? (result.body as { id?: string; done?: boolean }) : null;
    if (result.ok && mutationMethods.has(method) && operation?.id && operation.done !== true) {
      return { ...result, operation: { id: operation.id, poll: METADATA_HOST + "/operation/v1/operations/" + operation.id, note: "Операция ещё выполняется: опрашивайте этот путь, пока done не станет true." } };
    }
    return result;
  },
});

export { mutationMethods as yandexMutationMethods };
