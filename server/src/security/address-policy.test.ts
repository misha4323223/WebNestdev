import test from "node:test";
import assert from "node:assert/strict";
import { isIpLiteral, isPrivateAddress, isPublicAddress } from "./address-policy.js";

test("private, loopback и metadata IPv4 запрещены", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.1",
    "192.0.2.10",
    "192.168.1.10",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("обычные публичные IPv4 остаются разрешены", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "185.199.108.133", "203.0.114.1"]) {
    assert.equal(isPrivateAddress(address), false, address);
    assert.equal(isPublicAddress(address), true, address);
  }
  // Публичный IPv4-mapped IPv6 — не приватный: разбор точечного хвоста не должен превращать
  // любой mapped-адрес в безусловный запрет.
  assert.equal(isPrivateAddress("::ffff:93.184.216.34"), false);
  assert.equal(isPublicAddress("::ffff:93.184.216.34"), true);
});

test("IPv6 special-use и IPv4-mapped проверяются, а не обходятся", () => {
  for (const address of [
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::ffff:0:127.0.0.1",
    "::ffff:0:10.0.0.1",
    "::192.168.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "100::1",
    "64:ff9b::1",
    "64:ff9b:1::1",
    "2002:7f00:1::1",
    "2001:0:4136:e378::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("имя не считается IP-литералом: его обязан разрешить вызывающий", () => {
  assert.equal(isIpLiteral("example.com"), false);
  assert.equal(isPrivateAddress("example.com"), false);
  assert.equal(isPublicAddress("example.com"), false);
});
