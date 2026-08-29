# daily-briefing

A cross-platform CLI **morning briefing for developers who work with AI coding assistants**.
Reads local git history and produces a **resumption-focused** briefing — "here's where you left
off, resume here" — plus suggested next tasks. Bring-your-own AI (existing coding-agent CLI
first, then API keys, then local models).

> **Status: early but usable.** The core CLI (config, git extraction, budget-aware reduce, BYO provider,
> generator, render, marker) is built and tested — with scheduled macOS delivery (a launchd agent that
> generates on first wake past a morning floor), provider hardening on by default, multi-account
> failover, and a `bun run audit` self-audit that has graded the author's own briefing every morning
> since day one.

## Quickstart (prebuilt binary)

**You need:** local git repos to brief on, and an AI to generate with — an installed coding-agent CLI
(e.g. `claude`) is the zero-config default; API-key and local-model providers are configured in the
same config file.

**macOS / Linux with [Homebrew](https://brew.sh):**

```sh
brew install themarigold/tap/daily-briefing
daily-briefing init     # writes the config template — edit it, then:
daily-briefing run
```

**Or grab the binary directly** for your platform from the
[latest release](https://github.com/themarigold/daily-briefing/releases/latest)
(`darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64`, plus an **experimental, untested**
`windows-x64`), then:

```sh
# example: Apple Silicon macOS — substitute your platform's asset name throughout
curl -fsSLO https://github.com/themarigold/daily-briefing/releases/latest/download/daily-briefing-darwin-arm64
curl -fsSLO https://github.com/themarigold/daily-briefing/releases/latest/download/SHA256SUMS
shasum -a 256 -c <(grep darwin-arm64 SHA256SUMS)     # verify before running
chmod +x daily-briefing-darwin-arm64
./daily-briefing-darwin-arm64 init                    # writes the config template — edit it, then:
./daily-briefing-darwin-arm64 run
```

Notes:
- **macOS quarantine:** a binary downloaded through a *browser* is quarantined and Gatekeeper will
  refuse it (the binaries are not notarized) — clear it with
  `xattr -d com.apple.quarantine daily-briefing-darwin-arm64`. A `curl` download has no quarantine
  attribute, so the commands above run as-is.
- **Scheduled morning delivery** (generate automatically on your first wake of the day) is currently
  a **source-checkout install on macOS only** — see **Install the morning agent** below; it needs a
  clone and [Bun](https://bun.sh). The prebuilt binary is the manual path: run it whenever you want a
  briefing, or schedule it yourself with cron/systemd (`run` is a cheap no-op after the day's
  briefing is delivered, so an aggressive schedule is safe).
- On Linux, config lives at `~/.config/daily-briefing/` and output at
  `~/.local/state/daily-briefing/` (`XDG_CONFIG_HOME` / `XDG_STATE_HOME` respected); on macOS, output
  is under `~/Library/Application Support/daily-briefing/` (the `run` output names the exact file).

## Docs
Usage lives in this README; contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md). Design notes
and decision history are maintained privately by the author — for a design question or proposal, open an
issue.

## Stack (decided)
TypeScript on **Bun** (single-binary via `bun build --compile`). No planned Rust transition.

## Usage
From a source checkout (no build needed), `daily-briefing` below means `bun run src/main.ts`:
- **Init:** `bun run src/main.ts init` — writes a config template (edit it before first real run).
  To drop a repo you don't want in the briefing (a stale or work checkout), add it to
  `excludeRepos` — by absolute path or bare basename — which filters both the explicit `repos`
  list and anything found under `discoverRoots`.
- **Run manually:** `bun run src/main.ts run`. Add `--force` to bypass the once-per-morning guard.
- **Reading the briefing:** each run writes a clean, **overwritten** copy to
  `~/Library/Application Support/daily-briefing/briefing-latest.md` — that's the file to open (always
  just the latest). The `launchd` agent's raw stdout log (`briefing.log`) *appends* every run, so
  don't read that one directly. A deterministic **"Today so far"** section lists commits you've made
  today (which the yesterday-window recap excludes), so a briefing regenerated mid-day isn't blind to
  today's work; `vault backup:`-style auto-commits are filtered out as noise (configurable via
  `excludeCommitPatterns`). To **refresh** the briefing mid-day (so "Today so far" picks up new
  commits), re-run with **`--force`** — the once-per-morning marker is already set by the morning's
  delivering run, so a plain re-run is a no-op.
- **Delivery timing (`morningTime` / `networkProbeHosts`):** the installed agent ticks every 10
  minutes (see Install below) but only *delivers* once it's past a configurable local-time floor,
  `morningTime` (24h `"HH:MM"`, default `"07:20"`) — every tick before the floor is a silent no-op,
  and the first tick at or after it (whether that's a scheduled interval fire or the wake/login
  `RunAtLoad` fire) generates and marks the day done. An invalid `morningTime` falls back to the
  default and surfaces a warning in the briefing. Before generating, a non-`--force` run (whether the
  scheduled agent or a manual `run`) also waits briefly for real network connectivity — a raw TCP probe
  against `networkProbeHosts` (default two anycast DNS hosts, `1.1.1.1:443` / `8.8.8.8:443`) — so a
  dark-wake tick doesn't burn its provider call before wifi re-associates; if still offline after the
  grace period it skips (no stamp), and the scheduled agent's next 10-minute tick retries (a manual run
  you simply re-run once you're back online). Set `networkProbeHosts: []` to **disable** this gate
  entirely — useful for a local/offline provider that needs no network at all. `--force` always bypasses
  the floor and the once-per-day marker; on the network step it still waits briefly (same bounded poll),
  but if still offline afterward it **proceeds anyway** — a forced run always calls the provider —
  whereas a non-`--force` run instead skips (no stamp; retried as just described).
- **Self-audit the briefing:** `bun run scripts/audit.ts [briefing-file] [--no-judge]` (or `bun run audit`) — adversarially evaluates
  the day's briefing so you don't have to eyeball it yourself. Two layers: **deterministic** code checks
  (every cited SHA resolves to a real commit — and, separately, whether it is still reachable from any branch, since a commit on a deleted branch still resolves but a reader following it finds nothing; how many of *today's* commits the briefing missed; repos
  with uncommitted work it never named) plus an **LLM judge** (your `claude` CLI) fed the briefing + an
  independent git ground-truth, asked to attack it from multiple angles (grounding, completeness, ranked
  improvements). Optionally add a second-tool comparison with **`--popup=<dir>`** (author-only; off by
  default). Reads today's `briefing-latest.md`
  (generates it if missing), prints a report + a ready-to-paste `EVAL.md` row, and saves a dated
  `audit-YYYY-MM-DD.md`. Costs one extra `claude` call (~25s) — pass **`--no-judge`** to run only the
  fast deterministic checks with no LLM call. Pass a **briefing-file path** to audit a saved/specific
  briefing (it anchors same-day checks to that briefing's own date). It fills the objective columns; the
  subjective (a)/(b) retention marks stay yours.

- **Install the morning agent:** `bash scripts/install.sh` — builds a compiled binary into
  `~/Library/Application Support/daily-briefing/daily-briefing`, code-signs it with a **stable
  local self-signed identity** (created on demand into your login keychain, `Daily Briefing (local)
  Signing`) so macOS Gatekeeper doesn't block the unattended scheduled run **and** the folder-access
  grant persists across rebuilds, and loads a `launchd` agent that ticks every 10 minutes
  (`StartInterval` + `RunAtLoad`) and delivers on the first tick past your `morningTime` floor
  (default 07:20 — see **Delivery timing** above). Re-run the script any time to rebuild and reload — the grant survives. (If no real
  `openssl` is available it degrades to an ad-hoc signature with a warning; hermetic/CI installs still
  succeed.)
- **Running the installed binary directly** (e.g. to re-run `init` or trigger a manual briefing
  after installing): it is **not** put on your `PATH` automatically, so either invoke it by full
  path — `"$HOME/Library/Application Support/daily-briefing/daily-briefing" init` /
  `... run --force` — or add `~/Library/Application\ Support/daily-briefing` to your `PATH` and
  use the bare `daily-briefing` command shown above.
- **Linux / Windows:** the *core CLI* (`init`, `run`) is cross-platform and runs anywhere Bun does;
  its state lives in the platform-native dir (XDG `~/.local/state` on Linux, `%LOCALAPPDATA%` on
  Windows). Only *scheduled delivery* is macOS-first — `scripts/install.sh` and the `launchd` agent
  are macOS-only. On Linux/Windows, run `daily-briefing run` yourself, or wire it to your scheduler
  (a `cron` job / a `systemd` user timer / Task Scheduler) at your `morningTime`; set
  `networkProbeHosts: []` if your provider is local/offline. A first-class cross-platform scheduler is
  a later slice (Slice 4).

## macOS: repos in protected folders (Desktop / Documents / Downloads / iCloud)

macOS gates reads of `~/Desktop`, `~/Documents`, `~/Downloads`, and iCloud Drive behind TCC
(Transparency, Consent & Control). If any of your repos live there, the **scheduled** run has
**no window to show a permission prompt** — it is denied silently, and those repos would just
appear empty. This tool guards against that:

- `daily-briefing init` runs a **preflight** that reports any repo — or `discoverRoots` folder — it
  can't read, so you can fix access before the first unattended run.
- If a repo it **tried to read** is blocked and nothing else turned up, the run does **not** mark
  the day done: it exits non-zero and prints the fix, so the next run retries once access is
  granted (it never silently "uses up" the day with an empty briefing). This covers any block —
  TCC *or* ordinary permissions — on a configured/discovered repo, even a partial one.
- A folder it was still **scanning** for repos (a `discoverRoots` entry with no explicit `repos`)
  is reported as a *warning* rather than blocking the day — otherwise a machine with no repos there
  would error every morning forever. So if your repos live under a protected folder, either grant
  access or list them explicitly under `repos` (which `init` does for you once access is granted).

**To grant access:** System Settings → Privacy & Security → **Files & Folders** (enable the
folders for the `daily-briefing` binary), or **Full Disk Access** for the broad fix. Add the
**binary itself** (`~/Library/Application Support/daily-briefing/daily-briefing`) — granting your
terminal isn't enough for the scheduled `launchd` run, whose principal is the binary. Or simply
keep your repos outside those folders.

> **Grant persists across updates.** `scripts/install.sh` signs the binary with a **stable local
> self-signed identity** (`Daily Briefing (local) Signing`, created once into your login keychain),
> giving it a fixed designated requirement. macOS keys the Full Disk Access / Files-&-Folders grant
> to that identity, so re-running `install.sh` to rebuild **keeps** the grant — you grant access once.
> (If the identity can't be created — no real `openssl` — install falls back to an ad-hoc signature,
> and macOS may re-prompt after each rebuild until you install `openssl` and re-run.) A Developer-ID
> signature (planned, Slice 7) additionally clears Gatekeeper for redistribution.

## Uninstall

Run `bash scripts/uninstall.sh` — it unloads the `launchd` agent and removes the installed
binary, the log, and the latest-briefing file.

> **Upgrading from a pre-StartInterval build?** An early build used a repeating `pmset` wake for
> delivery (since replaced by the interval agent). If you ran that, an orphaned daily wake may still be
> armed — check with `pmset -g sched` and clear it with `sudo pmset repeat cancel`. Install/uninstall
> now detect a repeating schedule and remind you (they don't auto-cancel it — that needs `sudo` and
> would clear *all* your repeat schedules).

## Privacy

**`daily-briefing` is local-first and has no telemetry — and never will.** There is no analytics, no
crash reporting, no phone-home, and no account — there is no server on the other end, because the tool
has no backend.

The programs *this tool* starts are `git` (to read your local history) and the AI CLI *you* configure —
which it normally invokes twice per run: once as `<your-cli> --help` to check which hardening flags it
supports, and once to generate the briefing. (A non-`claude` CLI skips the `--help` check, so it is
invoked once; a morning that hits transient failures retries, and the flag-rejection ladder can add
rungs, so a bad morning reaches six and at worst eight.) (`daily-briefing init` additionally runs `which`/`where` — one or two
purely local `PATH` lookups — to locate that CLI.)

**But your AI CLI is not a sealed box, and it would be wrong to imply otherwise.** Depending on how you
have configured it, *it* may start further programs that this tool never sees: your own hooks execute
shell commands, and your MCP servers — including any that ship with plugins — run as child processes. So
"the only programs it runs" is true of `daily-briefing` and not of the whole pipeline. The next section
is about narrowing that gap.

### Provider hardening (on by default)

Your briefing prompt contains **commit subjects and branch names from every repo you have cloned** — text
you did not necessarily write. If the AI CLI generating the briefing has tools, project hooks, or MCP
servers available, a hostile commit subject becomes a prompt-injection route to running code on your
machine. So when your configured CLI is `claude`, `daily-briefing` invokes it with its authority reduced:

| Injected | Effect |
| --- | --- |
| `--tools=` | disables the built-in tools |
| `--setting-sources user` | ignores **project and local** settings — and therefore **project hooks** |
| `--strict-mcp-config` | ignores filesystem-configured MCP servers |
| `--no-session-persistence` | does not write a session transcript for the run |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` | keeps the briefing prompt out of your CLI's prompt history |

It also runs the CLI in a **private working directory** (`<state dir>/provider-cwd`, mode `0700`) rather
than whatever directory the scheduled job happened to be in.

**This is a real change if you rely on MCP servers (at ANY scope) or project hooks with `claude`** —
during a briefing run they will not be available. It affects only the briefing's own invocation; your interactive
`claude` sessions are untouched.

Three things it deliberately does **not** do. It only injects flags your CLI actually lists in `--help`,
so an older version degrades to today's behaviour rather than dying on an unknown flag. It leaves your
**user-scoped settings, skills and plugins** alone (though a plugin's own MCP server is still dropped —
see the correction below) — which is why `--safe-mode`, which would disable all
of those too, was evaluated and rejected. And it never narrows the working directory unless the
settings-isolation flag actually went in, because a directory under `$HOME` is only an improvement when
project settings are already suppressed.

**One correction worth being blunt about:** `--strict-mcp-config` is scope-**blind**. Its own help says it
ignores "all other MCP configurations", so it drops your **user-level** MCP servers too, not only
project-level ones (measured: 2 servers → 0). If you depend on an MCP server during a briefing run, this
affects you regardless of which scope you configured it in — use `"harden": false`.

Some limits worth knowing: `~/CLAUDE.md` is still read (`--setting-sources` governs settings, not
`CLAUDE.md` discovery), non-`claude` CLIs get no flags at all because their flag handling is unknown, and
a flag you pass yourself in `provider.argv` wins over ours — the briefing will tell you when that
happens rather than claiming hardening it does not have.

**To turn it all off**, set `"harden": false` inside `provider` in your config. It is all-or-nothing on
purpose: partially re-enabling tools would silently drop every MCP server with no way to decline. The
briefing then carries a warning listing exactly what was given up.

### Which credential gets used — subscription or API credits

The `claude` CLI can bill two ways: the **subscription** you logged into, or **API credits** via an
`ANTHROPIC_API_KEY` in its environment. When that variable is present, it wins.

By default this tool **withholds `ANTHROPIC_API_KEY` from the CLI it spawns**, so you get the
subscription you are already paying for. That default exists because the alternative fails silently
and costs money: a machine-wide key, exported once and forgotten, will quietly re-bill every morning
briefing to API credits with nothing in the output saying so.

```jsonc
"provider": {
  // ...your existing cli / argv / promptVia — all three are required...
  "credential": "subscription"   // default — withhold the key, use the logged-in subscription
  // "credential": "env-api-key" // pass ANTHROPIC_API_KEY through and bill API credits
}
```

A few things worth knowing:

- The withholding applies **whatever CLI you configure and regardless of `harden`** — opting out of
  hardening is not opting into spending.
- It removes exactly one variable *name* — in any letter-case, since environment names are
  case-insensitive on Windows — from **every** spawn of your CLI (the briefing call and the
  capability probe alike). Other credential mechanisms the CLI supports are **not** touched —
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, an `apiKeyHelper` in your user-scope `claude` settings, and
  the AWS/Bedrock/Vertex variables. If you have one of those configured it still applies. This tool
  does not currently tell you which credential a run actually used; that is a known gap, not a
  guarantee.
- **If your CLI authenticates only by API key** (no logged-in session), set
  `"credential": "env-api-key"` — otherwise the key is withheld and the CLI will fail to
  authenticate. The error you see comes from the CLI itself and will not mention this setting.
- `"env-api-key"` needs the key in the environment the tool actually runs in. The scheduled agent
  does **not** inherit your interactive shell — but it *does* inherit anything set with
  `launchctl setenv` or placed in the LaunchAgent plist's `EnvironmentVariables`, which is exactly
  how a machine-wide key reaches it.

### Multiple accounts (failover)

If your CLI is `claude` and you have more than one logged-in account (each under its own config
directory), the tool can fail over when one hits its usage limit:

```jsonc
"provider": {
  // ...cli / argv / promptVia...
  "accounts": [
    { "label": "primary" },                                   // the CLI's default login
    { "label": "backup", "configDir": "/home/you/.claude-b" } // spawned with CLAUDE_CONFIG_DIR set
  ]
}
```

Order is priority. When a run hits a usage-limit response, the account is **marked** until the
reset time the CLI itself states (or a short conservative window when it doesn't state one), and
the next tick uses the next unmarked account; marks expire on their own. With no `accounts` list,
behaviour is exactly the single-login default. If every account is walled the skip message says so — plus, once delivery
resumes, an opening line reports how many briefings the outage actually cost (calendar-aware,
never blaming a closed-laptop weekend on the limit). Which account generated a given
briefing is recorded in the run log (stderr), not in the briefing text itself.

Whether multiple accounts are within your provider's terms is between you and your provider —
the tool just spawns the CLI under the config directory you point it at.

The **one** network call the tool itself makes is a small **connectivity check** before it generates a
briefing (on any run — scheduled or manual — unless you've disabled it): a raw TCP connect to
`networkProbeHosts` (default two public DNS anycast IPs, `1.1.1.1` / `8.8.8.8`) to confirm the network
is up before it invokes your provider. **No data is sent or received** — the
socket is opened and immediately closed — and you can turn it off entirely with `networkProbeHosts: []`
in your config.

The one place your *data* leaves your machine is the **AI provider you choose**. To generate the briefing,
the tool sends a prompt built from your local git activity (commit subjects, changed filenames, branch
names) to your configured provider — e.g. the `claude` CLI, or a bring-your-own API key. That data goes to
*that* provider under *their* terms, exactly as if you'd handed it to their tool yourself. Point it at a
**local model** and nothing leaves your machine at all.

In short: the only thing that ever carries your data off the machine is the prompt you route to the AI
provider you picked — everything else (the local `git` reads, the dataless connectivity check) either
stays on your machine or sends nothing.

## License

MIT © Harshil S Jain — see [LICENSE](LICENSE).
