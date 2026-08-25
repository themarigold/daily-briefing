// test/render.test.ts
import { test, expect } from "bun:test";
import { renderBriefing, stripControl, stripControlLines } from "../src/render";

test("renderBriefing shows sections, provider, and machine scope", () => {
  const out = renderBriefing({
    date: "2026-07-07", machineScope: "mymac", provider: "claude",
    resume: [{ repo: "/r1", text: "resume auth" }],
    recap: [{ repo: "/r1", text: "did x", evidence: "a1b2" }],
    suggestions: [{ text: "open PR" }], warnings: ["skipped /r2"],
  });
  expect(out).toContain("resume auth");
  expect(out).toContain("did x");
  expect(out).toContain("open PR");
  expect(out).toContain("claude");
  expect(out).toContain("mymac");
  expect(out).toContain("skipped /r2");
});

test("renderBriefing shows fallback text for the empty state", () => {
  const out = renderBriefing({
    date: "2026-07-07", machineScope: "mymac", provider: "claude",
    resume: [], recap: [], suggestions: [],
  });
  expect(out).toContain("(nothing in progress)");
  expect(out).toContain("(no commits in the window)");
  expect(out).toContain("(none)");
});

test("renderBriefing shows a 'Today so far' section when today[] is present, omits it when empty", () => {
  const base = { date: "2026-07-09", machineScope: "m", provider: "claude", resume: [], recap: [], suggestions: [] };
  const withToday = renderBriefing({ ...base, today: [{ repo: "r1", text: "did x (abc1234)" }] } as any);
  expect(withToday).toContain("Today so far");
  expect(withToday).toContain("did x (abc1234)");
  expect(renderBriefing({ ...base, today: [] } as any)).not.toContain("Today so far");
});

// ---- Tier-5: terminal-escape / control-character sanitization ----
test("renderBriefing strips terminal-escape / control bytes from untrusted fields [Tier-5]", () => {
  const out = renderBriefing({
    date: "2026-07-07", machineScope: "m", provider: "claude",
    resume: [{ repo: "/r1", text: "auth\x1b]0;pwned\x07 work\x1b[31m" }],
    recap: [{ repo: "/r1\x1b[2J", text: "did\x00 x" }],
    suggestions: [{ text: "open\x1b PR" }],
  });
  // no control byte survives EXCEPT the structural newline (\x0a) join() adds
  expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(out)).toBe(false);
  expect(out.includes("\x1b")).toBe(false);
  expect(out.includes("\x07")).toBe(false);
  // the escape is neutralized but its inert remainder stays visible (flags the tampering)
  expect(out).toContain("]0;pwned");
  expect(out).toContain("[31m");
  expect(out).toContain("auth");
  expect(out).toContain("open PR"); // the stray ESC between "open" and " PR" is removed
});

test("renderBriefing prevents newline injection from a field (a filename can't forge a bullet) [Tier-5]", () => {
  const out = renderBriefing({
    date: "d", machineScope: "m", provider: "claude",
    resume: [{ repo: "/r1", text: "real work\n   • [evil] injected line" }],
    recap: [], suggestions: [],
  });
  const lines = out.split("\n");
  expect(lines.some((l) => l.trim().startsWith("• [evil]"))).toBe(false); // no forged bullet line
  const resumeLine = lines.find((l) => l.includes("real work"))!;
  expect(resumeLine).toContain("injected line"); // collapsed onto the real line, inert
});

test("stripControl keeps unicode/emoji, strips all C0/C1 control bytes incl newline/tab [Tier-5]", () => {
  expect(stripControl("café 日本語 🚀")).toBe("café 日本語 🚀"); // U+00A0+ untouched
  expect(stripControl("a\x1b[31mb\x07c\x00d")).toBe("a[31mbcd");
  expect(stripControl("keep\ttab\nnl\r x")).toBe("keeptabnl x");
  // raw 8-bit C1 introducers (CSI 0x9b / OSC 0x9d) and DEL (0x7f) — the escape vector without a 7-bit ESC
  expect(stripControl("a\x9b31mb\x9dc\x7fd")).toBe("a31mbcd");
});

test("renderBriefing sanitizes an escape carried in a warning (the warnings-join line) [Tier-5]", () => {
  const out = renderBriefing({
    date: "d", machineScope: "m", provider: "claude",
    resume: [], recap: [], suggestions: [],
    warnings: ["skipped repo: /r\x1b]0;pwned\x07x", "another\x9b2J"],
  });
  expect(out.includes("\x1b")).toBe(false);
  expect(out.includes("\x07")).toBe(false);
  expect(out.includes("\x9b")).toBe(false);
  expect(out).toContain("skipped repo:"); // legit warning text preserved
});

test("stripControlLines: strips control bytes per line but KEEPS newlines (multi-line judge verdict) [Tier-B]", () => {
  const s = "Ground: PARTIAL\x1b[0m\n\nThe briefing cited abc but:\n- point\x07 one\n- point two";
  const out = stripControlLines(s);
  expect(out.split("\n").length).toBe(s.split("\n").length); // structure preserved (5 lines)
  expect(out.includes("\x1b")).toBe(false);
  expect(out.includes("\x07")).toBe(false);
  expect(out).toContain("Ground: PARTIAL[0m"); // ESC neutralized, text kept
  expect(out).toContain("- point one");        // BEL removed inline
});
