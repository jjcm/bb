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

