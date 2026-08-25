// src/schedule.ts — pure morning-floor math (no I/O), so run()'s floor gate is trivially testable.
export const DEFAULT_MORNING_TIME = "07:20";
// Must match DEFAULT_MORNING_TIME above — derived from it so the two can't drift.
const DEFAULT_MORNING_MINUTES = (() => {
  const parts = DEFAULT_MORNING_TIME.split(":").map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
})();

/** Parse a 24h "HH:MM" to minutes-since-midnight. Invalid/out-of-range → the default (07:20) + a warning. */
export function parseFloor(morningTime?: string): { minutes: number; warning?: string } {
  const def = DEFAULT_MORNING_MINUTES;
  if (morningTime === undefined) return { minutes: def };
  if (typeof morningTime !== "string") {
    return { minutes: def, warning: `invalid morningTime ${JSON.stringify(morningTime)} — using the default ${DEFAULT_MORNING_TIME}` };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(morningTime.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  if (!m || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { minutes: def, warning: `invalid morningTime ${JSON.stringify(morningTime)} — using the default ${DEFAULT_MORNING_TIME}` };
  }
  return { minutes: hh * 60 + mm };
}

/** True once local wall-clock time is at or past the floor. Wall-clock (not a scheduled instant) so it is DST-safe. */
export function isPastFloor(now: Date, floorMinutes: number): boolean {
  return now.getHours() * 60 + now.getMinutes() >= floorMinutes;
}
