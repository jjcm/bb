import { useEffect } from "react";
import { bootPluginFrontends } from "../lib/plugin-frontend-lazy";
import { useSystemConfig } from "./queries/system-queries";

/**
 * How long after system config resolves before plugin boot may even be
 * scheduled. Right after config resolves the main thread is often idle only
 * because the route chunk is still downloading; an immediate idle callback
 * would fire in that window and put the plugin runtime + every plugin
 * bundle's module evaluation in front of the route's first content paint
 * (measured ~600 ms of main-thread work at 4× CPU throttle). The timer skips
 * that false-idle window; the idle callback then waits out the route
 * render crunch.
 */
const PLUGIN_FRONTEND_BOOT_DELAY_MS = 500;
/**
 * Upper bound on the idle wait once the timer fires, so plugin surfaces
 * still appear promptly when the main thread never goes fully idle.
 */
const PLUGIN_FRONTEND_BOOT_IDLE_TIMEOUT_MS = 3_000;

function schedulePluginFrontendBoot(): () => void {
  let idleId: number | null = null;
  const timeoutId = setTimeout(() => {
    if (typeof requestIdleCallback !== "function") {
      void bootPluginFrontends();
      return;
    }
    idleId = requestIdleCallback(() => void bootPluginFrontends(), {
      timeout: PLUGIN_FRONTEND_BOOT_IDLE_TIMEOUT_MS,
    });
  }, PLUGIN_FRONTEND_BOOT_DELAY_MS);
  return () => {
    clearTimeout(timeoutId);
    if (idleId !== null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleId);
    }
  };
}

/**
 * Load plugin frontend bundles (plugin design §5.1) once per page load,
 * after system config resolves AND the page has gone idle — the plugin
 * runtime chunk plus every plugin bundle evaluate on the main thread, so
 * booting them eagerly delays the route's first content paint (the composer
 * on `/`). Deferral order: config resolves → short timer (skip the
 * false-idle window while route chunks download) → idle callback with a
 * timeout. Surfaces that actually need plugins immediately (PluginPanelView)
 * call bootPluginFrontends directly and skip the wait. After boot, the
 * realtime `plugins-changed` broadcast keeps bundles live via
 * schedulePluginFrontendReconcile (no page refresh needed).
 */
export function usePluginFrontendBoot(): void {
  const systemConfig = useSystemConfig();
  const resolved = systemConfig.data !== undefined;
  useEffect(() => {
    if (!resolved) return;
    return schedulePluginFrontendBoot();
  }, [resolved]);
}
