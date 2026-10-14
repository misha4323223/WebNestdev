import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";

/**
 * These three take no arguments at all, and the schema says so. Leaving it open (`additionalProperties`
 * unset) invited models to send guesses like `{port:3000}`, and a rejected call costs a whole step.
 */
const NO_ARGUMENTS = { type: "object", additionalProperties: false, properties: {} };

registerTool({
  name:"preview.start",
  description:"Start the project's live preview server after creating or updating the project.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {return startPreview(await getSandbox(context.projectId,context.userId))}
});
registerTool({
  name:"preview.stop",
  description:"Stop the project's live preview server.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {await getSandbox(context.projectId,context.userId);return stopPreview(context.projectId)}
});
registerTool({
  name:"preview.status",
  description:"Check whether the project's live preview is running.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {await getSandbox(context.projectId,context.userId);return previewStatus(context.projectId)}
});
