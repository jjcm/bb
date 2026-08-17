import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPerfHarness } from "../src/perf-harness.js";

function createStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdout.on("data", (chunk: Buffer) => {
    written.push(chunk.toString("utf8"));
  });
  return { stdin, stdout, written };
}

describe("createPerfHarness", () => {
  it("is inert without BB_DESKTOP_PERF_HARNESS=1", () => {
    const { stdin, stdout, written } = createStreams();
    const harness = createPerfHarness({
      env: {},
      streams: { stdin, stdout },
    });
    const commands: string[] = [];
    harness.onCommand((command) => commands.push(command));
    harness.mark("app-ready");
    stdin.write("open-window\n");

    expect(harness.enabled).toBe(false);
    expect(written).toEqual([]);
    expect(commands).toEqual([]);
    // The disabled harness must not hold stdin open (no data listener).
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("emits marks as JSON lines when enabled", () => {
    const { stdin, stdout, written } = createStreams();
    const harness = createPerfHarness({
      env: { BB_DESKTOP_PERF_HARNESS: "1" },
      streams: { stdin, stdout },
    });
    harness.mark("app-ready");

    expect(harness.enabled).toBe(true);
    expect(written).toHaveLength(1);
    const parsed: unknown = JSON.parse(written[0]);
    expect(parsed).toMatchObject({ bbPerf: "app-ready" });
    expect((parsed as { tMs: number }).tMs).toBeTypeOf("number");
  });

  it("parses stdin commands across chunk boundaries", () => {
    const { stdin, stdout } = createStreams();
    const harness = createPerfHarness({
      env: { BB_DESKTOP_PERF_HARNESS: "1" },
      streams: { stdin, stdout },
    });
    const commands: string[] = [];
    harness.onCommand((command) => commands.push(command));

    stdin.write("open-");
    stdin.write("window\nsecond");
    stdin.write("-command\n\n  \n");

    expect(commands).toEqual(["open-window", "second-command"]);
  });
});
