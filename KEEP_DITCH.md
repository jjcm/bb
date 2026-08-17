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
| `/` route-ready (composer present) | 2,494 ms | 2,278 ms | −216 ms (−8.7%) |
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
| `/` route-ready (composer present) | 2,319 ms | **1,836 ms** | **−483 ms (−20.8%)** |
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

## Filtered revision verification

- Targeted composer/draft regression tests: 162 passed.
- Full `@bb/app` suite through Turbo: 349 files, 2,778 passed, 3 skipped.
- `pnpm exec turbo run typecheck --filter=@bb/app`: passed.
- `pnpm exec turbo run lint --filter=@bb/app`: passed with zero errors (145
  existing warnings reported).
- Gated synthetic microbenchmark: passed at 128 KB, 512 KB, and 1 MB.
- GitHub reports no configured checks for this fork's PR.

