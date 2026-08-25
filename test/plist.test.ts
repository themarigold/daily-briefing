import { test, expect } from "bun:test";

test("plist ProgramArguments wraps the binary in /usr/bin/caffeinate -i, in order, keeping __BIN__ run", async () => {
  const plist = await Bun.file("install/local.daily-briefing.plist").text();
  // Assert the FULL ordered argv, so a reorder (e.g. caffeinate after __BIN__) fails the test.
  expect(plist).toMatch(
    /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-i<\/string>\s*<string>__BIN__<\/string>\s*<string>run<\/string>/,
  );
});

test("plist uses StartInterval(600)+RunAtLoad, not StartCalendarInterval", async () => {
  const xml = await Bun.file(`${import.meta.dir}/../install/local.daily-briefing.plist`).text();
  expect(xml).toContain("<key>StartInterval</key><integer>600</integer>");
  expect(xml).toContain("<key>RunAtLoad</key><true/>");
  expect(xml).not.toContain("StartCalendarInterval");
  // (kept from PR 1: the caffeinate -i wrap-order assertion still passes)
  expect(xml).toContain("<string>/usr/bin/caffeinate</string><string>-i</string>");
  expect(xml).toContain("<key>StandardOutPath</key>");
  expect(xml).toContain("<key>StandardErrorPath</key>");
});
