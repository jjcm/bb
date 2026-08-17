import type { ReactNode } from "react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import {
  createDiffWorker,
  getDiffWorkerPoolSize,
} from "@/lib/diff-worker-pool";
import { useResolvedCodeThemePair } from "@/lib/code-theme";
import { useSyncPierreWorkerPoolTheme } from "@/lib/pierre-worker-pool-theme";

const WORKER_POOL_OPTIONS = {
  workerFactory: createDiffWorker,
  poolSize: getDiffWorkerPoolSize(),
};

function PierrePoolThemeSync() {
  useSyncPierreWorkerPoolTheme();
  return null;
}

/**
 * Wraps one lazily loaded diff island (diff card, file preview code view)
 * with the shared `@pierre/diffs` worker pool.
 *
 * The pool used to be provided once near the top of the workspace route,
 * which forced `@pierre/diffs` + Shiki (~1.4 MB raw) into the route's static
 * chunk and onto every session's first paint. Each island now provides the
 * pool itself, so pierre loads only when a diff actually renders. The pool is
 * a package-level singleton (`getOrCreateWorkerPoolSingleton` inside
 * `WorkerPoolContextProvider`), so N mounted islands still share one pool;
 * pierre terminates it when the last provider unmounts and recreates it on
 * the next mount.
 */
export function PierrePoolBoundary({ children }: { children: ReactNode }) {
  const theme = useResolvedCodeThemePair();
  if (typeof Worker === "undefined") {
    return children;
  }
  return (
    <WorkerPoolContextProvider
      poolOptions={WORKER_POOL_OPTIONS}
      highlighterOptions={{ theme }}
    >
      <PierrePoolThemeSync />
      {children}
    </WorkerPoolContextProvider>
  );
}
