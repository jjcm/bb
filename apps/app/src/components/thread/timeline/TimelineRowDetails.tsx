import { Suspense, lazy, useEffect, useState } from "react";
import {
  assertNever,
  fileNameFromPath,
  type TimelineImageViewViewWorkRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { EventCodeBlock } from "../../ui/event-code-block.js";
import { ImageLightbox } from "../../ui/image-lightbox.js";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { TerminalOutputBlock } from "./TerminalOutputBlock.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { ToolCallDetailBlock } from "./ToolCallDetailBlock.js";
import { QuestionWorkRowBody } from "./QuestionWorkRowBody.js";
import { WorkflowWorkRowBody } from "./WorkflowWorkRowBody.js";
import { buildThreadHostFileContentUrl } from "@/lib/file-content-urls";
import type { ThreadTimelineTheme } from "./types.js";
import type { ThreadTimelineImageViewSrcResolver } from "./types.js";

// Lazy: the timeline diff block parses patches with `@pierre/diffs` during
// render, and that import drags the full pierre + Shiki closure (~1.4 MB
// raw). Loading it on demand keeps the workspace route chunk — which gates
// every session's first paint — free of pierre.
const TimelineFileDiffBlock = lazy(() =>
  import("@/components/git-diff/diff-islands").then((module) => ({
    default: module.TimelineFileDiffBlock,
  })),
);

export interface WorkRowBodyProps {
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  row: TimelineViewWorkRow;
  themeType: ThreadTimelineTheme;
  workspaceRootPath: string | undefined;
}

type DetailLine = string | null;

interface ImageViewWorkRowBodyProps {
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  row: TimelineImageViewViewWorkRow;
}

interface ResolveImageViewSourceArgs {
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  row: TimelineImageViewViewWorkRow;
}

function compactDetailLines(lines: readonly DetailLine[]): string[] {
  const compactedLines: string[] = [];
  for (const line of lines) {
    if (line !== null) {
      compactedLines.push(line);
    }
  }
  return compactedLines;
}

function resolveImageViewSource({
  resolveImageViewSrc,
  row,
}: ResolveImageViewSourceArgs): string {
  return resolveImageViewSrc
    ? resolveImageViewSrc({ path: row.path, threadId: row.threadId })
    : buildThreadHostFileContentUrl(row.threadId, row.path);
}

function ImageViewWorkRowBody({
  resolveImageViewSrc,
  row,
}: ImageViewWorkRowBodyProps) {
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const imageSrc = resolveImageViewSource({ resolveImageViewSrc, row });
  const imageName = fileNameFromPath(row.path);
  const imageAlt = `Viewed image: ${imageName}`;

  useEffect(() => {
    setLoadError(false);
    setLightboxOpen(false);
  }, [imageSrc, row.completedAt, row.status]);

  if (loadError) {
    return (
      <EmptyStatePanel className="rounded-lg">
        <div>Image preview unavailable.</div>
        <div className="mt-1 break-all font-mono text-xs">{row.path}</div>
      </EmptyStatePanel>
    );
  }

  return (
    <>
      <button
        type="button"
        className="block w-full max-w-80 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-96"
        onClick={() => setLightboxOpen(true)}
        aria-label={`Open image preview: ${imageName}`}
      >
        <img
          src={imageSrc}
          alt=""
          className="block h-auto w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setLoadError(true)}
        />
      </button>
      <ImageLightbox
        imageAlt={imageAlt}
        imageSrc={lightboxOpen ? imageSrc : null}
        onClose={() => setLightboxOpen(false)}
        title={imageAlt}
      />
    </>
  );
}

export function WorkRowBody({
  resolveImageViewSrc,
  row,
  themeType,
  workspaceRootPath,
}: WorkRowBodyProps) {
  switch (row.workKind) {
    case "command":
      return (
        <TerminalOutputBlock
          commandLine={`$ ${row.command}`}
          metadataLines={compactDetailLines([
            row.source ? `source: ${row.source}` : null,
          ])}
          output={row.output}
          exitCode={row.exitCode}
          streaming={row.status === "pending"}
        />
      );
    case "tool":
      return (
        <ToolCallDetailBlock
          toolName={row.toolName}
          args={row.toolArgs}
          output={row.output}
          streaming={row.status === "pending"}
        />
      );
    case "file-change":
      return (
        <div className="space-y-2">
          <Suspense
            fallback={
              <div
                className="rounded-lg border border-border bg-background p-3"
                aria-busy
              >
                <Skeleton className="h-3 w-48 rounded-sm" />
              </div>
            }
          >
            <TimelineFileDiffBlock
              change={row.change}
              themeType={themeType}
              workspaceRootPath={workspaceRootPath}
            />
          </Suspense>
          {row.stderr ? (
            <TimelineDetailScroll
              size="base"
              contentKey={row.stderr}
              className="rounded-md"
            >
              <EventCodeBlock
                tone="danger"
                className="rounded-none border-0 px-2 py-1.5"
              >
                {row.stderr}
              </EventCodeBlock>
            </TimelineDetailScroll>
          ) : null}
        </div>
      );
    case "delegation":
      // Delegation expanded bodies are dispatched by `TimelineExpandableBody`
      // (in `ThreadTimelineRows.tsx`), which wraps childRows + output text in
      // a delegation-tier scroll container. This branch is unreachable for
      // the App renderer; kept exhaustive for the type.
      return null;
    case "question":
      return <QuestionWorkRowBody row={row} />;
    case "workflow":
      return <WorkflowWorkRowBody row={row} />;
    case "image-view":
      return (
        <ImageViewWorkRowBody
          row={row}
          resolveImageViewSrc={resolveImageViewSrc}
        />
      );
    case "approval":
    case "web-search":
    case "web-fetch":
      return null;
    default:
      return assertNever(row);
  }
}
