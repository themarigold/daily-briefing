#!/usr/bin/env bash
set -euo pipefail
SUPPORT="${DBA_TEST_DIR:-$HOME/Library/Application Support/daily-briefing}"
# PLIST is test-overridable too (else `bun test` would launchctl-unload + rm the REAL installed plist).
PLIST="${DBA_TEST_PLIST:-$HOME/Library/LaunchAgents/local.daily-briefing.plist}"

# proceed: unload the agent (match install.sh's verb for cross-version parity) + remove our files.
# wake-schedule.json is no longer written (the pmset-wake mechanism was replaced by the StartInterval
# agent) but is still rm'd here to clean up the artifact a pre-#81 pmset-wake install left behind.
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$SUPPORT"/daily-briefing "$SUPPORT"/wake-schedule.json "$SUPPORT"/briefing.log "$SUPPORT"/briefing-latest.md 2>/dev/null || true
# Slice 1.5 T4.7 — three artifacts uninstall never removed, so "uninstall" left the user's own
# briefing text, their audit history AND the transcript telemetry on disk indefinitely:
#   briefing.log.1        the rotated log (rotation predates this; removal was never added)
#   audit-*.md            every self-audit report ever written
#   transcript-health.json the day-record telemetry (counts and codes only, but still ours to clean)
rm -f "$SUPPORT"/briefing.log.1 "$SUPPORT"/transcript-health.json 2>/dev/null || true
rm -f "$SUPPORT"/audit-*.md 2>/dev/null || true
# The dated briefing archive (added 2026-08-14). A DIRECTORY, so `rm -f` on a glob would not clear it
# and uninstall would silently leave the user's whole briefing history on disk — the same "removal was
# never added" defect the comment above records for briefing.log.1. Bounded to the one directory this
# tool owns; never a bare recursive delete of $SUPPORT, which is test-overridable.
rm -rf "$SUPPORT"/briefings 2>/dev/null || true
rm -f "$PLIST" 2>/dev/null || true
# (test mode) remove the sentinel so the test can assert deletion
[ -n "${DBA_TEST_DIR:-}" ] && rm -f "$DBA_TEST_DIR/sentinel" 2>/dev/null || true
# A pre-StartInterval build may have left a repeating pmset wake armed that no CLI here disarms — flag
# it so the user can finish the cleanup (needs sudo; clears all repeat schedules, so we don't auto-run it).
if pmset -g sched 2>/dev/null | grep -qi "repeating power"; then
  echo "NOTE: a repeating power schedule is still set — if it's an orphaned daily-briefing wake, clear it with: sudo pmset repeat cancel" >&2
fi
echo "Uninstalled."
