// Checkpoint 5 — outage reporting. The two most valuable cases here are NEGATIVES: the design's whole
// risk is announcing an outage that did not happen, on a day the briefing arrived fine.
import { describe, expect, test } from "bun:test";
import { outageReport, calendarDaysBetween } from "../src/account";
import { renderBriefing } from "../src/render";
import type { BriefingStruct } from "../src/types";

const at = (ymd: string, h = 7) => new Date(`${ymd}T0${h}:20:00-07:00`);
const cause = (label: string, ymd: string) => ({ label, at: at(ymd).toISOString() });

describe("outageReport — missed briefings, not elapsed days", () => {
  // `last-run` is ALWAYS yesterday in normal operation, so a gap of 1 is the healthy case. An earlier
  // draft gated on "gap >= 1 calendar day" and would have announced an outage on every successful
  // failover — including the very first one, delivered ten minutes late.
  test("the NORMAL failover day reports nothing", () => {
    expect(outageReport("2026-08-23", cause("primary", "2026-08-24"), at("2026-08-24"))).toBeUndefined();
  });

  test("a real three-day outage reports the briefings missed, not the elapsed days", () => {
    const r = outageReport("2026-08-22", cause("primary", "2026-08-23"), at("2026-08-26"));
    expect(r).toEqual({ missedDays: 3, label: "primary" });   // 22→26 is a gap of 4; 3 briefings missed
  });

  // The cause is the TRIGGER. Without this, the natural "gap ⇒ outage" implementation announces a
  // usage-limit outage every Monday after a closed-laptop weekend.
  test("a gap with NO limit record reports nothing", () => {
    expect(outageReport("2026-08-21", undefined, at("2026-08-24"))).toBeUndefined();
  });

  // A non-limit gap immediately PRECEDING a limit must not be billed to the limit: laptop closed
  // Fri–Sun, Monday's tick hits the wall, the fallback delivers minutes later — zero briefings lost.
  test("a weekend gap followed by a same-day limit+recovery reports nothing", () => {
    expect(outageReport("2026-08-21", cause("primary", "2026-08-24"), at("2026-08-24"))).toBeUndefined();
  });

  test("…and when that limit really does cost days, only the limit's share is counted", () => {
    const r = outageReport("2026-08-21", cause("primary", "2026-08-24"), at("2026-08-27"));
    expect(r?.missedDays).toBe(3);            // from 08-23 (day before the limit), not from 08-21
  });

  test("a corrupt or missing cause/last-run degrades to no line, never a wrong one", () => {
    expect(outageReport(undefined, cause("primary", "2026-08-23"), at("2026-08-26"))).toBeUndefined();
    expect(outageReport("2026-08-22", { label: "primary", at: "not a date" }, at("2026-08-26"))).toBeUndefined();
  });

  test("names the account that caused it", () => {
    expect(outageReport("2026-08-20", cause("fallback", "2026-08-21"), at("2026-08-24"))?.label).toBe("fallback");
  });
});

describe("calendarDaysBetween — local calendar, not elapsed/86400e3", () => {
  test("counts calendar days", () => {
    expect(calendarDaysBetween("2026-08-22", "2026-08-26")).toBe(4);
    expect(calendarDaysBetween("2026-08-26", "2026-08-26")).toBe(0);
  });

  // On an ordinary gap the two formulas agree, so only a DST-crossing fixture can tell a compliant
  // implementation from one dividing elapsed milliseconds by 86400e3 (which yields 2.958… here).
  test("a DST-crossing span still counts whole calendar days", () => {
    expect(calendarDaysBetween("2026-10-31", "2026-11-03")).toBe(3);   // PDT→PST on Nov 1
    expect(calendarDaysBetween("2027-03-13", "2027-03-16")).toBe(3);   // PST→PDT on Mar 14
  });
});

describe("render — the line OPENS the briefing", () => {
  const struct = (outage?: BriefingStruct["outage"]): BriefingStruct => ({
    date: "2026-08-26", machineScope: "test", provider: "claude",
    resume: [{ repo: "r", text: "resumed" }], recap: [], suggestions: [],
    warnings: ["an unrelated warning"], ...(outage ? { outage } : {}),
  } as BriefingStruct);

  test("it renders directly under the header, not in the trailing warnings", () => {
    const lines = renderBriefing(struct({ missedDays: 3, label: "primary" })).split("\n");
    const header = lines.findIndex((l) => l.includes("Daily briefing"));
    const outage = lines.findIndex((l) => l.includes("No briefing for 3 days"));
    const warn = lines.findIndex((l) => l.includes("an unrelated warning"));
    expect(outage).toBe(header + 2);          // header, blank, outage
    expect(outage).toBeLessThan(warn);        // and NOT semicolon-joined at the foot
    expect(lines[warn]).not.toContain("No briefing for");
  });

  test("singular day reads correctly", () => {
    expect(renderBriefing(struct({ missedDays: 1, label: "primary" }))).toContain("No briefing for 1 day —");
  });

  test("no outage ⇒ no line at all", () => {
    expect(renderBriefing(struct())).not.toContain("No briefing for");
  });
});
