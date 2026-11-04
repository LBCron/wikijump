import assert from "node:assert/strict"
import test from "node:test"

import { isTrustedProxyPeer, resolveClientIp } from "../src/lib/server/client-ip.ts"

const requestWith = (forwardedFor) =>
  new Request("https://wikijump.localhost/-/login", {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {}
  })

test("loopback and private peers resolve the first forwarded client", () => {
  for (const peer of ["127.0.0.1", "10.3.4.5", "172.20.0.2", "192.168.1.9", "::1"]) {
    assert.equal(
      resolveClientIp(requestWith("203.0.113.7, 10.0.0.1"), peer),
      "203.0.113.7"
    )
  }
})

test("public peers ignore forged forwarded headers", () => {
  for (const peer of ["8.8.8.8", "2001:db8::1"]) {
    assert.equal(resolveClientIp(requestWith("203.0.113.7"), peer), peer)
  }
})

test("unparseable forwarded values fall back to the socket peer", () => {
  assert.equal(resolveClientIp(requestWith("not-an-ip"), "127.0.0.1"), "127.0.0.1")
  assert.equal(resolveClientIp(requestWith(""), "127.0.0.1"), "127.0.0.1")
  assert.equal(
    resolveClientIp(requestWith("garbage, 198.51.100.9"), "10.0.0.2"),
    "198.51.100.9"
  )
})

test("requests without the header keep the socket peer", () => {
  assert.equal(resolveClientIp(requestWith(null), "127.0.0.1"), "127.0.0.1")
  assert.equal(resolveClientIp(requestWith(null), "8.8.8.8"), "8.8.8.8")
})

test("only proxy transports are trusted", () => {
  for (const peer of [
    "127.0.0.1",
    "10.0.0.9",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "::1",
    "fd00::5",
    "fe80::1"
  ]) {
    assert.ok(isTrustedProxyPeer(peer), peer)
  }
  for (const peer of [
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.167.0.1",
    "2001:db8::1",
    ""
  ]) {
    assert.ok(!isTrustedProxyPeer(peer), peer)
  }
})
