import { test, expect } from "bun:test";
import { dispatch } from "../src/main";

test("dispatch: unknown subcommand → exit 2, prints usage, and does NOT invoke run()", async () => {
  const oErr = console.error, oLog = console.log; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "schedul-wake"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(2);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toContain("Usage"); // the default: branch now prints usage (would fail if printUsage() were dropped)
  } finally { console.error = oErr; console.log = oLog; }
});
test("dispatch: 'run' routes to run() and returns its code", async () => {
  let ran = false;
  const code = await dispatch(["bun", "bin", "run"], { run: (async () => { ran = true; return 7; }) as any });
  expect(ran).toBe(true);
  expect(code).toBe(7);
});
test("dispatch: 'init' routes to init() and PROPAGATES its exit code, without invoking run()", async () => {
  // init used to always yield 0; it now returns 2 when C1/B7 refuses a provider.argv that defeats
  // hardening, so dispatch must pass the code through rather than hard-coding success.
  let inited = false, ran = false;
  const code = await dispatch(["bun", "bin", "init"], {
    init: (async () => { inited = true; return 0; }) as any,
    run: (async () => { ran = true; return 9; }) as any,
  });
  expect(inited).toBe(true);
  expect(ran).toBe(false);
  expect(code).toBe(0);
});
test("dispatch: a non-zero init code reaches the caller", async () => {
  const code = await dispatch(["bun", "bin", "init"], { init: (async () => 2) as any, run: (async () => 9) as any });
  expect(code).toBe(2);
});
test("dispatch: bare invocation (no subcommand — argv[2] undefined) routes to run()", async () => {
  let ran = false;
  const code = await dispatch(["bun", "bin"], { run: (async () => { ran = true; return 0; }) as any });
  expect(ran).toBe(true);       // `first` undefined → the ternary's else → "run"
  expect(code).toBe(0);
});
test("dispatch: a leading flag (bare --force) routes to run(), not exit-2", async () => {
  let forced: boolean | undefined;
  const code = await dispatch(["bun", "bin", "--force"], { run: (async (f: boolean) => { forced = f; return 0; }) as any });
  expect(code).toBe(0);
  expect(forced).toBe(true);
});
test("dispatch: the '-f' force alias routes to run() with force=true (non-vacuous against dropping `|| argv.includes(\"-f\")`)", async () => {
  let seen: boolean | undefined;
  const code = await dispatch(["bun", "bin", "-f"], { run: (async (f: boolean) => { seen = f; return 0; }) as any });
  expect(code).toBe(0);
  expect(seen).toBe(true);
  let seenPlain: boolean | undefined;
  await dispatch(["bun", "bin", "run"], { run: (async (f: boolean) => { seenPlain = f; return 0; }) as any });
  expect(seenPlain).toBe(false); // plain `run` (no flag) is NOT force — contrast case
});

test("dispatch: --help / -h / help print usage and NEVER invoke run() (the old catch-all ran a full briefing)", async () => {
  const oLog = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "--help"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toContain("Usage");
    for (const arg of ["-h", "help"]) {
      const c = await dispatch(["bun", "bin", arg], { run: (async () => { ran = true; return 0; }) as any });
      expect(c).toBe(0);
    }
    expect(ran).toBe(false);
  } finally { console.log = oLog; }
});

test("dispatch: --version / -v print a version and do NOT invoke run()", async () => {
  const oLog = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "--version"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toMatch(/\d+\.\d+\.\d+/);
    await dispatch(["bun", "bin", "-v"], { run: (async () => { ran = true; return 0; }) as any });
    expect(ran).toBe(false);
  } finally { console.log = oLog; }
});

test("dispatch: an unknown leading flag → exit 2, prints usage, and does NOT invoke run() (a typo can't trigger a briefing)", async () => {
  const oErr = console.error, oLog = console.log; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "--frce"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(2);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toContain("unknown flag: --frce");
    expect(lines.join("\n")).toContain("Usage");
  } finally { console.error = oErr; console.log = oLog; }
});
