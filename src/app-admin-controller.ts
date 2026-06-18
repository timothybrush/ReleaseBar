import { numberFormat } from "./app-format.js";
import type { AdminDashboardPayload } from "./app-types.js";
import type {
  AuthFunnelSummary,
  AuthPayload,
  GitHubAccessSummary,
  SchedulerAdminPayload,
} from "./types.js";

export type AdminState = {
  auth: AuthPayload | null;
  admin: AdminDashboardPayload | null;
  adminLoading: boolean;
  adminError: string;
  adminActionMessage: string;
  generatedLabel: string;
  generatedDetail: string;
};

type AdminControllerContext = {
  adminRoute: boolean;
  currentReturnTo: () => string;
  getState: () => AdminState;
  update: (patch: Partial<AdminState>) => void;
};

export function createAdminController(context: AdminControllerContext) {
  async function loadAuth(): Promise<void> {
    try {
      const url = new URL("/api/me", location.origin);
      url.searchParams.set("returnTo", context.currentReturnTo());
      const response = await fetch(url.toString(), { cache: "no-store" });
      if (response.ok) context.update({ auth: (await response.json()) as AuthPayload });
    } catch {
      context.update({ auth: null });
    }
  }

  function emptyGithubAccessSummary(): GitHubAccessSummary {
    return {
      generatedAt: new Date().toISOString(),
      hours: 24,
      buckets: 0,
      total: 0,
      cooldown: {
        active: false,
        resource: null,
        remaining: null,
        limit: null,
        resetAt: null,
        reason: null,
      },
      byArea: [],
      bySource: [],
      byStatus: [],
      topRoutes: [],
    };
  }

  function emptyAuthFunnelSummary(): AuthFunnelSummary {
    return {
      generatedAt: new Date().toISOString(),
      installationCount: 0,
      installations: [],
      events: [],
      counterCount: 0,
      counts: [],
    };
  }

  async function loadAdminSection<T>(path: string): Promise<T | null> {
    try {
      const response = await fetch(path, { cache: "no-store" });
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async function loadAdmin(): Promise<void> {
    if (!context.adminRoute) return;
    context.update({ adminLoading: !context.getState().admin, adminError: "" });
    try {
      const [response, accessSummary, authSummary] = await Promise.all([
        fetch("/api/admin/scheduler", { cache: "no-store" }),
        loadAdminSection<GitHubAccessSummary>("/api/admin/github-access"),
        loadAdminSection<AuthFunnelSummary>("/api/admin/installations"),
      ]);
      const body = (await response.json().catch(() => null)) as
        | SchedulerAdminPayload
        | { error?: string }
        | null;
      if (response.ok && body && "status" in body) {
        const state = context.getState();
        const unavailable = [
          accessSummary ? "" : "GitHub access",
          authSummary ? "" : "installation",
        ].filter(Boolean);
        context.update({
          admin: {
            ...body,
            githubAccess: accessSummary ?? state.admin?.githubAccess ?? emptyGithubAccessSummary(),
            auth: authSummary ?? state.admin?.auth ?? emptyAuthFunnelSummary(),
          },
          generatedLabel: `scheduler · ${numberFormat.format(body.status.targets)} targets`,
          generatedDetail: [
            `${numberFormat.format(body.status.dueTargets)} due in ${numberFormat.format(body.status.scannedTargets)}-target scan`,
            `${numberFormat.format(body.status.runningJobs)} running`,
            body.status.queueConfigured ? "queue configured" : "direct fallback",
            unavailable.length > 0 ? `${unavailable.join(" and ")} data unavailable` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        });
        return;
      }
      throw new Error(
        body && "error" in body ? (body.error ?? "") : `admin fetch failed: ${response.status}`,
      );
    } catch (error) {
      const adminError = error instanceof Error ? error.message : String(error);
      context.update({
        adminError,
        generatedLabel: "admin unavailable",
        generatedDetail: adminError,
      });
    } finally {
      context.update({ adminLoading: false });
    }
  }

  async function runScheduler(): Promise<void> {
    if (!context.adminRoute) return;
    context.update({ adminActionMessage: "scheduler running" });
    try {
      const response = await fetch("/api/admin/scheduler/run", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        enqueued?: number;
        due?: number;
        considered?: number;
        error?: string;
      } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? `scheduler failed: ${response.status}`);
      }
      context.update({
        adminActionMessage: `${numberFormat.format(body.enqueued ?? 0)} jobs enqueued · ${numberFormat.format(body.due ?? 0)} due`,
      });
      await loadAdmin();
    } catch (error) {
      context.update({
        adminActionMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function syncInstallations(): Promise<void> {
    if (!context.adminRoute) return;
    context.update({ adminActionMessage: "syncing GitHub App installs" });
    try {
      const response = await fetch("/api/admin/installations/sync", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        count?: number;
        error?: string;
      } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? `install sync failed: ${response.status}`);
      }
      context.update({
        adminActionMessage: `${numberFormat.format(body.count ?? 0)} GitHub App installs synced`,
      });
      await loadAdmin();
    } catch (error) {
      context.update({
        adminActionMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { loadAuth, loadAdmin, runScheduler, syncInstallations };
}
