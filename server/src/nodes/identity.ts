/**
 * Stable identity of this execution node.
 *
 * `WEBNESTDEV_NODE_ID` is the same variable the archive marker already uses. Giving both the
 * archive and the node registry one source prevents a project from being archived on `local`
 * and then reported as coming from a random container hostname. Deployments with more than one
 * machine must set a unique value; the default is the single-node name.
 */
export function nodeId() {
  return (process.env.WEBNESTDEV_NODE_ID ?? "").trim() || "local";
}

/** Address a remote runner will listen on. Empty for the local node. */
export function nodeAddress() {
  return (process.env.WEBNESTDEV_NODE_ADDRESS ?? "").trim();
}
