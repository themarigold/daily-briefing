// src/power.ts — is the machine in a DARKWAKE right now?
//
// WHY THIS EXISTS. On 2026-08-08 the 07:20 run fired during a maintenance darkwake, burned all three
// provider attempts on timeouts, and wrote an alarming failure block that was then misdiagnosed twice
// — first as a compounding retry loop, then in the retraction's own framing. The network gate was
// built to prevent exactly this (`net.ts`: "a dark-wake run otherwise burns its provider retries in
// the ~minutes before wifi re-associates") and does not catch it: `pmset` shows `TCPKeepAlive=active`
// through clamshell sleep, so a raw TCP handshake to anycast 1.1.1.1:443 SUCCEEDS while the provider
// call cannot complete. `waitForNetwork` returns on the FIRST successful probe, in ~0s.
//
// So the readiness check must test the actual condition, not a proxy for it.
//
// ⚠ THE DISCRIMINATOR IS MEASURED, NOT INFERRED. `pmset -g log` over 410 wake events on this machine
// separates perfectly on the graphics capability — DarkWake is `[CDN]` (410 events: 392 dark, 18
// full), FullWake is `[CDNVA]`, adding V(ideo) and A(udio). And an overnight probe confirmed the LIVE
// command agrees: `pmset -g systemstate` printed `CPU Network` during real darkwakes and
// `CPU Graphics Audio Network` while awake. That live half could not be checked from an awake
// machine, which is why it was probed rather than assumed.
//
// ⚠ HONEST LIMIT: this stops WASTED WORK, it does not make the briefing arrive earlier. The same
// probe recorded ~170 of ~264 expected ticks actually firing — launchd does not wake a sleeping
// machine, so most ticks never run at all. Delivery-on-first-real-wake remains the design
// (2026-07-16), and forcing a lid-closed battery laptop awake was already falsified.
import { run } from "./proc";

/** Bounded hard: this sits in front of the morning run, so it must never be the thing that hangs it. */
export const POWER_PROBE_MS = 5_000;

/** True when the system is awake enough to do real work. Any doubt answers TRUE — a false "awake"
 *  costs one wasted run (today's status quo), a false "darkwake" would SKIP a morning the user was
 *  waiting for. The asymmetry is deliberate and the fail-open direction is the safe one. */
export async function isFullyAwake(
  platform: NodeJS.Platform = process.platform,
  exec: (args: string[]) => Promise<{ code: number; out: string }> = (args) => run(args, { timeoutMs: POWER_PROBE_MS }),
): Promise<boolean> {
  if (platform !== "darwin") return true;            // only macOS exposes this; elsewhere never gate
  try {
    const r = await exec(["pmset", "-g", "systemstate"]);
    if (r.code !== 0) return true;                    // cannot tell ⇒ proceed
    const caps = /Capabilities are:([^\n]*)/i.exec(r.out)?.[1];
    if (!caps) return true;                           // unexpected output shape ⇒ proceed
    return /\bgraphics\b/i.test(caps);
  } catch {
    return true;                                      // never let the probe itself block the morning
  }
}
