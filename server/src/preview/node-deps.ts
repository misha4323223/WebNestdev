import type { SandboxHost } from "../sandbox/host.js";
import { previewAppAnswers, findAnsweringPort } from "./app-http.js";
import { listListeningPorts, listLoggedPorts } from "./app-port.js";
import { startContainerRelay } from "./app-relay.js";
import { previewAddressAnswers, type PreviewAddressDeps } from "./preview-address.js";
import { attachToServerNetworks, previewAttachNetworks, previewNetwork } from "./preview-network.js";

/**
 * Preview collaborators bound to one execution node. Every Docker call in the status/repair
 * path goes through this object: a preview pinned to a runner keeps its inspect, exec, logs,
 * internal relay and network attach on that runner, never on the API's Docker socket.
 */
export function previewDepsForHost(host: SandboxHost): PreviewAddressDeps {
  const docker = (args: string[], timeoutMs?: number) => host.docker(args, timeoutMs);
  return {
    addressAnswers: previewAddressAnswers,
    appAnswers: state => previewAppAnswers(state, docker),
    usedPorts: containerId => listListeningPorts(containerId, docker),
    loggedPorts: containerId => listLoggedPorts(containerId, docker),
    startRelay: input => startContainerRelay({ ...input, docker }),
    attachToServerNetworks: async containerId => {
      const networks = host.networks
        ? await host.networks()
        : { preview: await previewNetwork(docker), attach: await previewAttachNetworks(docker) };
      if (!networks.attach.length) return { host: "", connected: [] };
      return attachToServerNetworks(containerId, { networks: async () => networks.attach, docker });
    },
    probePorts: (containerId, ports) => findAnsweringPort({ containerId, ports }, { docker }),
    ...(host.previewRelay
      ? { openRelay: input => host.previewRelay!(input.containerId, input.targetPort) }
      : {}),
  };
}
