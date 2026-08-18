// Harness server for the desktop perf runner. Plays two roles on one port:
//
//  1. Stub bb server: answers `/health` and `/api/v1/system/config` the way
//     `server-probe.ts` expects, so the real shell attaches to it instead of
//     spawning a bb-app runtime (same trick as scripts/smoke-packaged-app.mjs).
//  2. Fixture host: serves perf-page.html (loaded via BB_DESKTOP_APP_URL) and
//     collects the page's startup reports. Reports are tagged by arrival
//     order, because every window of a run loads the identical URL.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const perfDir = dirname(fileURLToPath(import.meta.url));

export async function startPerfServer({ dataDir }) {
  const pageHtml = await readFile(join(perfDir, "perf-page.html"), "utf8");
  let reports = [];
  let waiters = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/v1/system/config") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          dataDir,
          hostDaemonPort: 38_887,
          keybindings: [],
          voiceTranscriptionEnabled: false,
        }),
      );
      return;
    }
    if (url.pathname === "/" || url.pathname === "/perf-page.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml);
      return;
    }
    if (url.pathname === "/perf/report" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = { error: "unparseable report body" };
        }
        reports.push(parsed);
        waiters.forEach((entry) => entry());
        waiters = [];
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("perf server did not bind a TCP port");
  }

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    port: address.port,
    resetReports() {
      reports = [];
    },
    url: `http://127.0.0.1:${address.port}`,
    async waitForReport(index, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (reports.length > index) {
          return reports[index];
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out after ${timeoutMs}ms waiting for report #${index}`,
          );
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 250);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}
