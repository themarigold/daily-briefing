import { test, expect } from "bun:test";
import { tcpProbe, resolveProbeHosts } from "../src/net";
import { DEFAULT_NETWORK_PROBE_HOSTS } from "../src/config";

test("tcpProbe: empty host list early-returns reachable (does NOT reject like Promise.any([]))", async () => {
  expect(await tcpProbe([], 500)).toBe(true);
});

test("tcpProbe: an unreachable host resolves false within ~perProbeMs (mandatory connect-timeout race)", async () => {
  const start = Date.now();
  // 203.0.113.0/24 is TEST-NET-3 (RFC 5737) — reserved, unroutable → connect blackholes.
  const ok = await tcpProbe([{ host: "203.0.113.1", port: 443 }], 400);
  expect(ok).toBe(false);
  expect(Date.now() - start).toBeLessThan(2000); // bounded by the timer, not a hung connect
});

test("tcpProbe: a reachable host resolves true", async () => {
  // A local listener so the test needs no external network.
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(s) { s.end(); } } });
  const ok = await tcpProbe([{ host: "127.0.0.1", port: server.port }], 1000);
  server.stop();
  expect(ok).toBe(true);
});

test("tcpProbe: an out-of-range port throws SYNCHRONOUSLY from Bun.connect — must not hang (regression)", async () => {
  const start = Date.now();
  const ok = await tcpProbe([{ host: "1.1.1.1", port: 99999 }], 400);
  expect(ok).toBe(false);
  expect(Date.now() - start).toBeLessThan(1000); // completes; doesn't hang forever on the sync throw
});

test("tcpProbe: an empty/malformed hostname throws SYNCHRONOUSLY from Bun.connect — must not hang", async () => {
  const start = Date.now();
  const ok = await tcpProbe([{ host: "", port: 443 }], 400);
  expect(ok).toBe(false);
  expect(Date.now() - start).toBeLessThan(1000);
});

test("tcpProbe: a malformed host mixed with a normally-unreachable host still resolves false (doesn't wedge `pending`)", async () => {
  const start = Date.now();
  const ok = await tcpProbe(
    [{ host: "203.0.113.1", port: 443 }, { host: "1.1.1.1", port: 99999 }],
    400,
  );
  expect(ok).toBe(false);
  expect(Date.now() - start).toBeLessThan(2000);
});

// ---- Fix 4: resolveProbeHosts (unvalidated hand-editable networkProbeHosts → boundary normalization) ----

test("resolveProbeHosts: undefined → defaults, no warning", () => {
  const r = resolveProbeHosts(undefined);
  expect(r.hosts).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
  expect(r.warning).toBeUndefined();
});

test("resolveProbeHosts: a non-array (forgot the array brackets) → defaults + warning", () => {
  const r = resolveProbeHosts({ host: "1.1.1.1", port: 443 });
  expect(r.hosts).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
  expect(r.warning).toMatch(/must be an array/i);
});

test("resolveProbeHosts: [] → explicit skip switch preserved, no warning", () => {
  const r = resolveProbeHosts([]);
  expect(r.hosts).toEqual([]);
  expect(r.warning).toBeUndefined();
});

test("resolveProbeHosts: array of all-invalid entries (null, string, empty host, out-of-range port, port 0) → defaults + warning", () => {
  const r = resolveProbeHosts([null, "1.1.1.1:443", { host: "", port: 1 }, { host: "h", port: 99999 }, { host: "1.1.1.1", port: 0 }]);
  expect(r.hosts).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
  expect(r.warning).toMatch(/all networkProbeHosts entries invalid/i);
});

test("resolveProbeHosts: a sole port-0 entry is invalid (port 0 can never be a TCP connect destination) → defaults + warning", () => {
  const r = resolveProbeHosts([{ host: "1.1.1.1", port: 0 }]);
  expect(r.hosts).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
  expect(r.warning).toMatch(/all networkProbeHosts entries invalid/i);
});

test("resolveProbeHosts: some valid, some invalid → keeps the valid ones + 'ignored' warning", () => {
  const r = resolveProbeHosts([{ host: "1.1.1.1", port: 443 }, null]);
  expect(r.hosts).toEqual([{ host: "1.1.1.1", port: 443 }]);
  expect(r.warning).toMatch(/invalid and ignored/i);
});

test("resolveProbeHosts: all valid → no warning", () => {
  const hosts = [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 443 }];
  const r = resolveProbeHosts(hosts);
  expect(r.hosts).toEqual(hosts);
  expect(r.warning).toBeUndefined();
});

test("tcpProbe: a non-array `hosts` (the un-normalized crash case) resolves rather than throwing/hanging", async () => {
  const start = Date.now();
  const ok = await tcpProbe(({ host: "1.1.1.1", port: 443 }) as unknown as { host: string; port: number }[], 400);
  expect(ok).toBe(true); // defensive guard folds into the empty-hosts "reachable/skip" path
  expect(Date.now() - start).toBeLessThan(1000);
});

test("tcpProbe: an array containing null (the un-normalized crash case) resolves rather than throwing/hanging", async () => {
  const start = Date.now();
  const ok = await tcpProbe([null] as unknown as { host: string; port: number }[], 400);
  expect(ok).toBe(true); // null filtered out by the guard → empty list → "reachable/skip"
  expect(Date.now() - start).toBeLessThan(1000);
});
