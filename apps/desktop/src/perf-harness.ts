/**
 * Opt-in perf instrumentation for the desktop shell, used by the harness under
 * `apps/desktop/perf/`. Enabled only when BB_DESKTOP_PERF_HARNESS=1 — like
 * BB_DESKTOP_ATTACH_WITHOUT_PROMPT it is a deliberate, harness-only knob that
 * the app never sets itself.
 *
 * When enabled, the shell emits milestone marks as JSON lines on stdout
 * (`{"bbPerf":"app-ready","tMs":<epoch ms>}`) and accepts newline-delimited
 * commands on stdin (currently `open-window`), so a harness can measure the
 * real window-factory path without simulating native menu input.
 */

export interface PerfHarnessStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export interface CreatePerfHarnessArgs {
  env: NodeJS.ProcessEnv;
  streams: PerfHarnessStreams;
}

export interface PerfHarness {
  readonly enabled: boolean;
  mark(name: string): void;
  onCommand(handler: (command: string) => void): void;
}

export function isPerfHarnessEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.BB_DESKTOP_PERF_HARNESS === "1";
}

export function createPerfHarness(args: CreatePerfHarnessArgs): PerfHarness {
  const enabled = isPerfHarnessEnabled(args.env);

  if (!enabled) {
    return {
      enabled,
      mark() {},
      onCommand() {},
    };
  }

  const handlers: Array<(command: string) => void> = [];
  let buffered = "";
  // A plain "data" listener instead of readline: it must not throw when the
  // harness closes stdin, and nothing else in the shell reads stdin.
  args.streams.stdin.setEncoding("utf8");
  args.streams.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const command = line.trim();
      if (command.length === 0) {
        continue;
      }
      for (const handler of handlers) {
        handler(command);
      }
    }
  });

  return {
    enabled,
    mark(name) {
      args.streams.stdout.write(
        `${JSON.stringify({ bbPerf: name, tMs: Date.now() })}\n`,
      );
    },
    onCommand(handler) {
      handlers.push(handler);
    },
  };
}
