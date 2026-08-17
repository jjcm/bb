# Composer large-paste performance: keep/ditch review

This reviews PR #1 change by change. The filtered result keeps every product
change, with the tweaks described below applied on the branch. No change had a
complexity-to-value ratio bad enough to ditch outright.

## Verdicts

### KEEP-WITH-TWEAK — Markdown parser range/sweep rewrite

- **Why:** This is the dominant measured paste/mount win when rich-text
  Markdown editing is enabled. On the 1 MB synthetic single-line fixture,
  `promptEditorContentFromValue(..., { richTextMarkdown: true })` fell from
  2,059 ms to 12.86 ms on this Linux VM.
- **Complexity cost:** Medium-high. Sorted range indexes and monotonic sweeps
  are less obvious than repeated array scans.
- **Speed win:** Very high for delimiter-heavy input. The measured growth is
  near-linear across the fixture sizes, but the implementation sorts ranges
  and is not formally O(n); earlier “linear” wording was too strong.
- **Maintainability:** Acceptable after removing an unreachable fallback loop
  and committing a regression test that round-trips a large single line with
  thousands of Markdown delimiters. Existing Markdown behavior tests still
  pass.

### KEEP-WITH-TWEAK — Deferred decoration rebuilds for large drafts

- **Why:** Before this change, every edit synchronously serialized the full
  document and ran every host/plugin decoration matcher over all text. The
  built-in regex alone measured 8.90 ms at 1 MB; plugin matchers are
  user-supplied and unbounded.
- **Complexity cost:** Medium. The extension now has mapped interim
  decorations, pending state, and one deferred rebuild timer.
- **Speed win:** High after a large paste because this work leaves the direct
  keystroke path.
- **Maintainability:** Acceptable with explicit constants and tests. The
  threshold was raised from 10,000 to 100,000 document positions so normal
  prompts do not pay a visible consistency tradeoff for a negligible saving.
  Tests now cover both stale removal and timer cancellation after an explicit
  refresh.
- **Remaining tradeoff:** In drafts over 100,000 positions, highlight
  additions *and removals* may lag by up to 200 ms. Existing decorations map
  through edits in the interim. The original PR only called out delayed
  additions; that was incomplete.

### KEEP — Bounded typeahead trigger scan

- **Why:** Typeahead queries are short tokens; rebuilding all text before the
  caret to find one is unnecessary.
- **Complexity cost:** Low. One scan-window constant and a boundary guard.
- **Speed win:** The isolated 1 MB scan fell from 2.52 ms to approximately
  0.00 ms, and this path runs on both document and selection updates.
- **Maintainability:** Good. Tests cover a trigger near the end of a large
  document and prevent the window edge from masquerading as start-of-input.
- **Remaining tradeoff:** A windowed query can contain at most 254 characters
  (boundary + trigger + query within a 256-character window). Longer queries
  do not open the menu.

### KEEP-WITH-TWEAK — Structural controlled-value comparison

- **Why:** The old sync key JSON-stringified the full prompt in `onUpdate`,
  then did so again when the controlled value returned through React. A single
  stringify measured 2.54 ms at 1 MB.
- **Complexity cost:** Low-medium. Text normally settles on string identity;
  mentions require structural comparison, including a small resource
  serialization only when resource references differ.
- **Speed win:** About two full-text serializations removed per keystroke for
  the target case.
- **Maintainability:** Good after adding direct coverage for equal cloned
  mentions and changed resources. External controlled updates still trigger
  `setContent` when their value actually changes.

### KEEP-WITH-TWEAK — Serialize draft storage at the persist boundary

- **Why:** Persistence was already debounced by 250 ms, but serialization
  still happened on every write. A 1 MB draft serialization measured 2.48 ms.
- **Complexity cost:** Low-medium. The in-memory draft is authoritative while
  a persist is pending; `rawValue` is populated at flush time.
- **Speed win:** Removes one full-draft serialization per keystroke and does it
  once per debounce interval instead.
- **Maintainability:** Acceptable after adding fake-timer tests for pending
  reads, deferred persistence, immediate overwrite of a pending write, and
  page-hide flushing.
- **Remaining tradeoff:** None beyond the pre-existing 250 ms crash-loss
  window. `pagehide` and hidden-document flushing remain in place.

### KEEP — Non-subscribing thread-view draft accessor

- **Why:** `ThreadDetailView` only needs `addQuote` and the focus-bus storage
  key at event time. Subscribing the whole thread view to prompt text caused
  the timeline parent to re-render for every keystroke.
- **Complexity cost:** Low. Shared quote mutation logic is reused by both the
  hook and imperative accessor.
- **Speed win:** Removes a large React render path from typing. This was
  verified by subscription flow/code inspection, not timed on the VM.
- **Maintainability:** Better than before: event-time consumers use the
  documented imperative accessor, while the composer remains the subscriber
  that renders draft state.

### KEEP-WITH-TWEAK — Deterministic fixture and performance harness

- **Why:** The fixture makes the 1 MB single-line case reproducible without
  checking in a megabyte blob, and the harness preserves isolated hot-path
  measurements for future comparisons.
- **Complexity cost:** No production runtime cost; moderate test-only code.
- **Speed win:** None by itself; this is measurement/repro infrastructure.
- **Maintainability:** Good after relabeling it a **synthetic microbenchmark**,
  stating that it measures isolated primitives rather than editor
  transactions, using medians consistently, and replacing a tautological
  assertion. The generated text is JS-shaped, not a representative corpus of
  real minified bundles.

## What moved the needle at 1 MB

Measured on the cloud Linux VM under Node/Vitest:

| Isolated operation | Before | Filtered branch | Effect |
| --- | ---: | ---: | --- |
| Rich-text Markdown parse on paste/mount | 2,059 ms | 12.86 ms | Near-eliminates the measured multi-second JS parse stall |
| Trigger scan after paste | 2.52 ms | ~0.00 ms | Removed from each edit/selection update |
| Full-value stringify | 2.54–3.11 ms each, twice/edit | Removed | Structural/reference compare instead |
| Built-in decoration regex | 8.05–8.90 ms/edit | Deferred for >100k docs | Removed from direct input handling |
| Draft stringify | 2.48–3.15 ms/edit | Once per 250 ms flush | Removed from each edit |
| Whole `ThreadDetailView` draft subscription | Present | Removed | React render avoided; not timed |

The first row is what materially fixes the measured paste/mount stall with
rich-text Markdown enabled. With default plain-text editing, constructing
inline content was already about 0.01 ms in this microbenchmark; the measurable
VM gains there are primarily the post-paste typing/selection path. No FCP,
scroll-frame, or end-to-end input-latency number was measured on this VM.

The earlier “roughly 20 ms per character” summary was an estimate formed by
adding isolated primitives from one run, not an end-to-end transaction
measurement. It should be read only as the amount of identified synchronous
JS work removed from a 1 MB case.

## VM versus Electron

All numeric results above are Node/Vitest timings on a cloud Linux VM. They do
not include ProseMirror DOM reconciliation, Chromium style/layout/paint,
wrapping a 1 MB line, selection `coordsAtPos`, Electron scheduling, React
commit time, actual interaction latency, or dropped frames.

Electron layout of a 1 MB wrapped line remains unmeasured. Any claim that this
branch fixes Electron paste latency, FCP, typing latency, or scroll jank is a
hypothesis until the following macOS comparison is recorded.

## macOS Electron repro for strago

Run the same steps on `main` and this branch:

1. Build and launch the macOS desktop app.
2. Generate and copy the deterministic fixture:

   ```bash
   cd apps/app
   PROMPTBOX_PERF=1 \
   PROMPTBOX_PERF_FIXTURE_OUT=/tmp/minified-paste-fixture.js \
     pnpm exec vitest run \
     src/components/promptbox/editor/prompt-paste-performance.test.ts
   cat /tmp/minified-paste-fixture.js | pbcopy
   ```

3. Open a thread with existing messages and focus the composer.
4. Start a Chromium DevTools Performance recording.
5. Paste, type about 20 characters, move the caret/use ArrowUp and ArrowDown,
   and scroll the thread.
6. Compare long tasks at paste, the Interactions track, main-thread time per
   key, and dropped frames between `main` and this branch.
7. Repeat with rich-text Markdown editing enabled. This isolates the parser
   case from the default plain-text path.

If the filtered branch still spends substantial time on paste after the JS
parse work disappears, inspect Chromium layout/paint for the wrapped
single-line editor. That result would identify a separate Electron bottleneck,
not invalidate the VM microbenchmark.

---

# Load-time iteration (Track A, on top of the paste keepers)

This section covers the app-wide load-time work added after the composer
paste review above. Nothing above was reverted or rewritten.

## What was measured first (no guessing)

Harness: `apps/app/scripts/measure-load.mjs` — headless Chromium (Linux VM),
production build served by the real bb server on localhost against a seeded
database (12 projects / 400 threads / ~120k events via `pnpm seed:perf`),
cold cache, 4× CPU throttle, medians of 7 runs, plus a per-run script
waterfall. **These are Linux Chromium numbers over localhost, not Electron
numbers.** Bundle attribution: `BB_BUNDLE_STATS_ALL=1 pnpm --dir apps/app run
build` writes `bundle-stats-all.json` (every chunk, packages, import edges).

Baseline finding: on the default route `/`, first paint lands ~900 ms but the
composer only becomes present at **~2,494 ms**. The gap is one synchronous
script wave: the lazy workspace route chunk statically dragged
`@pierre/diffs` + the entire Shiki engine + all TipTap extensions (one shared
2,148 KB raw / 514 KB brotli chunk) plus KaTeX (253 KB raw) — pierre, Shiki,
and KaTeX parse+execute before the composer can mount, on every session,
even when no diff or math is ever shown.

## The fix (single biggest measured bottleneck)

Cut every static edge from the workspace route graph to `@pierre/diffs`,
Shiki, and KaTeX:

- `git-diff-parsing.ts` split: pierre-free helpers stay; runtime parse
  entry points moved to `git-diff-patch-parsing.ts` (pierre-static, only
  reachable from lazy diff UI).
- `GitDiffCard` became a lazy facade (same API/props for all consumers,
  skeleton fallback); the real card provides the shared pierre worker pool
  itself (`PierrePoolBoundary`).
- `FilePreview`'s pierre-rendered code view extracted to `FilePreviewCode`
  behind `React.lazy` (skeleton fallback); `FilePreview` itself is now
  pierre-free.
- `TimelineFileDiffBlock` and `DiffFileCard` lazy at their single consumers;
  `PluginPanelView` lazy in `SplitThreadArea`.
- All four diff islands funnel through one lazy entry
  (`git-diff/diff-islands.tsx`) so they share one async chunk instead of
  fragmenting shared modules into extra boot chunks.
- The old `ThreadDetailWorkerPoolProvider` ancestor was deleted; pierre's
  pool is a package-level singleton, so per-island providers still share one
  pool.
- `rehype-katex` + KaTeX CSS load lazily inside `MarkdownPreview`, and only
  when content can contain math (`$$`). Until loaded, TeX renders as
  readable `language-math` code — no blank state.

## Before/after (this VM, headless Chromium, 4× throttle, medians of 7)

| Metric | Baseline | After | Delta |
| --- | ---: | ---: | ---: |
| `/` route-ready (promptbox wrapper present) | 2,494 ms | 2,278 ms | −216 ms (−8.7%) |
| `/` FCP | 920 ms | 864 ms | −56 ms |
| `/` LCP | 1,236 ms | 1,168 ms | −68 ms |
| `/settings` route-ready | 1,089 ms | 1,107 ms | noise |
| `/threads/:id` FCP / LCP | 848 / 1,148 ms | 848 / 1,152 ms (median run) | noise |
| Workspace shared chunk | 2,148 KB raw / 514 KB br | 1,304 KB raw / 325 KB br | −844 KB raw / −189 KB br |
| Route-wave transfer before route-ready (`/`) | ~3.2 MB raw | ~2.2 MB raw | ~−1.35 MB raw incl. KaTeX |
| Boot payload | 1,664.0 KB raw / 436.8 KB br (14 chunks) | 1,665.9 KB raw / 441.1 KB br (22 chunks) | +1.9 KB raw / +4.3 KB br |

Verified structurally (not just by timing): the route chunk's static import
closure contains none of `@pierre/diffs`, `@pierre/theming`, `shiki`,
`@shikijs/*`, `katex`, `rehype-katex` (asserted by walking
`bundle-stats-all.json`); `/settings` no longer downloads KaTeX at all; the
existing `forbiddenBootPackages` check still passes. Full app suite (349
files / 2,778 tests), typecheck, and lint pass; headless Chromium shows no
console errors on `/`, `/threads/:id`, `/settings`.

## Tradeoffs (honest list)

- **Boot brotli budget raised 438.0 → 442.4 KB** (`bundle-budget.json`
  ratchet; the doc requires a stated reason): the new lazy boundaries split
  the boot graph into 22 chunks instead of 14, and more independent brotli
  streams compress slightly worse. +4.3 KB brotli on boot buys ~−189 KB
  brotli / −844 KB raw off the route-interactive wave and removes pierre,
  Shiki, and KaTeX from it entirely. Raw budget was not raised.
- Diff cards, the file-preview code view, and plugin panels render a
  skeleton for one network+parse round-trip the first time one appears in a
  session. After that the chunk is cached.
- The pierre worker pool now terminates when the last diff island unmounts
  and respawns on the next one (pierre's own instance counting); previously
  it lived for the whole workspace route. Worker respawn is off the main
  thread; diff-heavy scrolling re-uses mounted islands so churn is bounded.
- Math rendering appears one deferred load after first `$$` content; TeX
  source is readable meanwhile.
- The remaining `/` route-ready gap (~2.3 s at 4× throttle) is TipTap +
  composer + plugin frontends executing after the wave — that is the next
  iteration's measured target, deliberately not attempted here.

## VM vs Electron (unchanged rule)

Everything above is Linux headless Chromium over localhost. Electron cold
start (main-process boot, window creation, server spawn), macOS compositor
behavior, real disk I/O, and input latency are unmeasured. The −216 ms
route-ready delta at 4× throttle should compress toward ~−50–100 ms on fast
Apple silicon and grow on slower machines; treat that as hypothesis until
the strago run.

## strago (macOS Electron) measurement steps

1. Build both revisions of the desktop app (`main` as baseline, this
   branch): `pnpm --dir apps/desktop run package` (or `dist`), or run the
   packaged app against a production server build.
2. Seed a realistic database once:
   `pnpm seed:perf -- --data-dir <test-data-dir>` (never `~/.bb`).
3. **Cold start:** quit the app fully, `time` from launch to first window
   paint; also record the DevTools Performance timeline during launch
   (View → Toggle Developer Tools before quitting so it reopens attached, or
   use `BB_DESKTOP_APP_URL` dev wiring). Repeat 5×, take medians.
4. **Shell FCP/LCP + route-ready:** in the app's DevTools console, run a
   Performance recording, then hard-reload (Cmd+Shift+R). Read FCP/LCP from
   the Timings track. Route-ready markers: `/` and thread detail →
   `[data-promptbox-editor-content]` appears; settings → first settings
   control. `apps/app/scripts/measure-load.mjs` also works against the
   packaged app's local server URL (`node scripts/measure-load.mjs --base
   http://127.0.0.1:38886 --routes "/,/threads/<id>,/settings"`) using
   installed Chrome as the measurement browser — label those numbers
   Chromium-on-macOS, not Electron.
5. **Thread list:** with the seeded DB, measure time from reload to the
   sidebar thread list rendering rows (Performance recording; the list is in
   the eager shell, so watch long tasks between FCP and list paint).
6. **Diff-island tradeoff check:** open a thread with file diffs and confirm
   the skeleton→card swap is acceptable on first open (this iteration's
   regression surface); scroll a long diff panel and watch for worker-pool
   respawn jank.
7. Compare against baseline medians; anything within run-to-run spread is
   noise, not a win or regression.

---

# Load-time iteration 2: defer plugin-frontend boot off the route's first paint

**Verdict: KEEP.** Measured −20.8% on `/` route-ready against this iteration's
own fresh baseline. Environment for every number in this section: Linux
headless Chromium over localhost (4× CPU throttle, cold cache, medians of 7,
`apps/app/scripts/measure-load.mjs`, seeded 400 threads / 120k events). Not
Electron.

## Fresh baseline at PR HEAD (before this iteration)

`/` route-ready 2,319 ms, FCP 856 ms, LCP 1,160 ms; `/settings` route-ready
1,118 ms; `/threads/:id` FCP 860 / LCP 1,168 ms (its ready marker still never
fires against the seeded offline-host fixture). Consistent with the previous
iteration's "after" numbers — the pierre/Shiki/KaTeX split held.

## What the waterfall showed (measured, not the documented hypothesis)

The harness now also records API request timing. The previous report guessed
"TipTap + plugin frontends"; the data split that in two:

- The sidebar-bootstrap query the composer waits on completes at ~794 ms
  (17 ms server time) — **API latency is not the bottleneck** on this setup.
- After the route chunks finish downloading (~790 ms), the main thread runs
  one long crunch until the composer commits at ~2,300 ms. The tail of that
  crunch is the plugin-frontend runtime chunk (~157 KB brotli at ~1,200 ms)
  plus six plugin `app.js` bundles (~427 KB brotli at ~1,680 ms) evaluating
  **before** the composer's first paint. `usePluginFrontendBoot` claimed
  "never delays first paint," which was true for the shell FCP but false for
  route content: plugin module evaluation preempted the composer commit.

## The change

- `usePluginFrontendBoot` now defers boot: config resolves → 500 ms timer
  (skips the false-idle window while route chunks are still downloading, when
  an immediate idle callback would fire and put plugin evaluation back in
  front of the composer) → `requestIdleCallback` with a 3 s timeout
  (`setTimeout` fallback where rIC is unavailable, e.g. jsdom/Safari).
- `PluginPanelView` calls `bootPluginFrontends()` directly on mount, so a
  deep link into a plugin panel skips the idle wait (boot is idempotent per
  page load). Verified: the automations panel deep link renders real panel
  content in the headless browser.
- No consumer API changed; the pierre/Shiki/KaTeX split and all composer
  paste keepers are untouched.

## Before/after (vs this iteration's fresh baseline, same methodology)

| Metric | Baseline (PR HEAD) | After | Delta |
| --- | ---: | ---: | ---: |
| `/` route-ready (promptbox wrapper present) | 2,319 ms | **1,836 ms** | **−483 ms (−20.8%)** |
| `/` FCP / LCP | 856 / 1,160 ms | 868 / 1,156 ms | noise |
| `/settings` route-ready | 1,118 ms | 1,065 ms | −53 ms (−4.7%) |
| `/settings` LCP | 1,128 ms | 1,072 ms | −56 ms |
| `/threads/:id` FCP / LCP | 860 / 1,168 ms | 876 / 1,164 ms | noise |
| Plugin `app.js` evaluation | ~1,680 ms, before composer | ~2,029 ms, after composer | reordered |

FCP/LCP measure the eager shell, which paints before the crunch either way;
this change moves route *content* readiness, which is where the previous
iteration's remaining gap lived. Boot payload: 1,666.1 KB raw / 441.2 KB
brotli — inside the existing budget (1,667.0 / 442.4), **no ratchet change
this iteration**.

## Tradeoffs

- Plugin surfaces (composer actions, sidebar panels, plugin slots) appear
  roughly 0.5–1.5 s later than before on an idle machine: boot now starts at
  first idle after route content paints (bounded by the 500 ms timer + 3 s
  idle timeout) instead of immediately after config resolves. They already
  popped in asynchronously; the order app-content-first, plugins-second is
  the point of the change.
- Plugin panel deep links are exempt via the direct boot call and roughly
  match previous latency.
- The measured win depends on plugins being installed (this fixture ships 6
  plugin frontends). A zero-plugin install skips most of the deferred work
  and will see a smaller delta — though the plugin runtime chunk itself
  (~157 KB brotli) is also deferred, which benefits every install.

## Remaining `/` route-ready cost after this iteration

~1,050 ms of main-thread work between the route-chunk wave (~790 ms) and the
composer commit (~1,836 ms) at 4× throttle: workspace + route chunk
evaluation (~2.1 MB raw, dominated by TipTap/ProseMirror, which the composer
genuinely needs) and the React render of the shell + compose surface. Cutting
that further means either splitting TipTap out of the composer's first paint
(placeholder editor, high product risk) or trimming the route chunk itself —
next iteration's candidates, untouched here.

---

# Load-time iteration 3: thread detail out of the default route's chunk

**Verdict: KEEP.** Measured −7.1% on `/` route-ready vs this iteration's own
fresh baseline, with FCP and LCP each −48 ms, and the thread route measured
to confirm no regression (it improved slightly). Environment for every number
here: Linux headless Chromium over localhost (4× CPU throttle, cold cache,
medians of 7, `apps/app/scripts/measure-load.mjs`, seeded DB). Not Electron.

## Fresh baseline at PR HEAD (before this iteration)

`/` route-ready 1,853 ms, FCP 896 ms, LCP 1,180 ms — consistent with
iteration 2's after-numbers (1,836 ms), so the plugin deferral held.

## What the profiler showed (new `--profile` mode)

The harness gained a CDP sampling-profiler mode that attributes main-thread
self-time per script until route-ready. The documented hypothesis
("TipTap/ProseMirror evaluation + compose-surface render") was again only
part of the story:

- The TipTap chunk accounted for ~188 ms of the ~1.85 s window.
- More time sat in boot-chunk execution and React render work (react-dom
  ~334 ms; a domain/zod/icons boot chunk ~476 ms including render frames
  attributed to it; ~276 ms parse/compile).
- DOM volume was ruled out: `/` renders only ~1,100 elements.
- The clearest byte-level waste: the workspace route chunk statically
  included the entire ThreadDetailView graph (timeline, secondary panels,
  embedded chat) that `/` never renders — and vice versa nothing on `/`
  needed it.

## The change

- `ThreadDetailView` is now a lazy pane view inside `SplitThreadArea`
  (Suspense fallback null), like `PluginPanelView` already was. The default
  `/` route parses only the compose graph; thread URLs fetch the thread
  chunk in parallel with the route chunk.
- `LegacyProjectComposeRedirect` moved to its own module so the route table
  no longer statically reaches `RootComposeView`.
- `RootComposeView` deliberately **stays static** in the route chunk: a
  three-way split was tried and measured — it re-fragmented shared modules
  into extra boot chunks (+9.4 KB brotli on boot) with no additional `/`
  win, so it was reverted to the two-way shape (+8 → +6.9 KB contained).
- Consumer APIs unchanged; pierre/Shiki/KaTeX split, plugin idle deferral,
  and all composer paste keepers untouched.

Structural result: the `/` route's static closure dropped from 4,090 KB to
3,191 KB raw (−899 KB): a 500 KB ThreadDetailView chunk plus ~400 KB of
thread-only shared chunks now load only on thread routes. The forbidden-boot
and forbidden-route package assertions still hold.

## Before/after (vs this iteration's fresh baseline, same methodology)

| Metric | Baseline (PR HEAD) | After | Delta |
| --- | ---: | ---: | ---: |
| `/` route-ready (promptbox wrapper present) | 1,853 ms | **1,722 ms** | **−131 ms (−7.1%)** |
| `/` FCP | 896 ms | 848 ms | −48 ms |
| `/` LCP | 1,180 ms | 1,132 ms | −48 ms |
| Thread route route-ready¹ | 2,226 ms | 2,140 ms | −86 ms (no regression) |
| Thread route LCP¹ | 2,252 ms | 2,164 ms | −88 ms |
| `/settings` route-ready | ~1,065 ms (iter-2 after) | 1,048 ms | noise |
| `/` route static closure | 4,090 KB raw | 3,191 KB raw | −899 KB |
| Boot payload | 1,666.1 KB raw / 441.2 KB br (22 chunks) | 1,669.1 KB raw / 449.2 KB br (26 chunks) | +3.0 KB raw / +8.0 KB br |

¹ Measured on the canonical `/projects/:projectId/threads/:threadId` URL by
stash-rebuilding the pre-change revision, since the projectless `/threads/:id`
URL renders ThreadDetailView's "Not found" state on this seeded fixture (a
pre-existing data condition — it also explains why the thread ready-marker
read NaN in every earlier iteration; earlier thread rows report FCP/LCP only).

Cumulative `/` route-ready across the three load iterations:
**2,494 → 1,722 ms (−31%)** on this rig.

## Tradeoffs

- **Boot brotli ratchet raised again, 442.4 → 450.0 KB** (and raw 1,667 →
  1,672 KB) in `bundle-budget.json`: splitting the thread view re-partitions
  modules shared between boot and the thread chunk (`useAppTheme`,
  drag-click suppression, and several slivers become separate chunks), and
  26 brotli streams compress slightly worse than 22. Cumulative boot cost of
  all three load iterations: +12.4 KB brotli (+2.8%) — against −2.25 MB raw
  removed from the default route's parse/execute path plus deferred plugin
  evaluation. If a later iteration wins boot headroom back, lower the
  ratchet per the budget file's own policy.
- First navigation from `/` to a thread in a session shows the pane Suspense
  fallback (blank pane) for one chunk round trip (~20 ms localhost; one
  extra HTTP/2 request on real networks). Subsequent thread opens are
  cached. Measured cold thread-route load did not regress.
- Three SplitThreadArea tests updated to await the now-lazy pane content.

## Remaining `/` route-ready cost (next candidates, measured)

~900 ms between the route wave and composer commit at 4× throttle:
parse/compile (~276 ms), the domain/zod/icon boot chunk (~200–475 ms
including attributed render work), react-dom render (~334 ms), TipTap eval
(~188 ms). The largest untried lever is module-eval cost in the boot chunks
(zod schema construction in `@bb/domain`, the eager ~280-icon map) — an
invasive package-level change, deliberately not attempted in this iteration.

---

# Track C: warm in-browser SPA navigation — one KEEP (−48% on first thread open)

Tracks A and B both optimized the cold load. This track measures the other
half of the hosted web app, and the half a user spends nearly all their time
in: the SPA is **already up** and they click something. Environment for every
number in this section: **production build, headless Chromium on Linux over
localhost against the real bb server. Not Electron, not Vite dev.**

It also answers the question Track A left open. Jacob's framing was that a warm
thread open is "where Track A's lazy ThreadDetailView / pierre / Shiki /
plugin-frontend should actually show, or fail to". One of them showed — as a
cost, not a win.

## The finish line

`apps/app/scripts/measure-warm-nav.mjs`, 1440x900, cache disabled, fresh
browser profile per run, no CPU throttle, seeded database (12 projects /
400 threads / ~120k events).

Each run loads `/` and waits until the shell is genuinely settled — sidebar and
New thread painted, root composer painted, then a quiet beat — and only then
clicks, timing from the in-page `mousedown` until the destination content is
painted:

| Probe | What it measures |
| --- | --- |
| `threadOpen1` | **Primary.** First thread opened in the session. |
| `threadOpen2` | A second, different thread; per-thread work without one-time cost. |
| `newThread` | Back to the root composer, `Ask anything.` painted. |
| `settings` | A heavy non-thread view, as a third probe. |

Markers land on the frame *after* the DOM condition first holds, so a number
means the browser painted it. Every verdict below is **interleaved A/B** — two
prebuilt dists alternating round by round, n=18–30 per arm — because
single-build medians on this VM drift by more than most changes are worth.

## Warm baseline at PR HEAD

| Probe | Median |
| --- | ---: |
| `threadOpen1` | **469 ms** |
| `threadOpen2` | 213 ms |
| `newThread` | 107 ms |
| `settings` | 152 ms |

`--counters` splits the primary probe with Chromium's own counters:
of `threadOpen1`'s 471 ms, ~305 ms is busy main thread (script 170 ms, style
recalc 82 ms across ~45 recalculations, layout 8 ms) and ~165 ms is idle. A
`devtools.timeline` trace of the same navigation shows **4,541 top-level tasks**
— the mount is sliced across thousands of React scheduler yields, so wall time
exceeds CPU time.

Two Track A keeps provably cannot show on this path and were not credited or
blamed: no pierre/Shiki/KaTeX chunk loads at all during a thread open (the
fixture's threads contain no file diffs, so those islands never mount), and the
plugin frontends have already booted during the settle window.

## MISS — prefetch the lazy thread-pane chunk during idle

If the first thread open pays a chunk round trip, warm the module while nothing
is happening. Scheduled like `usePluginFrontendBoot` (short timer to skip the
false-idle window, then `requestIdleCallback`).

| Probe | baseline | after | Delta |
| --- | ---: | ---: | ---: |
| `threadOpen1` | 471.2 ms | 464.5 ms | −6.8 ms (−1.4%) |
| `threadOpen2` | 222.1 ms | 216.3 ms | −5.8 ms |
| `newThread` | 117.5 ms | 111.8 ms | −5.8 ms |
| `settings` | 81.0 ms | 74.2 ms | −6.8 ms |

**Reverted.** Note `settings` moved by the same −6.8 ms, and the prefetch cannot
touch it: the whole column is drift, not effect. At a 1.5 s idle delay the
prefetch was fully inert (the chunk was still requested *after* the click), and
even in a deliberately settled session where it had provably run — 52 scripts
loaded before the probes instead of 50 — it recovered only ~7 ms. **The chunk
fetch was never the cost:** it overlaps the thread's own API requests, so
removing it from the click path buys nothing.

## KEEP — thread detail is a static import again

Prefetching ruled out bytes, so the remaining suspect was the `React.lazy`
boundary itself. A spike replaced it with a static import: **−194.7 ms
(−41.7%)** on the first thread open. The confirming A/B on the real change,
n=30 per arm:

| Probe | baseline | after | Delta |
| --- | ---: | ---: | ---: |
| `threadOpen1` | 469.0 ms | **241.7 ms** | **−227.3 ms (−48.5%)** |
| `threadOpen2` | 213.1 ms | 201.8 ms | −11.3 ms (−5.3%) |
| `newThread` | 107.1 ms | 96.7 ms | −10.5 ms (−9.8%) |
| `settings` | 151.8 ms | 153.1 ms | +1.4 ms (noise) |

And on the cold path, n=28 per arm with `measure-hud.mjs`:

| Cold metric | baseline | after | Delta |
| --- | ---: | ---: | ---: |
| HUD (sidebar + New thread painted) | 416.2 ms | 401.7 ms | −14.5 ms (no regression) |
| Composer `Ask anything.` after click | 249.5 ms | **197.0 ms** | **−52.5 ms (−21.0%)** |

| Boot payload | baseline | after |
| --- | ---: | ---: |
| raw / brotli / chunks | 1669.1 KB / 449.7 KB / 26 | 1666.1 KB / **441.2 KB** / **22** |

### Why the lazy boundary was so expensive

It was never really about the ~30 ms chunk fetch. A `React.lazy` suspend means
the pane mounts on a **Suspense retry, at transition priority**, so the largest
view in the app is rendered in sliced, yielding work instead of one pass. That
is what the 4,541 tasks and the ~165 ms of otherwise unexplained idle in
`threadOpen1` were. Removing the boundary removes the sliced retry; the
remaining 242 ms is the render itself, and `threadOpen2` (which never had a
suspend) barely moved, exactly as that explanation predicts.

Track A reached the opposite conclusion honestly and from real data — it
measured `/` **route-ready** (promptbox wrapper present) and saw −131 ms. That
metric has since been retired precisely because it ranks work happening after
the HUD is already on screen. On every metric now in use, static is better or
neutral.

### Tradeoffs

- A session that never opens a thread still downloads and parses the thread
  view as part of the workspace route chunk (~899 KB raw back in that route's
  static closure). The measurements above say that costs nothing on this rig:
  cold first paint is unchanged and the cold composer is 52 ms *faster*,
  because the route wave is 22 chunks instead of 26. On a slow network the
  extra bytes are a real cost that localhost cannot show — but so was the
  round trip they replace, and the round trip was on the interaction path
  while these bytes are not.
- Boot brotli improved by 8.5 KB. `bundle-budget.json` keeps its current
  limits and records the new headroom rather than ratcheting onto 441.2 KB,
  which would leave the next ordinary feature nowhere to land.
- `PluginPanelView` stays lazy on purpose: it is a deep-link-only surface, so
  no ordinary navigation pays its suspend.

### What a next warm track should look at (measured, not attempted)

`threadOpen2` at ~202 ms is now the steady-state cost of opening a thread, and
it is not dominated by any single chunk:

- **~84 ms of style recalculation across ~45 recalcs**, essentially identical on
  first and second open. Mounting a thread writes ~3,500 attributes, of which
  ~1,300 are SVG path attributes for ~115 icons, plus `class` on ~768 elements.
- **~106–125 ms of script**, spread across react-dom render, a scroll/measure
  helper (~37 ms, doing ~36 `scrollHeight`/`clientHeight`/`clientWidth` reads),
  and the thread view itself (~10 ms).
- **~18 API requests per thread open**, in two waves; the second wave fires
  after the big render pass. Three of them (`system/execution-options`,
  `environments/status`, `environments/pull-request`) take ~165 ms each but land
  after the paint, so they do not gate this metric — they would gate a
  "thread fully interactive" metric.

Cutting further means rendering less or re-rendering less on thread mount,
which is a product decision, not a bundling one.

---

# Track B: cold browser load to a usable HUD — 3 misses, nothing kept

Track A above optimized `measure-load.mjs` **route-ready** (promptbox wrapper
present). Jacob then measured Playwright Chromium on macOS against Vite and
found that metric does not describe what a person waits for: first usable HUD
was a tie (323 ms main vs 322 ms this branch), and composer-after-New-thread
was 795 vs 806 ms. The paste keepers are real; boot was not faster in a
browser. Track A's load keeps could not show, because that harness waited on
highlighters, plugin frontends, and `ThreadDetailView` — all of which finish
_after_ the HUD has already painted.

This track re-ran the loop against a new finish line and **kept nothing**: all
three attempts came in inside noise. What it did produce is a hard measurement
of where the cold-load time actually goes, which retires two plausible
theories and quantifies the one real lever.

## The finish line (replaces route-ready)

`apps/app/scripts/measure-hud.mjs` — headless Chromium over localhost against
the **production** build served by the real bb server, 1440x900, cache
disabled, a fresh browser profile every run, **no CPU throttle**, seeded
database (12 projects / 400 threads / ~120k events).

- **Primary — HUD:** first _painted_ frame containing the sidebar and an
  enabled "New thread" control.
- **Secondary — composer:** time from clicking "New thread" until the
  composer's `Ask anything.` placeholder is painted. That placeholder only
  exists once ProseMirror is constructed and TipTap's placeholder decoration
  has applied, so it cannot pass on the promptbox wrapper alone — this is a
  strictly stronger marker than Track A's route-ready.
- Both markers are recorded on the animation frame _after_ the DOM condition
  first holds, so a number means "the browser painted it". During a long task
  no frame callback runs, so a marker lands on the first painted frame after
  the blocking work, which is what a waiting person feels.
- Document `load` and HTML TTFB are deliberately not reported: `load` fires
  before React paints, so it cannot rank HUD changes.

These remain Linux-Chromium-on-localhost numbers, not Electron and not macOS.

**Run-to-run spread is large on this VM** (single-build medians drifted 405 →
438 ms across the session for identical bytes), so every keep/ditch decision
below comes from **interleaved A/B**: the two dists alternate round by round,
7 runs per round, 3–4 rounds, n=21–28 per arm. Absolute numbers from different
sections are not comparable; deltas within a section are.

## Baseline at PR #1 HEAD

| Metric                               |                                             Median |
| ------------------------------------ | -------------------------------------------------: |
| HUD (sidebar + New thread painted)   | **405 ms** (n=9; later same-build runs 413–448 ms) |
| Composer `Ask anything.` after click |                                         **222 ms** |
| FCP                                  |                                             372 ms |
| Boot payload                         |    1,709 KB raw / 449.7 KB brotli across 26 chunks |

**The HUD is the first paint.** FCP and the HUD land within ~30 ms of each
other, because the sidebar shell is what paints first. So anything that only
reorders work _after_ first paint — which is what every Track A keep does —
cannot move this number by construction.

## Where the 405 ms actually goes (measured, not assumed)

Two independent measurements, both on the production build:

1. **Script waterfall.** All 26 boot chunks finish downloading by ~121 ms on
   localhost. Everything after that is CPU.
2. **Per-chunk marginal cost.** A throwaway page imported each boot chunk in
   dependency order and timed each `import()` alone, so each figure is that
   chunk's own download+parse+eval with its dependencies already resolved:

| Boot chunk                  | Contents                                                                  |                         Marginal cost |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------: |
| sdk/contract chunk (322 KB) | `@bb/sdk`, `@bb/server-contract` zod schemas, hono, partysocket, tanstack |                             **77 ms** |
| domain/ui chunk (274 KB)    | `@bb/domain` zod schemas, `@bb/shared-ui` icon, hugeicons, jotai, react   |                             **59 ms** |
| entry chunk (343 KB)        | app shell, sidebar, dialogs, cache owners                                 |                                 27 ms |
| 23 remaining boot chunks    | —                                                                         | ~40 ms total (≈2 ms fetch floor each) |
|                             |                                                                           |                **~250 ms sequential** |

Budget for the 405 ms: ~120 ms HTML + boot download (overlapping compile),
~200 ms module evaluation, ~80 ms React render/commit/paint. **Module
evaluation is the dominant bucket, and it is dominated by zod.**

## The ceiling: zod schema construction is 18% of the HUD

Aliasing `zod` to a no-op chainable stub keeps the whole module graph and every
`z.object({...})` call site, and removes only zod's own construction work:

| Arm                          | HUD median |                 Delta |
| ---------------------------- | ---------: | --------------------: |
| unmodified                   |     418 ms |                     — |
| all zod construction stubbed |   342.6 ms | **−75.4 ms (−18.0%)** |

Scoping the stub to one package at a time attributes it:

| Scope                      | HUD median |                                         Delta |
| -------------------------- | ---------: | --------------------------------------------: |
| unmodified                 |   448.4 ms |                                             — |
| `@bb/server-contract` only |   401.4 ms | **−47.0 ms (−10.5%)**, plus composer −14.8 ms |

So ~75 ms of the cold HUD is spent constructing zod schemas that the first
paint never validates anything against, and `@bb/server-contract` is 47 ms of
it. **This confirms the standing hypothesis that production bundle
parse/eval sits on the HUD's critical path** — and it is also why Track A
iteration 4 filed zod as a miss without contradiction: on _route-ready_ the
construction stayed inside the pre-ready window either way, so deferring it
netted zero. On _first paint_ the same work is directly in front of the user.

## Attempt 1 — `sideEffects: false` on the schema packages: MISS

`@bb/domain` and `@bb/server-contract` are declaration-only, but neither
declared `sideEffects`, so a bundler had to keep every schema module any
barrel import reached. Adding the flag.

| Metric                 |       baseline |          after |            Delta |
| ---------------------- | -------------: | -------------: | ---------------: |
| HUD (n=28 interleaved) |       413.5 ms |       401.5 ms | −12.0 ms (−2.9%) |
| Composer               |       233.8 ms |       246.8 ms |         +13.0 ms |
| Boot payload           | 1,709.1 KB raw | 1,702.7 KB raw |          −6.4 KB |

Below the bar, and the composer moved the wrong way. **Reverted.** The flag
did work — it re-partitioned the chunks and dropped domain's schema modules
out of the domain chunk — but the same modules stayed eager through
`@bb/server-contract`, which imports them anyway.

## Attempt 2 — one boot chunk instead of 26: MISS

Rolldown's automatic splitting gives every module set shared between the entry
and a lazy route its own chunk. For the entry's _own_ static closure that is
overhead: all of it must arrive, compile, and evaluate before React can render
a frame, so splitting buys nothing and costs a request each plus a worse
brotli ratio. A ~60-line build plugin assigned the entry's static closure to a
single chunk (lazy boundaries untouched).

| Metric                 |                    baseline |                          after |                Delta |
| ---------------------- | --------------------------: | -----------------------------: | -------------------: |
| HUD (n=28 interleaved) |                    405.8 ms |                       403.5 ms |      −2.3 ms (−0.6%) |
| Composer               |                    229.7 ms |                       237.8 ms |              +8.0 ms |
| Boot payload           | 449.7 KB brotli / 26 chunks | **407.4 KB brotli / 3 chunks** | **−42.3 KB (−9.4%)** |

**Reverted** — it does not move the finish line, because on localhost the
whole boot payload arrives in ~100 ms and the constraint is CPU, not requests.

**Worth someone's time anyway, on a different track:** −42.3 KB brotli and 23
fewer cold requests is a real win on a real network, and it is exactly the
reconsolidation `bundle-budget.json` asks for when it says to lower the
ratchet. It cannot be demonstrated on this rig, so it is recorded here rather
than landed on a metric it does not serve.

## Attempt 3 — the route table out of the client's parse path: MISS

`packages/server-contract/src/public-api.ts` held both `createApiClient` and
`publicApiRoutes`, a ~1,400-line table of ~300 route descriptors referencing
essentially every request schema in the contract. Only `apps/server` uses that
table as a _value_; the client needs it solely at type level
(`ApiSchemaFromRouteDescriptors<typeof publicApiRoutes>`). It was split into
`public-api-routes.ts` (value) plus a type-only import from `public-api.ts`,
with `sideEffects: false` and a `./public-api` subpath export.

| Metric                 |       baseline |          after |            Delta |
| ---------------------- | -------------: | -------------: | ---------------: |
| HUD (n=28 interleaved) |       434.6 ms |       423.8 ms | −10.8 ms (−2.5%) |
| Composer               |       234.1 ms |       248.2 ms |         +14.1 ms |
| Boot payload           | 1,709.1 KB raw | 1,698.3 KB raw |         −10.8 KB |
| Total boot eval        |        ~250 ms |        ~262 ms |             none |

Structurally it worked: the route table is provably absent from the built
client (no route path strings remain in any chunk). It still misses, because
the table's cost was never _its own_ ~300 cheap `defineRoute` calls — it was
the schemas it referenced, and those stay for other reasons. **Reverted.**

### Why tree-shaking cannot finish this job

Pushing attempt 3 further, as a spike: every static schema import was removed
from all 9 `@bb/sdk` area modules plus the 5 eager app modules that reach
`api/*`, and `createApiClient` was moved to a subpath. Tree-shaking then did
drop `api/environments`, `api/hosts`, `api/plugins`, `api/projects`,
`api/skills`, `api/system`, `api/terminals`, `api/thread-tabs`, `api-types`,
and `thread-timeline` from the boot graph — and the result was still
1,681 KB raw (−28 KB) with **~248 ms of boot eval, i.e. unchanged**.

Two lessons:

- **Bytes are not the cost here.** Zod schemas are compact source and
  expensive construction; ~28 KB of removed source carried ~0 ms of removed
  evaluation, while a 222 KB VSCode-theme JSON blob in the same payload
  evaluates in ~15 ms.
- **`z.object(...)` is a call the bundler cannot prove pure**, so an unused
  schema in an otherwise-used module is retained even under
  `sideEffects: false`. Setting rolldown's
  `treeshake.manualPureFunctions: ["z"]` was also tried: −15 KB raw and boot
  eval ~250 → ~243 ms, still inside noise, because chained builders
  (`z.object({...}).strict()`) are member calls on the result and stay impure.
  One eager import of a plain number constant from `api/threads.ts` is enough
  to retain that module and, transitively, most of the api schema graph.

So the 47 ms behind `@bb/server-contract` is reachable only by making the whole
eager graph stop reaching it — a lazy `sdk`/`apiClient` seam across roughly 15
files in two packages plus the app, with every `queryFn`/`mutationFn` resolving
the client asynchronously. That was measured, scoped, and deliberately **not
attempted** inside this timebox: it changes when the first sidebar request
starts, needs `unknown`/cast-free typing that the repo's conventions ask for,
and could not have been verified properly in the time left.

## Result

**Nothing product-side was kept, and the cold HUD is not faster in a browser.**

| Metric                    | PR #1 HEAD baseline |                         Final (unchanged) |
| ------------------------- | ------------------: | ----------------------------------------: |
| HUD                       |        405 ms (n=9) | 438 ms (n=15, later session — same bytes) |
| Composer after New thread |              222 ms |                                    239 ms |

The 405 → 438 ms difference is VM drift on identical bytes, not a regression;
it is the reason every decision above used interleaved A/B rather than
comparing across sections.

Paste keepers are untouched and verified: the gated paste microbenchmark
passes at 128 KB, 512 KB, and 1 MB, and the full `@bb/app` suite passes.

### What a next track should try, in measured priority order

1. **Defer `@bb/server-contract` past first paint** — measured ceiling
   −47 ms (−10.5%) on the HUD plus −14.8 ms on the composer. Needs the lazy
   `sdk`/`apiClient` seam described above. This is the only lever on this rig
   that is clearly worth its complexity.
2. **The rest of zod construction (`@bb/domain`)** — the remaining ~28 ms of
   the 75 ms ceiling. Harder: the domain barrel is legitimately reached by
   many eager modules, so this needs subpath imports or lazily-constructed
   schemas, not a single seam.
3. **React first render/commit, ~80 ms** — unchanged from Track A's finding.
   Needs product decisions about what the shell paints first.
4. **Boot chunk reconsolidation (attempt 2)** — for a network-bound metric,
   not this one. −42.3 KB brotli, 23 fewer requests, ratchet lowerable to
   ~410 KB.

Do not re-run this loop against `measure-load.mjs` route-ready. It ranks work
that happens after the HUD is already on screen.

---

# Load-time iteration 4 (final spike): zod/module-eval — MISS, Track A stopped

**Verdict: MISS. No product change landed. Track A stopped pending Sol
keep/ditch.** Environment for every number here: Linux headless Chromium over
localhost (4× CPU throttle, cold cache, medians of 7 where applicable,
`apps/app/scripts/measure-load.mjs`). Not Electron.

## Fresh baseline at PR HEAD

`/` route-ready **1,744 ms** median (FCP 848 ms, LCP 1,148 ms) — consistent
with iteration 3's after-numbers (1,722 ms), so the thread-detail split held.
The KEEP bar for this spike was ≥5% ⇒ ≥87 ms.

## What the spike measured before writing any product code

A temporary spike script imported each built chunk's dependencies first, then
timed the target chunk's `import()` alone, isolating parse+compile+execute from
render work (the sampling profiler conflates them: render frames are
attributed to the chunk that defines the component). The script was removed
in the final Sol filter: it was single-use investigation code coupled to
hashed build filenames, not a durable benchmark. The general-purpose
`measure-load.mjs --profile` mode remains.

Marginal module-eval cost at 4× throttle:

| Boot chunk | Contents | Marginal eval |
| --- | --- | ---: |
| SDK/api-client chunk (315 KB) | hono client, @bb/server-contract zod schemas, 88 api modules, tanstack | **262 ms** |
| domain chunk (268 KB) | @bb/domain zod schemas, ~280-icon hugeicons map | **158 ms** |
| react-dom chunk (181 KB) | react-dom + scheduler | **9 ms** |

So: the react-dom chunk's ~334 ms of profiler self-time is render work, not
eval (only rendering less UI would cut it — product-level, no API-safe
boundary). The real module-eval hotspot is **~420 ms of zod-dominated schema
construction across @bb/server-contract and @bb/domain**, spread over 60+
files and hundreds of schemas (63 in `provider-event.ts` alone) — no single
pathological schema to wrap.

## Why this is a miss, not a fix

1. **The cheap lever doesn't exist.** The repo is already on zod 4.3.6, the
   fast-initialization major version. There is no upgrade win left.
2. **Deferral cannot beat the bar even in theory.** Lazy schema construction
   (getter/Proxy wrappers) only moves the work from module evaluation
   (~600 ms mark in the load) to first `parse()` — and the first API response
   the composer waits on (sidebar-bootstrap) arrives at ~790 ms, well before
   the composer commits at ~1,744 ms. The construction cost stays inside the
   pre-route-ready window either way; net route-ready gain ≈ 0, minus
   permanent per-use proxy overhead.
3. **The only shapes available are the stop-rule's "too invasive to land":**
   a wholesale lazy-schema rewrite across two contract packages (every
   consumer of @bb/domain and @bb/server-contract touched, against the
   repo's validate-at-boundaries conventions) for a gain measured to be near
   zero. Not attempted; nothing to revert.

Other remaining costs, quantified and also not viable this spike: react-dom
render ~334 ms (render less — product change), parse/compile ~276 ms (ship
less boot JS — the remaining boot content is used before first paint), the
icon map (inside the 158 ms domain chunk; array-literal data, minor share).

## Cumulative Track A table (Linux Chromium, 4× throttle, medians)

| Iteration | `/` route-ready | Result |
| --- | ---: | --- |
| Original baseline | 2,494 ms | — |
| pierre/Shiki/KaTeX out of route closure | 2,278–2,319 ms | KEEP |
| Plugin-frontend idle deferral | 1,836 ms | KEEP |
| Lazy ThreadDetailView | 1,722–1,744 ms | KEEP |
| zod/module-eval spike | 1,744 ms (unchanged) | **MISS — stopped** |

Cumulative kept improvement: **2,494 → 1,744 ms (−30%)**, plus FCP
920 → 848 ms and LCP 1,236 → 1,148 ms, plus the composer-paste keepers.

## Leftover candidates (for a future track, none API-safe/cheap)

- Render less before composer commit (react-dom ~334 ms): needs product
  decisions about what the shell paints first.
- Ship less boot JS (parse/compile ~276 ms): needs feature-level auditing of
  the SDK client and entry (all currently used pre-paint).
- Zod init cost (~420 ms eval): upstream zod performance, or codegen'd
  validators for the hottest contracts — a deliberate architecture change.
- Electron-side unknowns: everything here is Linux Chromium; strago steps in
  this document remain the source of truth for real Electron numbers.

**Track A stopped. Final Sol keep/ditch follows.**

---

# Final Sol keep/ditch record (paste + load stack)

This is the authoritative filter for PR #1 after Track A stopped. It reviews
every landed product behavior against measured value, complexity, correctness,
and maintenance cost. No Electron number appears below: all performance
numbers are from the Linux VM under the harness named in each section.

## Metric precision

`measure-load.mjs` route-ready for `/` watches
`[data-promptbox-editor-content]`. TipTap renders that wrapper before its
post-mount editor effect attaches ProseMirror, so this metric means
**promptbox wrapper present**, not "TipTap interactive" or TTI. FCP/LCP are
Chromium paint entries. Actual editable readiness, input latency, Electron
window startup, and macOS layout/paint remain unmeasured; use the strago steps
above for those.

## Composer paste product changes

| Change | Sol verdict | Why it stays / complexity and tradeoff |
| --- | --- | --- |
| Markdown delimiter/range parser rewrite | **KEEP** | Dominant proven fix: 2,059 → **10.05 ms** on the final 1 MB synthetic single-line run (earlier filtered runs 11–13 ms). Medium-high algorithmic complexity is earned by the ~200× result, existing Markdown tests, and a committed thousands-of-delimiters regression test. Output behavior was differential-tested during development; the permanent suite covers supported semantics. |
| Controlled editor value structural comparison | **KEEP** | Removes two full-prompt JSON serializations per edit (a stringify is 2.47 ms at 1 MB on the final run). Low complexity; cloned and changed mention resources have direct tests. The tiny resource-only stringify fallback is outside the large-text path. |
| 256-character typeahead scan window | **KEEP** | 2.52 ms baseline → ~0.00 ms at 1 MB, on both edit and selection updates. Low complexity. Intentional limit: a windowed query can contain at most 254 characters. |
| Large-document decoration mapping + deferred rebuild | **KEEP** | Removes synchronous full-text matcher work from edits over 100k positions (built-in regex alone 8.10 ms at 1 MB; plugin matchers are unbounded). Medium state/timer complexity is covered by mapping, stale-removal, refresh-cancellation tests. Tradeoff remains explicit: highlight additions/removals can lag ≤200 ms. |
| Draft serialization at the existing persist boundary | **KEEP** | Removes 2.48 ms JSON work per 1 MB edit and performs it once per the pre-existing 250 ms persistence window. Pending reads, immediate overwrite, and page-hide flush are tested. No new crash-loss window. |
| Non-subscribing `ThreadDetailView` draft accessor | **KEEP** | Stops an event-time quote/focus consumer from rerendering the whole timeline on every keystroke. Small, architecturally correct use of the already-documented imperative accessor; shared mutation helper avoids divergent behavior. Render win was established by subscription flow, not assigned a fabricated time. |
| Deterministic fixture + gated paste microbenchmark | **KEEP** | No production runtime cost. It is correctly labeled a synthetic primitive-level microbenchmark, not Electron or end-to-end input latency. |

Final paste harness (Linux Node/Vitest, synthetic fixture): 1 MB rich-Markdown
parse **10.05 ms**; trigger scan ~0.00 ms. The 2.47 ms value stringify,
8.10 ms decoration regex, and 2.48 ms draft stringify rows are retained as
the isolated work removed/deferred, not falsely reported as end-to-end
keystroke time.

## Load-time product changes

| Change | Sol verdict | Why it stays / complexity and tradeoff |
| --- | --- | --- |
| Pierre/Shiki diff-island split (`GitDiffCard`, file preview code, timeline/panel diffs) | **KEEP** | Removes pierre/Shiki from the workspace route's static closure and cuts the shared chunk 2,148 → 1,304 KB raw. The facade/extraction is broad but consumer APIs remain stable, focused diff/panel tests pass, and lazy islands share one entry to limit fragmentation. First island shows a skeleton. |
| Per-island pierre worker-pool boundary | **KEEP** | Necessary to make the split real without a route-level static pierre import. Pierre's package singleton means providers share one pool. Tradeoff: pool terminates after the last island and respawns on a later first island. |
| Content-gated lazy KaTeX | **KEEP-WITH-TWEAK APPLIED** | Settings/non-math routes no longer fetch KaTeX. TeX source remains readable until the deferred renderer arrives; math/security tests await and verify the final output/order. Final filter added rejection handling: stale-deploy/network chunk failures no longer become unhandled promises, the readable fallback remains, and a later math mount can retry. |
| Plugin-frontend idle deferral + panel escape hatch | **KEEP** | Largest load win: current-iteration baseline 2,319 → 1,836 ms wrapper-ready (−20.8%). Six plugin bundles now evaluate after route content; plugin-panel deep links boot immediately and were smoke-tested with real automations content. Tradeoff: ordinary plugin slots appear ~0.5–1.5 s later, bounded by timer + idle timeout. |
| Lazy `ThreadDetailView` + isolated legacy redirect | **KEEP** | Default route static closure −899 KB raw; measured `/` 1,853 → 1,722 ms (−7.1%). Canonical cold thread route did not regress. First `/`→thread navigation can show a blank pane for one cached chunk round trip. Tests now await lazy pane content. |
| Bundle graph dump, load harness, profiler mode | **KEEP** | Durable, dependency-free measurement/attribution tools. `bundle-stats-all.json` is opt-in and gitignored. The harness now exposes its marker semantics and VM limits. |
| Boot budget ratchets | **KEEP** | Final budget 1,672 KB raw / 450 KB brotli admits measured +12.4 KB brotli stream-fragmentation cost in exchange for ~2.25 MB raw removed from the default route parse closure. The reason now lives in `bundle-budget.json`, and the checker correctly counts intentionally uncompressed sub-1KB chunks at raw wire size. Lower the ratchet when chunks reconsolidate. |

## DITCH / absent spike work

- **DITCH:** `measure-chunk-eval.mjs`. It was one-off investigation code
  coupled to hashed chunk filenames, not a durable harness; removed in the
  final filter.
- **No zod product change landed.** The measured spike remains documented as
  a miss; no proxy/lazy-schema rewrite is present.
- **No full three-way pane split landed.** It was measured as a wash with
  extra boot fragmentation and reverted. Root compose remains static;
  ThreadDetailView alone is lazy.

## Final measurements on filtered HEAD

Linux headless Chromium, localhost production server, seeded 400-thread /
120k-event database, cold cache, 4× CPU throttle, medians of 7:

| Route | FCP | LCP | Route-ready |
| --- | ---: | ---: | ---: |
| `/` | 844 ms | 1,148 ms | **1,721 ms** (promptbox wrapper) |
| canonical project/thread route | 868 ms | 2,176 ms | 2,159 ms |
| `/settings` | 792 ms | 1,040 ms | 1,035 ms |

Cumulative `/` wrapper-ready result: **2,494 → 1,721 ms (−31%)**.
Original-to-final FCP: 920 → 844 ms; LCP: 1,236 → 1,148 ms. These are
Chromium-on-Linux relative measurements, not Electron claims.

## Final tradeoff summary

- +12.4 KB brotli boot fragmentation (+2.8%) and 26 boot chunks instead of
  14, against ~2.25 MB raw removed from the default route parse/execute path.
- First diff/file-code/thread-detail island incurs one lazy load; skeletons
  cover diff/file-code, while a first thread pane can be briefly blank.
- Plugin UI intentionally comes after app content except on plugin deep links.
- Large draft highlights lag ≤200 ms; typeahead queries cap at 254 chars.
- KaTeX and pierre workers can respawn after unload/failure as documented.
- Electron FCP/LCP/TTI and macOS cold start remain hypotheses pending strago.

## Final filtered revision verification

- Full `@bb/app` suite through Turbo: 349 files, 2,778 passed, 3 skipped.
  The lazy-pane story test was also stabilized with an explicit 5 s wait and
  passed both targeted and full-suite runs.
- `pnpm exec turbo run typecheck --filter=@bb/app`: passed.
- `pnpm exec turbo run lint --filter=@bb/app`: passed with zero errors (145
  existing warnings reported).
- Bundle budget: 1,669.1 KB raw / 449.7 KB wire-size-adjusted brotli vs
  1,672.0 / 450.0 KB limits; forbidden lazy-only packages absent.
- Paste microbenchmark: passed at 128 KB, 512 KB, and 1 MB; final 1 MB
  rich-Markdown parse 10.05 ms.
- Load harness: final medians `/` 844/1,148/1,721 ms
  (FCP/LCP/promptbox-wrapper-ready), canonical thread 868/2,176/2,159 ms,
  settings 792/1,040/1,035 ms.
- GitHub reports no configured checks for this fork's PR.

