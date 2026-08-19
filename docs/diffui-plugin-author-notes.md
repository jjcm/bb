# DiffUI plugin author notes

Notes for the `diffui-bb` plugin (lives in
[jjcm/diffui](https://github.com/jjcm/diffui) at `extensions/diffui-bb`,
installed with `bb plugin install https://github.com/jjcm/diffui
--subdirectory extensions/diffui-bb`). This page names the exact bb APIs each
product flow should use, so the plugin never needs private hooks or a fork of
bb. The general authoring reference is the built-in `bb-plugin-authoring`
skill; the authoritative contracts are
[`packages/plugin-sdk/src/backend-contract.ts`](../packages/plugin-sdk/src/backend-contract.ts)
and
[`packages/plugin-sdk/src/app-contract.ts`](../packages/plugin-sdk/src/app-contract.ts).

**Verdict: the current plugin SDK supports the whole product.** The one core
change made for this integration is `experimental_cors` on plugin HTTP routes
(SDK 0.4.9), which lets the DiffUI web app complete a browser CORS exchange
against the local bb server. Everything else below is existing, shipped API.

## 1. A native DiffUI canvas inside bb

Register a `navPanel` in `app.tsx` — it owns the whole route at
`/plugins/diffui-bb/<path>/*` and renders ordinary React (the canvas is your
bundled code running same-origin in the bb app; there is no iframe and no CSP
restriction on the page). Deep links land in the component as `subPath`, and
`useBbNavigate().toPluginPanel(path, { subPath })` navigates within the panel
with working browser history — use one canvas per subPath (e.g.
`canvas/<canvasId>`).

- Per-thread canvas: `app.slots.threadPanelAction` opens a tab in a thread's
  side panel with persisted JSON `params` (put the canvas id there); the same
  action id is reachable from message actions and
  `useBbNavigate().openThreadPanel`. Use `layout: "flush"` — a canvas owns its
  own scrolling. `app.slots.experimental_newThreadPanelAction` is the
  compose-screen counterpart.
- Data plane: the frontend calls the plugin backend with `useRpc`
  (`bb.rpc.register` server-side); the backend holds the DiffUI API key as a
  secret setting (`bb.settings.define({ apiKey: { type: "string", secret:
true } })`) and talks to DiffUI's API server-side. Push canvas updates to
  open windows with `bb.realtime.publish(channel, payload)` +
  `useRealtime(channel, handler)`; signals are ephemeral, so refetch via rpc
  on `useRealtimeConnectionState()` transitions to `"connected"`.
- Remote images: `<img src="https://cdn.diffui...">` works directly. If the
  canvas needs pixel access (WebGL/canvas `drawImage` taint rules) and the
  DiffUI CDN does not serve CORS headers, proxy bytes through a plugin HTTP
  route (`bb.http.route("GET", "/image", handler)` — default `"local"` auth
  is exactly right for the plugin's own frontend).

## 2. "Build with bb" from inside the bb canvas

The frontend sends `{ canvasId, selection }` to its own rpc; the backend
assembles the thread:

```ts
// server.ts — rpc handler
const bytes = await fetchDiffuiImage(args); // server-side fetch, no CORS
const attachment = await bb.sdk.projects.attachments.upload({
  projectId,
  clientFile: bytes, // Uint8Array | ArrayBuffer | Blob | File-like
  filename: "canvas.png",
  mimeType: "image/png",
}); // → { type: "localImage", path, ... } — image ≤10MB, other files ≤25MB

const thread = await bb.sdk.threads.spawn({
  projectId,
  environment, // see below
  title: `Build: ${design.name}`,
  input: [
    { type: "text", text: userVisibleBrief, mentions: [] },
    { type: "localImage", path: attachment.path },
    // Structured brief the agent sees but the user-facing transcript hides:
    {
      type: "text",
      text: JSON.stringify(brief),
      mentions: [],
      visibility: "agent-only",
    },
  ],
}); // origin: "plugin" + originPluginId are auto-filled — keep them
```

- **“The current project/worktree”:** `environment` is
  `{ type: "reuse", environmentId }` to build in an existing worktree (get the
  id from the thread context or `bb.sdk.threads.get`),
  `{ type: "host", hostId, workspace: { type: "managed-worktree", baseBranch } }`
  for a fresh branch, or `{ type: "project-default" }` to let the server apply
  compose-screen policy. Do not re-derive defaulting yourself.
- **Navigation:** the frontend that called the rpc navigates with
  `useBbNavigate().toThread(thread.id)`. From backend-only flows use
  `bb.sdk.threads.open({ threadId, file: null })` — it broadcasts bb's
  `thread-open` signal and every connected window navigates (returns
  `{ delivered }`; fall back to a toast/link when false).
- **Full compose UX:** if the user should pick provider/model/branch, render
  the host-owned `experimental_NewThreadComposer` in the panel and forward its
  `NewThreadRequest` verbatim to `threads.spawn` (see `examples/plugins/cascade`).
- **Follow-ups:** send more context into a running thread with
  `bb.sdk.threads.send({ threadId, mode: "auto", input })`.

## 3. "Build with bb" from the DiffUI web app

The context-menu flow in the DiffUI app itself needs an inbound path into the
user's local bb. Three shapes, beyond the trivial one for non-browser callers
(the DiffUI desktop/CLI can simply POST with the token header):

1. **Direct browser call (recommended):** register a token route with a CORS
   declaration —

   ```ts
   bb.http.route("POST", "/build", handler, {
     auth: "token",
     experimental_cors: { origins: ["https://diffui.com"] },
   });
   ```

   The host answers the CORS preflight and stamps
   `Access-Control-Allow-Origin` for the declared origins on this route, so
   `fetch("http://127.0.0.1:<port>/api/v1/plugins/diffui-bb/http/build", …)`
   from the DiffUI page gets a readable response (including a readable 401 —
   render "reconnect to bb" instead of a blind failure). Pairing: the plugin
   backend reads its own token with
   `bb.sdk.plugins.token({ pluginId: bb.pluginId })` and the port from
   `bb.server.loopbackBaseUrl`, shows a copyable pairing string (or pushes it
   to the user's DiffUI account server-side), and the DiffUI app stores it.
   Browser caveat: Chromium's Local Network Access asks the user once before a
   public site may call loopback; handle the denial with the fallback below.

2. **Cloud relay (no inbound connection at all):** a
   `bb.background.service` holds an outbound long-poll/WS to DiffUI's API and
   receives build requests the web app filed there — the `slack-bot` example's
   Socket-Mode shape. Most robust across browsers/networks; requires DiffUI
   cloud to broker.
3. **Deep link:** open
   `http://127.0.0.1:<port>/plugins/diffui-bb/build/<payload-ref>` in a new
   tab — the nav panel parses `subPath`, calls the rpc, and the tab IS bb,
   already on the new thread. No CORS involved; right when "Build with bb"
   should land the user in bb anyway.

In every shape the handler ends the same way: upload attachments → `spawn` →
`threads.open`. Verify payload authenticity (token auth, or an HMAC signature
with `auth: "none"` like `examples/plugins/slack-bot`); never trust a
projectId/path from the wire without checking it exists via `bb.sdk`.

## 4. Extras worth shipping

- **@-mention DiffUI canvases:** `bb.ui.registerMentionProvider({ id:
"canvas", label: "DiffUI", search, resolve })`. `resolve` returns text-only
  agent context — include the canvas brief plus stable image URLs, and pair it
  with the agent tool below for pixels. `useComposer().insertMention(...)`
  inserts pills programmatically from plugin UI.
- **Agent tool for canvas images:** `bb.agents.registerTool` returning
  `{ content: [{ type: "image", data: base64, mimeType }, ...] }` (e.g.
  `diffui_get_canvas`), so an agent can pull the design mid-thread. Gate it to
  relevant threads with `bb.agents.configure` and ship a `skills/` entry
  telling agents when to call it.
- **Deep links thread ↔ canvas:** store `{ threadId ↔ canvasId }` in
  `bb.storage.kv` when spawning. Canvas → thread: `toThread(threadId)`.
  Thread → canvas: a `threadPanelAction` (side-by-side) or
  `toPluginPanel("canvas", { subPath: canvasId })` (full page); a
  `messageDirective` (`::diffui-canvas{id="…"}`) renders a canvas card inside
  assistant messages.
- **Status back to DiffUI:** `bb.events.on("thread.idle" | "thread.failed",
…)` on spawned threads, then notify DiffUI's API server-side — the same
  reply loop as the slack-bot example.

## 5. Caps and gotchas that will bite this plugin

- Attachments: images ≤10MB, files ≤25MB, no list/delete API. `localImage`
  relative paths are server-managed references scoped to the project you
  uploaded into — upload and spawn with the same `projectId`.
- `bb.storage.kv` values ≤256KB; canvas caches belong in
  `bb.storage.database()`.
- Mention `search` is time-boxed at 2s and `resolve` runs at send time — a
  throw blocks the user's send, so degrade to a stale cached brief instead.
- Realtime signals are broadcast to every window and not replayed.
- Tool-set and instruction changes apply at the next provider session start,
  never mid-session.
- Settings saves do not auto-reload a healthy plugin; read settings inside
  handlers (`await settings.get()` per request), not once at load.
- Cross-origin: only `"token"`/`"none"` routes may declare
  `experimental_cors`; origins are exact (`https://diffui.com`, no wildcards);
  CORS preflights are host-owned, so don't register OPTIONS handlers for them.

## 6. What not to build

- No iframe of DiffUI inside bb, and no iframe of bb inside DiffUI — the
  canvas is native plugin React; the reverse direction is a deep link.
- No hand-rolled thread composer or chat view — use
  `experimental_NewThreadComposer` and `ThreadChat`.
- No second event/permission system — thread lifecycle is `bb.events.on`, and
  auth is the plugin token (rotate with `bb plugin token diffui-bb --rotate`).
- No writes through `bb.sdk.system`/`bb.sdk.plugins` for plugin-own state —
  that is what `bb.settings` and `bb.storage` are for.
