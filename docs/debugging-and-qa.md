# Debugging And QA

- `pnpm dev` prints the active frontend URL, server API URL, host daemon port, data dir, and logs dir. Do not assume fixed dev ports.
- The packaged app defaults to server/frontend `:38886`, host daemon `:38887`, data dir `~/.bb/`, and logs under `~/.bb/logs/`.
- Entity IDs in URLs (`proj_*`, `thr_*`) are primary keys. Query them directly against the active data dir: `sqlite3 <data>/bb.db "SELECT * FROM threads WHERE id = 'thr_xxx';"`.
- API routes are under `/api/v1/`, for example `GET /api/v1/threads/:id`.
- Use `curl` against the server API to isolate frontend issues from server behavior.
- Use the CLI to inspect state: `pnpm bb thread show <id>`, `pnpm bb project list`, `pnpm bb status`. From source, use `pnpm bb:dev`.

## Local Dev QA Launcher

Use `scripts/bb-dev-app` when validating changes in the desktop dev app or helping QA from this checkout:

- `pnpm dev:status` runs `scripts/bb-dev-app status` to print the active branch, dev URLs, data dir, and logs.
- `scripts/bb-dev-app current` restarts the dev server on the current branch.
- `scripts/bb-dev-app main` fetches `origin/main`, fast-forwards `main`, and launches the dev server from this checkout.
- `scripts/bb-dev-app branch <branch>` switches to a local branch, or creates it from `origin/<branch>`, then launches the dev server.
- `pnpm dev:stop` runs `scripts/bb-dev-app stop` to stop the launcher-managed dev server and desktop.
- `scripts/bb-dev-app logs dev` and `scripts/bb-dev-app logs desktop` follow logs.

By default the launcher starts only the dev server (web frontend, server, host daemon) and prints the URL without opening a browser. Pass `--open` to open the browser after startup. Pass `--desktop` (e.g. `scripts/bb-dev-app current --desktop`) to also launch the Electron desktop shell — only do this when the user is testing a desktop-only change.

A bb connect shared-port URL is a different browser origin from localhost. If
QA through that URL needs the browser-local host daemon, restart the dev app
with the share origin configured after exposing its app port:

```bash
BB_APP_URL=https://<handle>--<app-port>.getbb.app scripts/bb-dev-app current
```

The port remains stable for the checkout, so the existing share continues to
work after the restart. The host daemon intentionally rejects remote origins
that are not configured; otherwise any webpage could drive its local editor
API.

Branch switches intentionally keep dirty work in this checkout; git will stop if a local file would be overwritten. Set `BB_DEV_APP_STASH_DIRTY=1` for a one-off launch that stashes first.

For CLI QA against the dev instance, run `eval "$(scripts/bb-dev-app env)"` first. This sets `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, and `BB_PROJECT_ID=proj_personal` so `pnpm bb:dev ...` does not accidentally target the packaged app.

Test agents with:

```bash
eval "$(scripts/bb-dev-app env)"
pnpm bb:dev thread spawn --project proj_personal --provider codex --permission-mode accept-edits --title "Smoke test" --prompt "Reply only with ok." --json
```

## Performance Fixture Database

Use `pnpm seed:perf` to fill a dev database with a large, realistic fixture:
many projects, ~1,200 threads, and ~400k event rows with production-like
payloads. Use it to reproduce performance problems that only appear at scale.

- Start the dev app once first (`scripts/bb-dev-app current`), then stop it and
  seed. The fixture then attaches to the real local host, so agents still run.
- By default the command seeds this checkout's dev data dir. Pass
  `--data-dir <path>` for another target. The command refuses to touch `~/.bb`.
- Scale flags: `--projects`, `--threads`, `--events`, `--seed`. `--reset`
  deletes the database file first. Without `--reset` the fixture appends.
- Example: `pnpm seed:perf -- --reset --events 400000`.

## Cold Load Measurement

Three harnesses in `apps/app/scripts`, all headless-Chromium-over-localhost
against a **production** build served by the real bb server. None produces
Electron or macOS numbers; treat them as relative before/after signals.

- `measure-hud.mjs` measures what a person waiting on a cold load waits for:
  time until the sidebar and an enabled "New thread" control are **painted**
  (primary), and time from clicking "New thread" until the composer's
  `Ask anything.` placeholder is painted (secondary). Fresh browser profile and
  disabled cache per run, 1440x900, no CPU throttle by default.

  ```bash
  cd apps/app
  node scripts/measure-hud.mjs --base http://127.0.0.1:38886 --runs 9 --label after
  ```

  Add `--profile` to attribute main-thread self time until the HUD paints,
  `--waterfall` for the script waterfall, `--hud-only` to skip the click leg,
  and `--json out.json` to keep the samples. Sampling perturbs timing, so never
  compare a profiled run's HUD number against an unprofiled one.

- `measure-warm-nav.mjs` measures the warm path, which is where a session
  actually spends its time. Each run loads `/`, waits until the shell is
  settled, then clicks: first thread open (primary), a second thread, back to
  the root composer, and settings — timing each from the in-page `mousedown`
  until the destination content is painted.

  ```bash
  cd apps/app
  node scripts/measure-warm-nav.mjs --base http://127.0.0.1:38886 --runs 6 --label after
  ```

  `--counters` splits each probe into script, style-recalc and layout time from
  Chromium's own counters, which is usually the fastest way to tell "we run too
  much JS" from "we invalidate style too often". `--profile <probe>` samples one
  probe's window, `--settle <ms>` changes how long the shell is left alone
  before clicking, and `--waterfall` shows the chunks and API calls each probe
  triggered.

- `measure-load.mjs` measures FCP/LCP plus a per-route DOM "route-ready"
  marker. Its `/` marker is the promptbox _wrapper_, which appears well after
  the HUD has painted, so it ranks post-first-paint work and is the wrong tool
  for both questions above. It is what led to making the thread pane lazy, a
  decision the warm harness later reversed.

Run-to-run spread on a shared VM is easily ±10%, which is larger than most
single changes. Decide keeps by alternating two prebuilt `dist` directories
round by round and comparing medians over 20+ samples per arm, not by comparing
one run against a number from an earlier session.

`KEEP_DITCH.md` records what these harnesses have and have not been able to
move, with the measured cost breakdown of the `/` cold load.

## Local Cloud

Run the Cloud dashboard and Connect worker against one local D1 database:

```bash
pnpm cloud:dev
```

The command applies migrations and prints the dashboard URL. Create a local
email/password account, claim a handle, create a pairing code, and run the
displayed `bb connect` command against a bb started with `pnpm dev`. The same
worktree-specific local origin serves the dashboard at `bb.localhost` and
routes `<handle>.bb.localhost` through the Connect worker. Email/password auth
is enabled only for this loopback workflow; production remains GitHub-only.
`pnpm dev` automatically sets `BB_DEV_CONNECT_BASE_URL` to that worktree's
local Cloud origin. While the bb is unpaired, Extensions → Plugins → Connect
therefore opens the local dashboard and a pasted code redeems locally. An
explicit `bb connect --server ...` or `--base-url ...` still wins, so the dev bb
can still pair with getbb.app.
Local machine enrollment follows the same origin: local `http:` server URLs
produce `ws:` machine tunnels and `http:` share URLs, while non-local machine
enrollment remains HTTPS-only.

Ctrl-C stops the local services. Local D1 state is kept under
`.wrangler/cloud-dev`.
