// Slice 1.5 T2.3 — the credential module. ONE module, TWO call sites (§3.3 / A10).
//
// ⚠ The shared-matcher guarantee is what keeps invariant 5 true. Both scans use these patterns, so a
// turn that PASSED the ingest scan cannot match output-side, which means redaction can never fire
// inside a why — it fires only on git-derived or diagnostic text. Split the patterns and invariant 5
// ("byte-equal on every path and sink") and the redact-in-place rule are in direct conflict with no
// stated precedence.
//
// ⚠ HONEST SCOPE. The claim is NOT "credentials get detection". It is: KNOWN-SHAPED credentials get
// detection; unknown-shaped ones fall back to the PII posture (opt-in + minimisation + own-account +
// never-persist-raw). These patterns close literal STRINGS, not classes — `mysql -p S3cretPW`
// (spaced), `cookie:session=…` (lowercase), `Set-Cookie:`, `TOKEN: 'sk-…'`, a newline between `=`
// and the value, and `{"apiKey":"sk-…"}` all still pass. Say "these literals are caught", never
// "the class is closed".
//
// Entropy scoring was DELETED, not deferred: zero measured true positives and two HIGH findings.

export type CredentialPattern = { name: string; re: RegExp };

/** Global-flagged for `replace`; every use that needs statefulness resets `lastIndex` first, and
 *  `test` is never called on these directly (see `matchesCredential`) — a global regex's `test` is
 *  stateful and would alternate true/false across calls on the same input. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // Provider-issued key shapes with a distinctive prefix.
  // ⚠ The tail must be an UNHYPHENATED run of >=20 alnum chars, with at most a few short
  // hyphenated label segments before it (real keys look like `sk-ant-api03-<long run>`).
  // A `[A-Za-z0-9_-]{16,}` tail matched initials-prefixed BRANCH NAMES — measured at C2,
  // `pk-refactor-the-whole-thing`, `ak-47-cleanup-pass-two`, `sk-scikit-learn-experiments-branch`
  // and `rk-remove-legacy-adapters-now` all hit. Ingest fails CLOSED, so each of those silently
  // dropped an entire why — deflating the one number 1.5a exists to produce, in the direction that
  // would make 1.5b conclude "not enough whys". The long unhyphenated run is what actually
  // distinguishes a key from a slug.
  { name: "provider-key", re: /\b(?:sk|pk|rk|ak)-(?:[A-Za-z0-9]{1,8}-){0,3}[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // `KEY=value` shapes: an env-var-looking name containing a credential word, assigned a non-trivial
  // value on the SAME line. The name test is what keeps `PATH=/usr/bin` out.
  { name: "env-assignment", re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"'`]{8,}/g },
  // Auth headers.
  { name: "auth-header", re: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
];

/** True when text contains a known-shaped credential. Uses a fresh non-global clone so the shared
 *  global patterns' `lastIndex` can never leak between calls — the classic stateful-regex bug, and
 *  a nasty one here because a false negative silently ships a secret. */
export function matchesCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text));
}

/** Which patterns matched — for telemetry and for tests, never for a message shown to a user
 *  (naming the pattern would advertise what was found). */
/** ⚠ TEST-ONLY today. Written for telemetry, but no counter consumes it — a hit is recorded as
 *  the `credential-hit` DropReason, which carries no pattern name (naming the pattern in a stored
 *  record would advertise what was found). Kept because the per-pattern tests assert against it. */
export function credentialHits(text: string): string[] {
  return CREDENTIAL_PATTERNS
    .filter((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text))
    .map((p) => p.name);
}

export const REDACTION = "[redacted]";

/** OUTPUT-SIDE: redact in place, NEVER abort the write. Aborting would break the git briefing, which
 *  invariant 8 forbids. */
export function redactCredentials(text: string): string {
  let out = text;
  for (const p of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(p.re.source, p.re.flags), REDACTION);
  return out;
}

/** INGEST-SIDE: FAIL CLOSED — a credential hit drops the why ENTIRELY and the bullet renders bare.
 *
 *  ⚠ Under quotation (§3.5) this is not optional. The emitted text IS the user's turn, so a redacted
 *  span would ship as `you wrote: "export KEY=[redacted]"` — an artefact that advertises a secret's
 *  existence and location while adding nothing. Dropping is both safer and more useful.
 *  Returns the reason code rather than a boolean so the caller records the right DropReason. */
export function ingestScan(text: string): { ok: true } | { ok: false; reason: "credential-hit" } {
  return matchesCredential(text) ? { ok: false, reason: "credential-hit" } : { ok: true };
}
