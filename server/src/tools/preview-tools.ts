import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";

registerTool({
  name:"preview.start",
  description:"Start the project's live preview server after creating or updating the project.",
  execute: async (_,context){return startPreview(await getSandbox(context.projectId,context.userId))}
});
registerTool({
  name:"preview.stop",
  description:"Stop the project's live preview server.",
  execute: async (_,context){await getSandbox(context.projectId,context.userId);return stopPreview(context.projectId)}
});
registerTool({
  name:"preview.status",
  description:"Check whether the project's live preview is running.",
  execute: async (_,context){await getSandbox(context.projectId,context.userId);return previewStatus(context.projectId)}
});
