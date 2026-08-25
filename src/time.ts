export function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * Walk back day-by-day from local-yesterday-midnight. Stop at the first prior
 * local day that had >=1 commit (predicate true for that day's local midnight).
 * Hard-cap the look-back at capDays. Returns the window START (inclusive).
 * Window END is always localMidnight(now).
 */
export function windowStart(
  now: Date,
  hasCommitOnLocalDay: (dayStart: Date) => boolean,
  capDays: number,
): Date {
  const today = localMidnight(now);
  let candidate = today;
  for (let i = 1; i <= capDays; i++) {
    // subtract i days using local components (DST-safe: constructing local midnight)
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 0, 0, 0, 0);
    candidate = dayStart;
    if (hasCommitOnLocalDay(dayStart)) break;
  }
  return candidate;
}
