import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { File as PierreFile, useWorkerPool } from "@pierre/diffs/react";
import type { FileOptions } from "@pierre/diffs/react";
import { DIFFS_TAG_NAME, type SelectedLineRange } from "@pierre/diffs";
import { usePierreLineSelectionActions } from "@/components/git-diff/PierreLineSelectionActions.js";
import { PierrePoolBoundary } from "@/components/git-diff/PierrePoolBoundary";
import { usePreferredTheme } from "@/hooks/useTheme";
import { useResolvedCodeThemePair } from "@/lib/code-theme";
import type { FilePreviewLineRange } from "@/lib/file-preview";
import type { CodeOverflowMode } from "@/lib/code-overflow-mode";
import type { FilePreviewFile } from "./FilePreview";
import { FilePreviewLoading } from "./FilePreviewLoading";

/**
 * The pierre-rendered code view of the file preview, split out of
 * FilePreview.tsx: this module (and only this module of the preview) drags
 * the full `@pierre/diffs` + Shiki closure, so it loads lazily via the
 * `React.lazy` boundary in FilePreview and provides its own worker pool.
 */

interface FilePreviewCodeProps {
  file: FilePreviewFile;
  lineOverflowMode: CodeOverflowMode;
  lineRange: FilePreviewLineRange | null;
  onSelectionAddToChat?: (text: string) => void;
  path: string;
}

interface FilePreviewWorkerPoolStats {
  managerState: "waiting" | "initializing" | "initialized";
  workersFailed: boolean;
  totalWorkers: number;
  busyWorkers: number;
  queuedTasks: number;
  activeTasks: number;
  themeSubscribers: number;
  fileCacheSize: number;
  diffCacheSize: number;
}

const FILE_PREVIEW_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
  // Pierre paints its theme bg inside this gap, so the top breathing room of
  // the code body lives on Pierre's bg — not on the panel's bg-background.
  // Without this, the gap above Pierre would show a visible bg-color seam.
  "--diffs-gap-block": "16px",
} as CSSProperties;

function getPreviewTargetRoots(container: HTMLElement): ParentNode[] {
  const roots: ParentNode[] = [container];
  // Pierre owns its rendered line elements inside an open shadow root, which
  // normal descendant queries on the React wrapper cannot cross.
  for (const pierreContainer of container.querySelectorAll<HTMLElement>(
    DIFFS_TAG_NAME,
  )) {
    if (pierreContainer.shadowRoot !== null) {
      roots.push(pierreContainer.shadowRoot);
    }
  }
  return roots;
}

function clearPreviewTargetLine(container: HTMLElement) {
  for (const root of getPreviewTargetRoots(container)) {
    const targetLines = root.querySelectorAll(
      "[data-file-preview-target-line]",
    );
    for (const targetLine of targetLines) {
      targetLine.removeAttribute("data-file-preview-target-line");
      targetLine.removeAttribute("data-selected-line");
    }
  }
}

function findPreviewTargetLine(
  container: HTMLElement,
  lineNumber: number,
): HTMLElement | null {
  const roots = getPreviewTargetRoots(container);
  for (const root of roots) {
    const lines = root.querySelectorAll(`[data-line="${lineNumber}"]`);
    for (const line of lines) {
      if (line instanceof HTMLElement && line.dataset.lineIndex !== undefined) {
        return line;
      }
    }
  }
  for (const root of roots) {
    const lines = root.querySelectorAll(`[data-line="${lineNumber}"]`);
    for (const line of lines) {
      if (line instanceof HTMLElement) {
        return line;
      }
    }
  }
  return null;
}

function findPreviewScrollViewport(container: HTMLElement): HTMLElement | null {
  const view = container.ownerDocument.defaultView;
  if (view === null) return null;

  let candidate = container.parentElement;
  while (candidate !== null) {
    const overflowY = view.getComputedStyle(candidate).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function scrollPreviewTargetLine(
  container: HTMLElement,
  line: HTMLElement,
) {
  const viewport = findPreviewScrollViewport(container);
  if (viewport === null) return;

  const lineRect = line.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const lineCenter = lineRect.top + lineRect.height / 2;
  const viewportCenter = viewportRect.top + viewportRect.height / 2;
  // Adjust only the vertical scroll offset. `scrollIntoView()` can also move
  // the horizontal axis when a long source line extends beyond the viewport.
  viewport.scrollTop += lineCenter - viewportCenter;
}

function formatLineRange(startLineNumber: number, endLineNumber: number) {
  return startLineNumber === endLineNumber
    ? String(startLineNumber)
    : `${startLineNumber}-${endLineNumber}`;
}

function buildFilePreviewLineSelectionText({
  contents,
  path,
  range,
}: {
  contents: string;
  path: string;
  range: SelectedLineRange;
}): string | null {
  const startLineNumber = Math.max(1, Math.min(range.start, range.end));
  const endLineNumber = Math.max(
    startLineNumber,
    Math.max(range.start, range.end),
  );
  const lines = contents.split(/\r\n|\n|\r/);
  const selectedLines = lines.slice(startLineNumber - 1, endLineNumber);
  if (selectedLines.length === 0) {
    return null;
  }
  const selectedText = selectedLines.join("\n").trimEnd();
  if (selectedText.trim().length === 0) {
    return null;
  }
  return `${path}:${formatLineRange(startLineNumber, endLineNumber)}\n${selectedText}`;
}

function FilePreviewCode({
  file,
  lineOverflowMode,
  lineRange,
  onSelectionAddToChat,
  path,
}: FilePreviewCodeProps) {
  const preferredTheme = usePreferredTheme();
  const codeTheme = useResolvedCodeThemePair();
  const containerRef = useRef<HTMLDivElement>(null);
  const workerPool = useWorkerPool();
  const lastWorkerPoolStatsKeyRef = useRef<string | null>(null);
  const [workerPoolStats, setWorkerPoolStats] =
    useState<FilePreviewWorkerPoolStats | null>(null);
  const [, rerenderAfterWorkerPoolChange] = useState(0);
  const buildSelectionText = useCallback(
    (range: SelectedLineRange) =>
      buildFilePreviewLineSelectionText({
        contents: file.contents,
        path,
        range,
      }),
    [file.contents, path],
  );
  const lineSelectionActions = usePierreLineSelectionActions({
    buildSelectionText,
    containerRef,
    enabled: onSelectionAddToChat !== undefined,
    onSelectionAddToChat,
  });
  const options = useMemo<FileOptions<undefined>>(
    () => ({
      themeType: preferredTheme,
      theme: codeTheme,
      overflow: lineOverflowMode,
      disableFileHeader: true,
      enableGutterUtility: onSelectionAddToChat !== undefined,
      enableLineSelection:
        lineRange !== null || onSelectionAddToChat !== undefined,
      lineHoverHighlight:
        onSelectionAddToChat === undefined ? "disabled" : "number",
      onGutterUtilityClick:
        onSelectionAddToChat === undefined
          ? undefined
          : lineSelectionActions.onGutterUtilityClick,
      onLineSelectionChange: lineSelectionActions.onLineSelectionChange,
      onLineSelectionEnd: lineSelectionActions.onLineSelectionEnd,
      onLineSelectionStart: lineSelectionActions.onLineSelectionStart,
    }),
    [
      codeTheme,
      lineOverflowMode,
      lineRange,
      lineSelectionActions.onGutterUtilityClick,
      lineSelectionActions.onLineSelectionChange,
      lineSelectionActions.onLineSelectionEnd,
      lineSelectionActions.onLineSelectionStart,
      onSelectionAddToChat,
      preferredTheme,
    ],
  );
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (lineSelectionActions.selectedRange !== null) {
      return lineSelectionActions.selectedRange;
    }
    return lineRange === null
      ? null
      : {
          start: lineRange.startLineNumber,
          end: lineRange.endLineNumber,
        };
  }, [lineRange, lineSelectionActions.selectedRange]);
  const targetLineNumber = selectedLines?.start ?? null;

  useEffect(() => {
    if (!workerPool) {
      setWorkerPoolStats(null);
      return;
    }

    lastWorkerPoolStatsKeyRef.current = null;
    return workerPool.subscribeToStatChanges((stats) => {
      setWorkerPoolStats(stats);
      const statsKey = [
        stats.managerState,
        stats.workersFailed,
        stats.busyWorkers,
        stats.queuedTasks,
        stats.activeTasks,
        stats.fileCacheSize,
      ].join(":");
      if (lastWorkerPoolStatsKeyRef.current === statsKey) {
        return;
      }
      lastWorkerPoolStatsKeyRef.current = statsKey;
      rerenderAfterWorkerPoolChange((version) => version + 1);
    });
  }, [file.contents, file.name, workerPool]);

  const shouldWaitForWorkerPool =
    workerPool !== undefined &&
    workerPoolStats?.managerState !== "initialized" &&
    workerPoolStats?.workersFailed !== true;
  // Pierre can mount an empty zero-height <pre> while its worker highlighter is
  // still initializing, and the imperative instance does not always recover
  // when the highlighted AST is cached later. Wait for readiness, then remount
  // once the cache entry for this exact file appears so syntax highlighting
  // replaces the plain-text fallback.
  const workerHighlightCacheState =
    workerPool?.getFileResultCache(file) !== undefined
      ? "highlighted"
      : "plain";

  useEffect(() => {
    const cleanupContainer = containerRef.current;
    let animationFrame: number | null = null;
    let attempts = 0;

    // Retry on the next frame (the target line may not be in the DOM yet). One
    // rAF channel only: `scrollToLine` overwrites `animationFrame` on each
    // reschedule, so at most one callback is ever pending and cleanup cancels
    // it — no doubling or leaked stale callbacks marking the wrong line.
    function scheduleRetry() {
      animationFrame = window.requestAnimationFrame(scrollToLine);
    }

    function scrollToLine() {
      const container = containerRef.current;
      if (!container) return;
      clearPreviewTargetLine(container);
      if (targetLineNumber === null) return;

      const line = findPreviewTargetLine(container, targetLineNumber);
      if (line) {
        line.setAttribute("data-file-preview-target-line", "");
        line.setAttribute("data-selected-line", "single");
        scrollPreviewTargetLine(container, line);
        return;
      }

      attempts += 1;
      if (attempts < 8) {
        scheduleRetry();
      }
    }

    scrollToLine();
    return () => {
      if (cleanupContainer) {
        clearPreviewTargetLine(cleanupContainer);
      }
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [
    file.contents,
    file.name,
    shouldWaitForWorkerPool,
    targetLineNumber,
    workerHighlightCacheState,
  ]);

  if (shouldWaitForWorkerPool) {
    return <FilePreviewLoading />;
  }

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-auto"
      style={FILE_PREVIEW_VIEW_STYLE}
      data-file-preview-line-number={targetLineNumber ?? undefined}
      onPointerDownCapture={lineSelectionActions.onPointerDownCapture}
      onPointerMoveCapture={lineSelectionActions.onPointerMoveCapture}
      onPointerUpCapture={lineSelectionActions.onPointerUpCapture}
    >
      <PierreFile
        key={`${file.cacheKey ?? file.name}:${workerHighlightCacheState}`}
        disableWorkerPool={workerPoolStats?.workersFailed === true}
        file={file}
        options={options}
        selectedLines={selectedLines}
      />
      {lineSelectionActions.menu}
    </div>
  );
}

/** Default export consumed by the lazy boundary in FilePreview.tsx. */
export default function FilePreviewCodeLoaded(props: FilePreviewCodeProps) {
  return (
    <PierrePoolBoundary>
      <FilePreviewCode {...props} />
    </PierrePoolBoundary>
  );
}
