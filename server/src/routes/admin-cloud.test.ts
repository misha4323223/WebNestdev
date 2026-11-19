import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-cloud-"));

const {
  cloudSizeToBytes,
  parseCloudAddresses,
  parseCloudDisks,
  parseCloudMachines,
  registerAdminCloudRoutes,
  resetCloudOverviewCacheForTests,
} = await import("./admin-cloud.js");

const project = "project-pimashin2015";

const diskBody = {
  items: [
    {
      metadata: {
        id: "compute/projects/" + project + "/disks/node-2-mzayotc0",
        name: "node-2-mzayotc0",
        createTime: "2026-11-07T19:55:52.302555Z",
      },
      spec: { zone: "ru-central1-b", size: "20GB", diskType: "nbs-pl2" },
      status: {
        ready: { state: "OK" },
        size: "20 GB",
        iops: { base: 1000, extra: 0, total: 1000 },
        diskType: "compute/diskTypes/nbs-pl2",
        linkedVms: [{ id: "compute/projects/" + project + "/virtualMachines/node-2", name: "node-2" }],
      },
    },
  ],
};

const machineBody = {
  items: [
    {
      metadata: {
        id: "compute/projects/" + project + "/virtualMachines/node-2",
        displayName: "node-2",
        createTime: "2026-11-07T19:55:47.108639Z",
      },
      spec: {
        zone: "ru-central1-b",
        vmType: "compute/vmTypes/base-2-4",
        hardware: { power: "OFF" },
        network: {
          networkInterfaces: [
            {
              addresses: [
                {
                  address: { spec: { subnet: "networks/webnestdev-net/subnets/webnestdev-sub" } },
                  oneToOneNat: { external: { address: { spec: {} } } },
                },
              ],
            },
          ],
        },
      },
      status: {
        ready: { state: "OK" },
        hardware: { power: "ON" },
        storage: {
          disks: [
            {
              name: "boot",
              boot: true,
              ref: "projects/" + project + "/disks/node-2-mzayotc0",
              iops: 1000,
              size: "20 GB",
            },
          ],
        },
        network: {
          networkInterfaces: [
            {
              addresses: [
                {
                  ipAddress: "10.0.0.5",
                  oneToOneNat: {
                    ref: "projects/" + project + "/networks/webnestdev-net/oneToOneNats/node-2-nat",
                    external: {
                      ref: "projects/" + project + "/externalAddresses/ea-node-2",
                      ipAddress: "203.0.113.5",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  ],
};

const addressBody = {
  items: [
    {
      metadata: {
        id: "vpc/projects/" + project + "/externalAddresses/ea-webnestdev",
        name: "ea-webnestdev",
        createTime: "2026-10-17T15:03:56.807725Z",
        usages: [
          {
            usageType: "attach",
            resource: "nlb/projects/" + project + "/networks/webnestdev-net/nlbs/webnestdev-nlb-main",
          },
        ],
      },
      spec: { region: "regions/ru-central1" },
      status: { ready: { state: "OK" }, ipAddress: "178.236.27.102", active: true, region: "rm/regions/ru-central1" },
    },
  ],
};

test("размеры MWS переводятся в байты, неизвестный формат — в null", () => {
  assert.equal(cloudSizeToBytes("20GB"), 20 * 1024 ** 3);
  assert.equal(cloudSizeToBytes("50 GB"), 50 * 1024 ** 3);
  assert.equal(cloudSizeToBytes("1,5 TB"), Math.round(1.5 * 1024 ** 4));
  assert.equal(cloudSizeToBytes(""), null);
  assert.equal(cloudSizeToBytes("n/a"), null);
});

test("диски, машины и адреса разбираются из ответов MWS", () => {
  const disks = parseCloudDisks(diskBody, project);
  assert.equal(disks.length, 1);
  assert.deepEqual(
    { id: disks[0].id, type: disks[0].type, size: disks[0].sizeBytes, attached: disks[0].attachedTo },
    {
      id: "node-2-mzayotc0",
      type: "nbs-pl2",
      size: 20 * 1024 ** 3,
      attached: [{ id: "node-2", name: "node-2" }],
    },
  );

  const machines = parseCloudMachines(machineBody, project, disks);
  assert.equal(machines.length, 1);
  assert.equal(machines[0].power, "ON", "status важнее spec: машина уже включена");
  assert.equal(machines[0].vmType, "base-2-4");
  assert.equal(machines[0].vcpu, 2);
  assert.equal(machines[0].ramMb, 4096);
  assert.equal(machines[0].disks[0].type, "nbs-pl2");
  assert.equal(machines[0].disks[0].boot, true);
  assert.deepEqual(machines[0].addresses[0], {
    internalIp: "10.0.0.5",
    externalIp: "203.0.113.5",
    externalRef: "projects/" + project + "/externalAddresses/ea-node-2",
  });

  const addresses = parseCloudAddresses(addressBody, project);
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0].ipAddress, "178.236.27.102");
  assert.equal(addresses[0].active, true);
  assert.match(addresses[0].attachedTo ?? "", /nlb\/projects\/.*\/webnestdev-nlb-main$/);
});

test("маршрут облака закрыт админ-токеном", async () => {
  const Fastify = (await import("fastify")).default;
  resetCloudOverviewCacheForTests();
  const app = Fastify();
  await registerAdminCloudRoutes(app);

  const anonymous = await app.inject({ method: "GET", url: "/api/admin/cloud/overview" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");

  await app.close();
});
