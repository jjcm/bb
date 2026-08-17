import { Suspense, lazy } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { ParsedGitDiffFile } from "./git-diff-parsing";
import type { RequestDiffFileContents } from "./GitDiffCardBody";

export type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "./GitDiffCardBody";

export const GIT_DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  disableFileHeader: false,
  // Reveal 30 unchanged lines per expand-up / expand-down click. Library
  // default is 100 — too aggressive for our compact diff cards.
  expansionLineCount: 30,
} as const;

export interface GitDiffCardProps {
  fileDiff: ParsedGitDiffFile;
  diffViewOptions: Record<string, string | boolean | number>;
  filePathRoot?: string | null;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  /**
   * When both isCollapsed and onToggleCollapsed are provided, the card renders
   * a chevron in the header and hides its body when collapsed. Omit both to
   * render a card with no collapse affordance (timeline rows do this — they
   * collapse at the row level).
   */
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * When true, the header sticks to the nearest scroll container. The default
   * stuck chrome is for panel-level scrolling; timeline row diffs can suppress
   * that edge when their own scroll area owns the fixed border.
   */
  stickyHeader?: boolean;
  /** Override the sticky top offset when the scroll container owns surrounding chrome. */
  stickyHeaderTopClassName?: string;
  /** Whether crossing the sticky threshold changes header rounding/edge chrome. */
  applyStuckHeaderChrome?: boolean;
  /** When true, replaces the body with a skeleton (for queued render slots). */
  isRendering?: boolean;
  /** Forwarded to the outer card element — used for IntersectionObserver-based scheduling. */
  cardRef?: (element: HTMLDivElement | null) => void;
  /** Extra classes for the outer card shell. */
  cardClassName?: string;
  /** Whether a stuck sticky header should draw its own replacement top edge. */
  showStuckHeaderEdge?: boolean;
  /**
   * When provided, the card lazy-fetches `oldFile`/`newFile` the first time
   * it scrolls into view. When `patchText` is also available to the shared body,
   * text results reparse the patch with complete file contents, which unlocks
   * `@pierre/diffs`'s built-in expand-context buttons in the gaps between
   * hunks; image results render as an inline preview instead of the text diff.
   * Without this prop the card renders the hunk-only view.
   *
   * The callback should resolve to `null` for binary files the card can't
   * preview (the diff renderer needs a UTF-8 string) so the card can leave
   * expand disabled for that file.
   */
  onRequestFileContents?: RequestDiffFileContents;
}

// Lazy facade: the real card (./GitDiffCardImpl.tsx) drags the full
// `@pierre/diffs` + Shiki closure, which used to sit in the workspace route's
// static chunk and delay first paint of every session by hundreds of ms of
// parse/execute. Splitting here keeps every consumer's API unchanged while
// the diff renderer loads only when a card actually mounts.
const LazyGitDiffCard = lazy(() =>
  import("./diff-islands").then((module) => ({
    default: module.GitDiffCardImpl,
  })),
);

function GitDiffCardSkeleton({
  cardRef,
  cardClassName,
}: Pick<GitDiffCardProps, "cardRef" | "cardClassName">) {
  return (
    <div
      ref={cardRef}
      className={cn(
        "rounded-lg border border-border bg-background",
        cardClassName,
      )}
      aria-busy
    >
      <div className="flex h-9 items-center px-3">
        <Skeleton className="h-3 w-48 rounded-sm" />
      </div>
    </div>
  );
}

export function GitDiffCard(props: GitDiffCardProps) {
  return (
    <Suspense
      fallback={
        <GitDiffCardSkeleton
          cardRef={props.cardRef}
          cardClassName={props.cardClassName}
        />
      }
    >
      <LazyGitDiffCard {...props} />
    </Suspense>
  );
}
