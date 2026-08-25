// Tick heartbeat (day-34 finding, 2026-08-19, user-directed): every scheduled invocation must leave
// a trace BEFORE any gate, so "launchd never fired" and "a tick fired and returned at a gate" stop
// being indistinguishable — the ambiguity that left day 34's 110-minute first-wake gap undiagnosable.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampTick, tickPath } from "../src/marker";

let dir = "";
const prev = process.env.DAILY_BRIEFING_STATE_DIR;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "dba-tick-")); process.env.DAILY_BRIEFING_STATE_DIR = dir; });
afterEach(async () => {
  if (prev === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe("stampTick", () => {
  test("first tick of a day writes today=1", async () => {
    expect(await stampTick("2026-08-20T07:24:11.000Z", "2026-08-20")).toBe(1);
    expect((await Bun.file(tickPath()).text()).trim()).toBe("2026-08-20T07:24:11.000Z local=2026-08-20 today=1");
  });

  test("⚠ the COUNT is the load-bearing half — it accumulates across ticks in one day", async () => {
    // This is what answers "did ticks fire DURING the gap": a briefing landing at 09:10 alongside
    // today=11 proves the gate is the defect; today=1 proves launchd was not firing.
    for (let i = 0; i < 11; i++) await stampTick(`2026-08-20T0${i < 10 ? i : 9}:00:00.000Z`, "2026-08-20");
    expect((await Bun.file(tickPath()).text()).trim()).toMatch(/ today=11$/);
  });

  test("a new local date RESETS the count rather than accumulating forever", async () => {
    // ⚠ Note what this case does NOT cover: every stamp's UTC date already equals its local date, so
    // it passed under the day-35 defect too. The UTC-vs-local block below is what discriminates.
    await stampTick("2026-08-20T23:50:00.000Z", "2026-08-20");
    await stampTick("2026-08-20T23:55:00.000Z", "2026-08-20");
    expect(await stampTick("2026-08-21T00:05:00.000Z", "2026-08-21")).toBe(1);
  });

  test("an unparseable existing line starts over instead of throwing", async () => {
    await Bun.write(tickPath(), "garbage written by something else\n");
    expect(await stampTick("2026-08-20T07:00:00.000Z", "2026-08-20")).toBe(1);
  });

  test("never fatal: an unwritable state dir returns 0 rather than throwing", async () => {
    process.env.DAILY_BRIEFING_STATE_DIR = "/proc/nonexistent-dba-path";
    expect(await stampTick("2026-08-20T07:00:00.000Z", "2026-08-20")).toBe(0);
  });

  // ── ⚠ REGRESSION, day 35 (2026-08-20) ────────────────────────────────────────────────────────────
  // `main.ts` pairs a UTC `nowIso` with a LOCAL `todayLocal`, and the original keyed the day off
  // `nowIso.slice(0, 10)` — the UTC date. West of Greenwich those two disagree for the last N hours of
  // every local day, so from 17:00 local this UTC-7 machine rewrote `today=1` on every tick: the exact
  // value STATE.md watch 1 reads as "launchd never fired", displayed at the hour a "why was there no
  // briefing today?" investigation actually runs. Local midnight then brought no reset at all.
  //
  // EVERY case above pairs a `2026-08-20T…Z` stamp with `today="2026-08-20"` — arg 1's UTC date always
  // already equals arg 2, the one condition under which the broken comparison was sound — so none of
  // them can fail on this defect. These pair a NEXT-DAY UTC stamp with a SAME-DAY local date.
  // Rows are (local wall clock → the UTC instant it maps to at UTC-7), from the reproduction in EVAL.md.
  describe("UTC stamp vs LOCAL day key", () => {
    test("evening ticks INCREMENT rather than resetting once UTC rolls into the next day", async () => {
      expect(await stampTick("2026-08-20T23:50:00.000Z", "2026-08-20")).toBe(1); // 16:50 local
      expect(await stampTick("2026-08-21T00:10:00.000Z", "2026-08-20")).toBe(2); // 17:10 — UTC rolls over
      expect(await stampTick("2026-08-21T03:00:00.000Z", "2026-08-20")).toBe(3); // 20:00 — was 1 (pinned)
      expect(await stampTick("2026-08-21T06:50:00.000Z", "2026-08-20")).toBe(4); // 23:50 — was 1 (pinned)
      // The count, not just the timestamp, is what watch 1 reads — and it must track ticks, not UTC.
      expect((await Bun.file(tickPath()).text()).trim())
        .toBe("2026-08-21T06:50:00.000Z local=2026-08-20 today=4");
    });

    test("the counter DOES reset at LOCAL midnight — the boundary is not 17:00 local", async () => {
      await stampTick("2026-08-21T03:00:00.000Z", "2026-08-20"); // 20:00 local Aug-20
      await stampTick("2026-08-21T06:50:00.000Z", "2026-08-20"); // 23:50 local Aug-20
      // 00:10 local Aug-21 — same UTC DAY as the two above, but a new LOCAL day. Was 2 (no reset).
      expect(await stampTick("2026-08-21T07:10:00.000Z", "2026-08-21")).toBe(1);
    });

    test("the morning count is not off by one — it equals the ticks fired this local day", async () => {
      for (const iso of ["2026-08-21T03:00:00.000Z", "2026-08-21T06:50:00.000Z"]) {
        await stampTick(iso, "2026-08-20"); // yesterday evening, past the UTC rollover
      }
      expect(await stampTick("2026-08-21T07:10:00.000Z", "2026-08-21")).toBe(1);  // 00:10 local
      expect(await stampTick("2026-08-21T14:50:00.000Z", "2026-08-21")).toBe(2);  // 07:50 local — was 3
    });

    test("east of Greenwich too: a local day AHEAD of the UTC date keys off local", async () => {
      // UTC+13. The local date now runs ahead of the UTC one, so a fix that merely swapped the
      // comparison to UTC would fail here instead of in the evening. Symmetric by construction.
      expect(await stampTick("2026-08-20T11:10:00.000Z", "2026-08-21")).toBe(1); // 00:10 local Aug-21
      expect(await stampTick("2026-08-20T20:00:00.000Z", "2026-08-21")).toBe(2); // 09:00 local Aug-21
      expect(await stampTick("2026-08-21T11:10:00.000Z", "2026-08-22")).toBe(1); // 00:10 local Aug-22
    });

    test("a pre-fix `<iso> today=<n>` line starts over at 1 instead of throwing", async () => {
      // The format gained `local=`; a line written before it has no day key that can be trusted
      // (its timestamp is UTC), so it takes the same reset-on-unparseable path. Cost: one tick.
      await Bun.write(tickPath(), "2026-08-21T04:21:09.289Z today=7\n");
      expect(await stampTick("2026-08-21T05:00:00.000Z", "2026-08-20")).toBe(1);
      expect((await Bun.file(tickPath()).text()).trim())
        .toBe("2026-08-21T05:00:00.000Z local=2026-08-20 today=1");
    });
  });

  test("the heartbeat is NOT the briefing log — a diagnostic must not reach the judge", async () => {
    // lastBriefing (audit.ts) returns everything from the last header to EOF, so per-tick lines in
    // briefing.log would be handed to the judge as part of the briefing. Separate file, by design.
    expect(tickPath().endsWith("last-tick")).toBe(true);
    expect(tickPath()).not.toContain("briefing.log");
  });
});
