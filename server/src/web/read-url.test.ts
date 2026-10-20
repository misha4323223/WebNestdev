import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, isPrivateAddress, readWebPage } from "./read-url.js";

test("private, loopback, link-local and metadata addresses are recognised", () => {
  for (const address of [
    "127.0.0.1",
    "127.10.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.10",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("only public http(s) addresses on ports 80 and 443 are accepted", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /только http и https/);
  await assert.rejects(() => assertPublicUrl("http://localhost/"), /Внутренние адреса/);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /Частный адрес/);
  await assert.rejects(() => assertPublicUrl("http://192.168.1.1/"), /Частный адрес/);
  await assert.rejects(() => assertPublicUrl("http://example.com:8080/"), /порты 80 и 443/);
  await assert.rejects(() => assertPublicUrl("https://user:secret@example.com/"), /логин и пароль/);
  await assert.rejects(() => assertPublicUrl("не адрес"), /Это не адрес/);
  const allowed = await assertPublicUrl("http://93.184.216.34/");
  assert.equal(allowed.url.href, "http://93.184.216.34/");
});

test("readWebPage refuses an internal address without opening it", async () => {
  const page = await readWebPage("http://127.0.0.1:443/");
  assert.equal(page.ok, false);
  assert.equal(page.code, "blocked_host");
  assert.equal(page.text, "");
});
