// Minimal Chrome DevTools Protocol client for the perf harness. The shell is
// launched with --remote-debugging-port=0; Chromium then writes the chosen
// port to <user-data-dir>/DevToolsActivePort. Uses Node's built-in WebSocket.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function waitForDevtoolsPort(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
      const port = Number(text.split("\n")[0]);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch {
      // File not written yet.
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for DevToolsActivePort");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  }
  return await response.json();
}

export async function waitForPageTarget(port, matcher, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targets = await listTargets(port);
    const target = targets.find(
      (candidate) => candidate.type === "page" && matcher(candidate.url),
    );
    if (target !== undefined) {
      return target;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for page target; saw: ${targets
          .map((t) => `${t.type}:${t.url}`)
          .join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function connectToTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("CDP WebSocket connection failed")),
      { once: true },
    );
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    let parsed;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const { reject, resolve } = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error !== undefined) {
        reject(new Error(`CDP ${parsed.error.message ?? "error"}`));
      } else {
        resolve(parsed.result);
      }
    }
  });

  return {
    close() {
      socket.close();
    },
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    /** Runtime.evaluate with sane defaults; returns the deserialized value. */
    async evaluate(expression, { awaitPromise = false } = {}) {
      const result = await this.send("Runtime.evaluate", {
        awaitPromise,
        expression,
        returnByValue: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(
          `page evaluate failed: ${result.exceptionDetails.text} ${
            result.exceptionDetails.exception?.description ?? ""
          }`,
        );
      }
      return result.result.value;
    },
  };
}
