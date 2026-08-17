import { Skeleton } from "@bb/shared-ui/skeleton";

/**
 * Shared code-preview skeleton: shown while file contents load, while the
 * pierre worker pool initializes, and as the Suspense fallback for the lazily
 * loaded code view (FilePreviewCode).
 */
export function FilePreviewLoading() {
  return (
    <div className="space-y-2 px-4 pt-4" aria-busy>
      <Skeleton className="h-3 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-5/6 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-3/5 rounded-sm" />
    </div>
  );
}
