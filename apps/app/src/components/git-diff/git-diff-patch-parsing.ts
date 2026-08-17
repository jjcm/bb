import { parsePatchFiles, processFile, type FileContents } from "@pierre/diffs";
import type { ParsedGitDiffFile } from "./git-diff-parsing";

/**
 * The runtime `@pierre/diffs` patch-parsing entry points, split from the
 * pierre-free helpers in `git-diff-parsing.ts`. Importing this module pulls
 * the full `@pierre/diffs` + Shiki closure (~1.4 MB raw), so it must only be
 * reachable from lazily loaded diff UI — never from a route chunk's static
 * import graph. `scripts/measure-load.mjs` and the bundle-graph dump
 * (BB_BUNDLE_STATS_ALL=1) are the checks for that.
 */
export function parseGitDiffFiles(diff: string): ParsedGitDiffFile[] {
  if (diff.trim().length === 0) return [];
  try {
    return parsePatchFiles(diff).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

export interface GitDiffContextEnrichmentInput {
  fileDiff: ParsedGitDiffFile;
  oldFile: FileContents;
  newFile: FileContents;
  patchText?: string;
}

/**
 * Reparses a card's raw file patch with both full file sides attached. The
 * diff renderer only exposes expand-context controls when `isPartial` is false
 * and `additionLines` / `deletionLines` contain complete file contents.
 */
export function enrichGitDiffFileForContext({
  fileDiff,
  oldFile,
  newFile,
  patchText,
}: GitDiffContextEnrichmentInput): ParsedGitDiffFile {
  if (!patchText) return fileDiff;

  return (
    processFile(patchText, {
      oldFile,
      newFile,
      cacheKey:
        fileDiff.cacheKey === undefined
          ? undefined
          : `${fileDiff.cacheKey}:context`,
    }) ?? fileDiff
  );
}
