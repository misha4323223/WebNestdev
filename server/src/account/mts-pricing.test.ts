import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMtsMonthly,
  parseMtsPriceList,
  parseMtsVmResources,
  readMtsPricing,
  resetMtsPricingCache,
} from "./mts-pricing.js";

const html = `
<table>
  <tr><td>Виртуальный процессор (vCPU) категории base в регионе ru-central1</td><td>шт.</td><td>1,1408</td><td>821,376</td></tr>
  <tr><td>Оперативная память (RAM) категории base в регионе ru-central1</td><td>ГБ</td><td>0,3204</td><td>230,688</td></tr>
  <tr><td>Объем сетевого диска (NBS-PL2) в регионе ru-central1</td><td>ГБ</td><td>0,0124</td><td>8,9280</td></tr>
  <tr><td>Производительность сетевого диска (100 IOPS, NBS-PL2) в регионе ru-central1</td><td>шт.</td><td>0,0339</td><td>24,4080</td></tr>
  <tr><td>Активный внешний IP-адрес в регионе ru-central1</td><td>шт.</td><td>0,2117</td><td>152,49</td></tr>
</table>`;

const vms = {
  items: [
    {
      metadata: { id: "compute/projects/p/virtualMachines/one", displayName: "one" },
      spec: {
        zone: "ru-central1-b",
        vmType: "compute/vmTypes/base-2-4",
        hardware: { power: "ON" },
        storage: { disks: [{ disk: { spec: { size: "50GB", diskType: "nbs-pl2", iops: 2200 } } }] },
      },
      status: {
        network: {
          networkInterfaces: [{
            addresses: [{ oneToOneNat: { external: { ipAddress: "203.0.113.1" } } }],
          }],
        },
      },
    },
    {
      metadata: { id: "compute/projects/p/virtualMachines/two", displayName: "two" },
      spec: {
        zone: "ru-central1-b",
        vmType: "compute/vmTypes/base-2-4",
        hardware: { power: "OFF" },
        storage: { disks: [{ disk: { spec: { size: "20GB", diskType: "nbs-pl2", iops: 1000 } } }] },
      },
      status: { network: { networkInterfaces: [{ addresses: [{}] }] } },
    },
  ],
};

test("прайс-лист МВС разбирает помесячные ставки и не берёт строки без месяца", () => {
  const rates = parseMtsPriceList(html);
  assert.equal(rates.length, 5);
  assert.equal(rates[0].monthly, 821.376);
  assert.equal(rates[4].monthly, 152.49);
  assert.equal(parseMtsPriceList("<tr><td>Трафик</td><td>ГБ</td><td>1,525</td></tr>").length, 0);
});

test("ВМ разбираются из Compute API, включая выключенную вторую ноду", () => {
  const resources = parseMtsVmResources(vms);
  assert.equal(resources.length, 2);
  assert.deepEqual(
    resources.map(resource => ({ name: resource.name, power: resource.power, ip: resource.externalIps })),
    [{ name: "one", power: "ON", ip: 1 }, { name: "two", power: "OFF", ip: 0 }],
  );
  assert.equal(resources[0].disks[0].gb, 50);
  assert.equal(resources[0].region, "ru-central1");
});

test("месячная инфраструктура считается по vCPU, RAM, дискам и активным IP", () => {
  const calculation = calculateMtsMonthly(parseMtsVmResources(vms), parseMtsPriceList(html));
  assert.ok(Math.abs(calculation.compute - (2 * 821.376 + 4 * 230.688) * 2) < 1e-9);
  assert.ok(Math.abs(calculation.disks - ((50 + 20) * 8.928 + 12 * 24.408)) < 1e-9);
  assert.equal(calculation.network, 152.49);
  assert.ok(Math.abs(calculation.monthly - (calculation.compute + calculation.disks + calculation.network)) < 1e-9);
  assert.ok(calculation.warnings.some(text => text.includes("Выключенных ВМ: 1")));
});

test("источник МТС собирает прайс-лист и ресурсы, а при сбое откатывается на ручную сумму", async () => {
  resetMtsPricingCache();
  const fetchImpl = (async () => new Response(html, { status: 200 })) as typeof fetch;
  const request = (async () => ({
    ok: true,
    status: 200,
    host: "compute.mwsapis.ru",
    method: "GET",
    path: "/compute/v1/projects/test/virtualMachines",
    body: vms,
  })) as unknown as typeof import("../mws/mws-auth.js").mwsRequest;

  const snapshot = await readMtsPricing({
    fetch: fetchImpl,
    request,
    project: "test",
    now: () => 1_000_000,
    env: {},
  });
  assert.equal(snapshot.source, "mts-price-list");
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.resources.length, 2);
  assert.ok(snapshot.monthly > 6200 && snapshot.monthly < 6210);
  assert.equal(snapshot.currency, "RUB");

  resetMtsPricingCache();
  const fallback = await readMtsPricing({
    fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch,
    project: "test",
    now: () => 2_000_000,
    env: { PLATFORM_INFRA_COST_PER_MONTH: "1000" },
  });
  assert.equal(fallback.source, "manual");
  assert.equal(fallback.monthly, 1000);
  assert.ok(fallback.warnings.some(text => text.includes("вручную")));
});
