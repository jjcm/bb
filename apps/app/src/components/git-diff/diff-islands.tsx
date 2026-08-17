/**
 * Single lazy entry for every `@pierre/diffs`-rendered island (diff cards,
 * timeline diff blocks, the file-preview code view). All islands need the
 * same pierre + Shiki closure and usually co-occur, so funneling their
 * `React.lazy` imports through one module keeps them in one async chunk.
 * Separate dynamic imports would give Rollup four distinct chunk-group
 * signatures, which fragments small shared modules (skeleton, radix slivers)
 * into extra boot chunks and inflates the boot payload the bundle budget
 * guards.
 */
export { default as GitDiffCardImpl } from "./GitDiffCardImpl";
export { default as FilePreviewCode } from "@/components/secondary-panel/FilePreviewCode";
export { DiffFileCard } from "@/components/secondary-panel/git-diff/DiffFileCard";
export { TimelineFileDiffBlock } from "@/components/thread/timeline/TimelineFileDiffBlock";
