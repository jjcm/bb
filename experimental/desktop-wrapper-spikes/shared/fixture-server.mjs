// Local HTTP server for the wrapper spikes: serves the shared fixture page and
// collects page-side reports. Exported for the compare orchestrator; also
// runnable standalone (`node fixture-server.mjs`) for manual poking.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sharedDir = dirname(fileURLToPath(import.meta.url));

export async function startFixtureServer() {
  const fixtureHtml = await readFile(join(sharedDir, "fixture.html"), "utf8");
  const waiters = new Map();
  const reports = new Map();

  function reportKey(runId, win) {
    return `${runId}:${win}`;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/fixture.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(fixtureHtml);
      return;
    }
    if (url.pathname === "/report" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const key = reportKey(
          url.searchParams.get("run") ?? "no-run",
          url.searchParams.get("win") ?? "1",
        );
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = { error: "unparseable report body" };
        }
        reports.set(key, parsed);
        waiters.get(key)?.forEach((resolve) => resolve(parsed));
        waiters.delete(key);
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    port: address.port,
    url: `http://127.0.0.1:${address.port}/fixture.html`,
    waitForReport(runId, win, timeoutMs) {
      const key = reportKey(runId, String(win));
      const existing = reports.get(key);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = waiters.get(key);
          if (pending !== undefined) {
            waiters.set(
              key,
              pending.filter((entry) => entry !== wrapped),
            );
          }
          reject(
            new Error(`timed out after ${timeoutMs}ms waiting for ${key}`),
          );
        }, timeoutMs);
        const wrapped = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.set(key, [...(waiters.get(key) ?? []), wrapped]);
      });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await startFixtureServer();
  console.log(`fixture server: ${fixture.url}`);
}
