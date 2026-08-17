import { memo, useEffect, useMemo, useState } from "react";
import { useIntersectionObserver } from "usehooks-ts";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  GitDiffCardBody,
  useGitDiffCardBody,
  type GitDiffCardSvgDisplayMode,
} from "./GitDiffCardBody";
import {
  GitDiffCardHeader,
  GitDiffCardImageSizeStat,
  GitDiffCardRawToggle,
  gitDiffCardHeaderWrapperClass,
  type GitDiffCardHeaderModel,
} from "./GitDiffCardHeader";
import {
  formatGitDiffFileLabel,
  getGitDiffFileChangeKind,
  getOpenableGitDiffPath,
  normalizeGitDiffPath,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";
import { PierrePoolBoundary } from "./PierrePoolBoundary";
import type { GitDiffCardProps } from "./GitDiffCard";

function buildGitDiffCardHeaderModel(
  fileDiff: ParsedGitDiffFile,
): GitDiffCardHeaderModel {
  const stats = summarizeGitDiffFile(fileDiff);
  return {
    label: formatGitDiffFileLabel(fileDiff),
    path: normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name,
    openablePath: getOpenableGitDiffPath(fileDiff),
    changeKind: getGitDiffFileChangeKind(fileDiff),
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

const GitDiffCardImpl = memo(function GitDiffCardImpl({
  fileDiff,
  diffViewOptions,
  filePathRoot,
  onOpenFileInEditor,
  onOpenFilePreview,
  isCollapsed,
  onToggleCollapsed,
  stickyHeader = false,
  stickyHeaderTopClassName,
  applyStuckHeaderChrome = true,
  isRendering = false,
  cardRef,
  cardClassName,
  showStuckHeaderEdge = true,
  onRequestFileContents,
}: GitDiffCardProps) {
  const headerModel = useMemo(
    () => buildGitDiffCardHeaderModel(fileDiff),
    [fileDiff],
  );
  const previousPath = normalizeGitDiffPath(fileDiff.prevName) ?? null;
  const bodyState = useGitDiffCardBody({
    fileDiff,
    changeKind: headerModel.changeKind,
    isRendering,
    onRequestFileContents,
  });
  const [svgDisplayMode, setSvgDisplayMode] =
    useState<GitDiffCardSvgDisplayMode>("preview");
  useEffect(() => {
    setSvgDisplayMode("preview");
  }, [fileDiff]);
  const toggleSvgDisplayMode = () => {
    setSvgDisplayMode((currentMode) =>
      currentMode === "preview" ? "raw" : "preview",
    );
  };
  // Pure renames + identical content land here with zero hunks; nothing for the
  // body to show, so force-collapse and disable the chevron. Image preview cards
  // have a body despite their zero hunks.
  const hasChanges = fileDiff.hunks.length > 0 || bodyState.isImageCard;
  const supportsCollapse =
    isCollapsed !== undefined && onToggleCollapsed !== undefined;
  const isBodyHidden = !hasChanges || (supportsCollapse && isCollapsed);
  const { ref: stickySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });
  const isHeaderStuck = stickyHeader && !isIntersecting;

  return (
    <div
      ref={cardRef}
      className={cn(
        "rounded-lg border border-border bg-background",
        cardClassName,
      )}
    >
      {stickyHeader ? <div ref={stickySentinelRef} className="h-0" /> : null}
      <div
        className={gitDiffCardHeaderWrapperClass({
          stickyHeader,
          stickyHeaderTopClassName,
          isBodyHidden,
          isStuck: isHeaderStuck,
          applyStuckHeaderChrome,
          showStuckHeaderEdge,
        })}
      >
        <GitDiffCardHeader
          model={headerModel}
          previousPath={previousPath}
          filePathRoot={filePathRoot}
          onOpenFileInEditor={onOpenFileInEditor}
          onOpenFilePreview={onOpenFilePreview}
          isCollapsed={isCollapsed}
          onToggleCollapsed={onToggleCollapsed}
          hasChanges={hasChanges}
          // An image swap has no line counts to tally, so image cards always
          // override the slot: the byte-size delta once preview bytes load,
          // and an empty slot (never the text `+/-` tally) while they don't.
          statSlot={
            bodyState.isImageCard ? (
              bodyState.imageSizeStat !== null ? (
                <GitDiffCardImageSizeStat stat={bodyState.imageSizeStat} />
              ) : (
                <span />
              )
            ) : undefined
          }
          actionSlot={
            bodyState.isSvgPreviewCard && !isBodyHidden ? (
              <GitDiffCardRawToggle
                fileLabel={bodyState.fileDiffLabel}
                isRaw={svgDisplayMode === "raw"}
                onToggle={toggleSvgDisplayMode}
              />
            ) : undefined
          }
        />
      </div>
      {!isBodyHidden ? (
        <GitDiffCardBody
          state={bodyState}
          diffViewOptions={diffViewOptions}
          svgDisplayMode={svgDisplayMode}
          reservesCollapseGutter={supportsCollapse}
        />
      ) : null}
    </div>
  );
});

/**
 * Default export consumed by the lazy facade in ./GitDiffCard.tsx. Each card
 * provides the shared pierre worker pool itself (see PierrePoolBoundary) so
 * no eagerly loaded ancestor has to import `@pierre/diffs`.
 */
export default function GitDiffCardLoaded(props: GitDiffCardProps) {
  return (
    <PierrePoolBoundary>
      <GitDiffCardImpl {...props} />
    </PierrePoolBoundary>
  );
}
