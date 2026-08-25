// src/eventId.ts
import type { Activity } from "./types";

function shortHash(s: string): string {
  return Bun.hash(s).toString(16);
}

export function eventIdFor(a: Omit<Activity, "event_id">): string {
  switch (a.kind) {
    case "commit": return shortHash(JSON.stringify(a)); // NB: listCommits sets event_id=sha directly; this is only a collision-safe fallback
    case "uncommitted": return `${a.repo}:uncommitted:${shortHash(a.text ?? "")}`;
    case "branch": return `${a.repo}:branch:${a.target ?? ""}:${(a.meta as { tip?: string } | undefined)?.tip ?? ""}`;
    case "stash": return `${a.repo}:stash:${a.target ?? ""}:${(a.meta as { sha?: string } | undefined)?.sha ?? ""}`;
    default: return shortHash(JSON.stringify(a));
  }
}
