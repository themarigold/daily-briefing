#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/daily-briefing"
BIN="$SUPPORT/daily-briefing"
LOG="$SUPPORT/briefing.log"
PLIST="$HOME/Library/LaunchAgents/local.daily-briefing.plist"

mkdir -p "$SUPPORT"
mkdir -p "$HOME/Library/LaunchAgents"
echo "Building single binary…"
( cd "$ROOT" && bun build src/main.ts --compile --outfile "$BIN" )

# Code-sign the binary so its macOS TCC grant (Files-&-Folders / Full Disk Access, needed to read
# repos under ~/Desktop etc.) PERSISTS across rebuilds. An ad-hoc signature (codesign -s -) changes
# the binary's cdhash on every rebuild, so macOS treats each `install.sh` run as a brand-new program
# and re-prompts for folder access. A stable local self-signed identity gives a fixed designated
# requirement (identity + identifier), so the grant survives re-installs. The cert never leaves this
# machine and is created on demand; if anything about it fails we degrade to ad-hoc + a warning so
# hermetic/CI installs (no keychain) still succeed.
SIGN_ID="Daily Briefing (local) Signing"
OPENSSL=openssl
[ -x /usr/local/bin/openssl ] && OPENSSL=/usr/local/bin/openssl
[ -x /opt/homebrew/bin/openssl ] && OPENSSL=/opt/homebrew/bin/openssl

ensure_identity() {
  security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_ID" && return 0
  echo "Creating a one-time local code-signing identity ($SIGN_ID)…"
  local dir pw; dir="$(mktemp -d)"; pw="dba-local"; trap 'rm -rf "$dir"' RETURN
  # Self-signed leaf cert with EXACTLY the extensions macOS codesign requires: Digital Signature key
  # usage + the codeSigning EKU + CA:FALSE. Omitting keyUsage (or leaving the -x509 default CA:TRUE)
  # makes codesign reject the identity with "no identity found" even though it lists. -addext needs a
  # real OpenSSL (LibreSSL's req lacks it) — hence the homebrew preference above.
  "$OPENSSL" req -x509 -newkey rsa:2048 -keyout "$dir/key.pem" -out "$dir/cert.pem" \
    -days 3650 -nodes -subj "/CN=$SIGN_ID" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1 || return 1
  # Bundle key+cert as PKCS#12. -legacy (OpenSSL 3's modern ciphers won't import) + -macalg sha1 and a
  # NON-empty password: macOS `security import` rejects a SHA-256-MAC / empty-password p12 with a
  # bogus "MAC verification failed (wrong password?)". The password never leaves this function.
  "$OPENSSL" pkcs12 -export -legacy -macalg sha1 -inkey "$dir/key.pem" -in "$dir/cert.pem" \
    -out "$dir/id.p12" -passout "pass:$pw" >/dev/null 2>&1 \
    || "$OPENSSL" pkcs12 -export -macalg sha1 -inkey "$dir/key.pem" -in "$dir/cert.pem" \
      -out "$dir/id.p12" -passout "pass:$pw" >/dev/null 2>&1 || return 1
  # Import into the login keychain with `-A` so the install-time `codesign` below can use the key
  # non-interactively. KNOWN LIMITATION (review #15): `-A` opens the key's ACL to ANY application — a
  # needless local privilege surface (any process could use this key, inheriting the Files-&-Folders/FDA
  # grant tied to the signed binary). The tighter `-T /usr/bin/codesign` is NOT a safe drop-in here:
  # since macOS Sierra, code-signing ALSO enforces a keychain PARTITION LIST, and `-A` is what sets a
  # permissive one; `-T` alone leaves the default partition list, so `codesign` then either prompts per
  # run or fails (errSecInternalComponent) and we degrade to an ad-hoc signature — losing the persistent
  # TCC grant this whole block exists for. Setting the partition list (`security set-key-partition-list`)
  # needs the LOGIN keychain password, which this non-interactive installer can't supply. Properly
  # scoping the ACL therefore requires a DEDICATED keychain (created with a known password → import →
  # set-key-partition-list → reference it at sign time → clean up on uninstall) — a distribution-hardening
  # step deferred to Slice 7. (The p12 lives briefly in a mktemp dir with a non-empty password, removed on exit.)
  security import "$dir/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$pw" -A >/dev/null 2>&1 \
    || security import "$dir/id.p12" -P "$pw" -A >/dev/null 2>&1 || return 1
  security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_ID"
}

if ensure_identity; then
  # --identifier pins the designated requirement so the TCC grant is stable across rebuilds.
  # Guarded: a signing hiccup must not abort the install under set -e — the unsigned binary still
  # runs and the launchd load below matters more (the TCC grant just may need re-adding).
  if codesign --force --sign "$SIGN_ID" --identifier local.daily-briefing "$BIN"; then
    echo "Signed with local identity '$SIGN_ID' — the macOS folder-access grant will persist across re-installs."
  else
    echo "WARN: codesign with '$SIGN_ID' failed — falling back to an ad-hoc signature; the grant may not persist." >&2
    codesign -s - -f "$BIN" || true
  fi
else
  echo "WARN: could not create/find a stable signing identity — falling back to an ad-hoc signature." >&2
  echo "      macOS may re-prompt for folder access after each rebuild. Install a real 'openssl'" >&2
  echo "      (e.g. \`brew install openssl\`) and re-run to get a persistent grant." >&2
  codesign -s - -f "$BIN" || true
fi

# launchd agents get a minimal PATH; give the scheduled run a sane one so it (and any CLI it
# shells out to) can be found without relying on the user's interactive shell PATH.
PATHVAL="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
sed -e "s#__BIN__#$BIN#g" -e "s#__LOG__#$LOG#g" -e "s#__PATH__#$PATHVAL#g" "$ROOT/install/local.daily-briefing.plist" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed. Checks every 10 min and delivers on the first tick past your morningTime floor"
echo "(default 07:20; set \"morningTime\" in the config to change it). Test now with: launchctl start local.daily-briefing"
echo "Config: run \"$BIN\" init  (if you haven't already)."

# Migration: a pre-StartInterval build may have armed a repeating `pmset` wake (the old pmset-wake
# delivery, since replaced by this interval agent) that nothing here disarms — the RTC wake then fires
# daily forever. Detect and advise; do NOT auto-cancel (it needs sudo, and `pmset repeat cancel` clears
# ALL repeat schedules, including any the user set for other reasons).
if pmset -g sched 2>/dev/null | grep -qi "repeating power"; then
  echo "NOTE: a repeating power schedule is set. If it's an orphaned wake from a pre-StartInterval" >&2
  echo "      daily-briefing build, clear it with: sudo pmset repeat cancel" >&2
fi
