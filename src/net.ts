// src/net.ts — provider-agnostic connectivity probe. A raw TCP connect is enough to prove the network
// is up (no TLS, so no cert/SNI issues for IP-literal hosts); the actual provider is what proves the
// provider is up. Bun.connect has NO connect-timeout, so each connect is RACED against a timer; the
// timer resolves the race to false — a socket that DOES connect is `.end()`'d in `open()`, and a
// still-pending (blackholed) connect is simply abandoned (harmless — the process exits per tick).
import { DEFAULT_NETWORK_PROBE_HOSTS } from "./config";

type ProbeHost = { host: string; port: number };

// Normalize the hand-editable `networkProbeHosts` config value at the boundary (spec §6: degrade
// gracefully + still deliver — never throw, never add a hard loadConfig error). A malformed value
// (wrong shape, out-of-range port, forgot the array brackets) must not crash the network gate or
// silently settle it into permanent non-delivery — fall back to the defaults and surface a warning
// instead, so the run still completes and the misconfiguration is visible in the briefing.
export function resolveProbeHosts(raw: unknown): { hosts: ProbeHost[]; warning?: string } {
  if (raw === undefined) return { hosts: DEFAULT_NETWORK_PROBE_HOSTS };
  if (!Array.isArray(raw)) {
    return { hosts: DEFAULT_NETWORK_PROBE_HOSTS, warning: "networkProbeHosts must be an array of {host,port}; using defaults" };
  }
  if (raw.length === 0) return { hosts: [] }; // explicit skip switch (§5) — preserved, no warning
  const valid = raw.filter(
    (h): h is ProbeHost =>
      !!h && typeof h === "object" && typeof (h as ProbeHost).host === "string" && (h as ProbeHost).host.length > 0 &&
      Number.isInteger((h as ProbeHost).port) && (h as ProbeHost).port >= 1 && (h as ProbeHost).port <= 65535,
  );
  if (valid.length === 0) {
    return { hosts: DEFAULT_NETWORK_PROBE_HOSTS, warning: "all networkProbeHosts entries invalid; using defaults" };
  }
  return { hosts: valid, warning: valid.length < raw.length ? "some networkProbeHosts entries were invalid and ignored" : undefined };
}

async function connectOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  let sock: { end(): void } | undefined;
  let connect: Promise<boolean>;
  try {
    connect = Bun.connect({
      hostname: host, port,
      socket: { open(s) { sock = s; s.end(); }, data() {}, error() {}, close() {} },
    }).then(() => true).catch(() => false);
  } catch {
    // A malformed host/port (e.g. "" hostname, a non-string, an out-of-range port like 99999) throws
    // SYNCHRONOUSLY from Bun.connect's constructor rather than rejecting — treat it as an unreachable
    // host so it folds into the normal false path instead of becoming an unhandled rejection.
    return false;
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); });
  const ok = await Promise.race([connect, timeout]);
  clearTimeout(timer!); // won the race already if connect settled first — don't leave a pending timer
  try { sock?.end(); } catch {} // if the connect resolved after the timeout, don't leak the socket
  return ok;
}

/** True if ANY host TCP-connects within perProbeMs; empty hosts → true (gate disabled). Never throws.
 *  Resolves as soon as the first host succeeds; resolves false only once all have failed/timed out. */
export function tcpProbe(hosts: { host: string; port: number }[], perProbeMs: number): Promise<boolean> {
  // Defensive guard (belt-and-suspenders): the real caller always passes a resolveProbeHosts()-
  // normalized array, but if called directly with garbage (non-array, or entries that aren't
  // objects), don't let `.length`/`for...of` throw — fold into the "reachable/skip" empty-hosts path.
  const list = Array.isArray(hosts) ? hosts.filter((h) => h && typeof h === "object") : [];
  if (list.length === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let pending = list.length;
    for (const h of list) {
      connectOnce(h.host, h.port, perProbeMs).then(
        (ok) => { if (ok) resolve(true); else if (--pending === 0) resolve(false); },
        // Defense in depth: connectOnce is designed to never reject (its try/catch + internal
        // .catch(() => false) cover the known throw paths), but a rejection arm here means even
        // an unforeseen future reject can't leave `pending` permanently un-decremented.
        () => { if (--pending === 0) resolve(false); },
      );
    }
  });
}

// --- Network-readiness gate — shared by run() (production shell) and runCore() (eval pipeline) ------
// ONE source of truth so the two callers can't drift (they had: a 180s sleep-counter in core vs this
// 25s wall-clock version in main). Wait for real connectivity before the provider call — a dark-wake
// run otherwise burns its provider retries in the ~minutes before wifi re-associates (audit 2026-07-10).
export const NET_DEFAULT_GRACE_MS = 25_000;
export const NET_DEFAULT_POLL_MS = 3_000;
const NET_PER_PROBE_MS = 3_000;

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Provider-agnostic raw-TCP probe against the configured anycast hosts; empty hosts (local/offline
// providers) disable the gate (tcpProbe([]) → true). Takes the already-normalized host list.
export const defaultNetProbe = (hosts: ProbeHost[]) => (): Promise<boolean> => tcpProbe(hosts, NET_PER_PROBE_MS);

/** Poll `probe` until it reports connectivity or `graceMs` of TOTAL elapsed wall-clock (probe + sleep)
 *  passes. Never throws; a timeout is reported, not fatal — the caller proceeds and the provider retry
 *  is the fallback. Bounded by BOTH wall-clock (counts probe latency) AND an iteration cap, so a test's
 *  no-op `sleep` stub can't busy-spin (elapsed barely advances, but `round` does). */
export async function waitForNetwork(
  probe: () => Promise<boolean>, sleep: (ms: number) => Promise<void>,
  graceMs = NET_DEFAULT_GRACE_MS, pollMs = NET_DEFAULT_POLL_MS,
): Promise<{ online: boolean; waitedMs: number }> {
  const start = Date.now();
  if (await probe()) return { online: true, waitedMs: Date.now() - start };
  const maxRounds = Math.ceil(graceMs / Math.max(pollMs, 1)) + 2;
  for (let round = 0; Date.now() - start < graceMs && round < maxRounds; round++) {
    await sleep(pollMs);
    if (await probe()) return { online: true, waitedMs: Date.now() - start };
  }
  return { online: false, waitedMs: Date.now() - start };
}
