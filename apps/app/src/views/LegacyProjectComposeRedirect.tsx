import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PageShell } from "@/components/ui/page-shell.js";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";

interface LegacyProjectComposeRedirectProps {
  projectId: string;
}

/**
 * Redirects a legacy /projects/:projectId compose deep link to the root
 * compose route, seeding the selected project. Lives in its own module (not
 * RootComposeView.tsx) so the route table can import it without statically
 * pulling the whole compose surface into the route chunk — RootComposeView
 * is lazily loaded per pane (see SplitThreadArea).
 */
export function LegacyProjectComposeRedirect({
  projectId,
}: LegacyProjectComposeRedirectProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();

  useEffect(() => {
    setRootComposeProjectId(projectId);
    navigate(getRootComposeRoutePath(), {
      replace: true,
      state: location.state,
    });
  }, [location.state, navigate, projectId, setRootComposeProjectId]);

  return (
    <PageShell contentClassName="min-h-full items-center justify-center">
      <p className="py-12 text-center text-sm text-muted-foreground">
        Loading…
      </p>
    </PageShell>
  );
}
