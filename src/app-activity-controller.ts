import { quotaLabel, relativeDate } from "./app-format.js";
import { fallbackApiOrigin } from "./routing.js";
import type { DashboardRoute, OwnerActivityRoute, RepoRoute } from "./routing.js";
import type {
  ActivityRange,
  AudienceRange,
  OwnerActivityPayload,
  RepoAudienceBackfillPayload,
  RepoAudiencePayload,
  RepoActivityRange,
  RepoDetailActivityPayload,
  TrustProfilePayload,
} from "./types.js";

export type ActivityControllerContext = {
  readonly initialRoute: DashboardRoute;
  readonly activityPageRoute: OwnerActivityRoute | null;
  readonly repoRoute: RepoRoute | null;
  readonly showOwnerActivity: boolean;
  readonly showTrustProfile: boolean;
  activityRange: ActivityRange;
  activity: OwnerActivityPayload | null;
  activityLoading: boolean;
  activityError: string;
  repoSummaryRange: RepoActivityRange;
  repoActivity: RepoDetailActivityPayload | null;
  repoActivityLoading: boolean;
  repoActivityError: string;
  trustProfile: TrustProfilePayload | null;
  trustProfileLoading: boolean;
  trustProfileError: string;
  audienceRange: AudienceRange;
  audience: RepoAudiencePayload | null;
  audienceLoading: boolean;
  audienceError: string;
  audienceBackfillLoading: boolean;
  audienceBackfillMessage: string;
  generatedLabel: string;
  generatedDetail: string;
  noteGitHubRateLimit: (
    status: number | null,
    ...messages: Array<string | null | undefined>
  ) => void;
};

export type ActivityController = {
  loadOwnerActivity: (attempt?: number) => Promise<void>;
  loadTrustProfile: () => Promise<void>;
  loadRepoAudience: (attempt?: number, bypassCache?: boolean) => Promise<void>;
  backfillRepoAudience: () => Promise<void>;
  setActivityRange: (range: ActivityRange) => void;
  setAudienceRange: (range: AudienceRange) => void;
  loadRepoActivity: (attempt?: number) => Promise<void>;
  setRepoSummaryRange: (range: RepoActivityRange) => void;
  destroy: () => void;
};

export function createActivityController(context: ActivityControllerContext): ActivityController {
  let activityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let audienceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let repoActivityRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleActivityRefresh(attempt: number): void {
    if (!context.showOwnerActivity) return;
    if (activityRefreshTimer !== null) globalThis.clearTimeout(activityRefreshTimer);
    if (attempt >= 8) return;
    activityRefreshTimer = globalThis.setTimeout(
      () => {
        activityRefreshTimer = null;
        if (document.hidden) {
          scheduleActivityRefresh(attempt);
          return;
        }
        void loadOwnerActivity(attempt + 1).catch(() => undefined);
      },
      attempt < 3 ? 5000 : 15000,
    );
  }

  function scheduleAudienceRefresh(attempt: number): void {
    if (!context.repoRoute) return;
    if (audienceRefreshTimer !== null) globalThis.clearTimeout(audienceRefreshTimer);
    if (attempt >= 8) return;
    audienceRefreshTimer = globalThis.setTimeout(
      () => {
        audienceRefreshTimer = null;
        if (document.hidden) {
          scheduleAudienceRefresh(attempt);
          return;
        }
        void loadRepoAudience(attempt + 1).catch(() => undefined);
      },
      attempt < 3 ? 5000 : 15000,
    );
  }

  function scheduleRepoActivityRefresh(attempt: number): void {
    if (!context.repoRoute || context.repoSummaryRange === "release") return;
    if (repoActivityRefreshTimer !== null) globalThis.clearTimeout(repoActivityRefreshTimer);
    if (attempt >= 8) return;
    repoActivityRefreshTimer = globalThis.setTimeout(
      () => {
        repoActivityRefreshTimer = null;
        if (document.hidden) {
          scheduleRepoActivityRefresh(attempt);
          return;
        }
        void loadRepoActivity(attempt + 1).catch(() => undefined);
      },
      attempt < 3 ? 5000 : 15000,
    );
  }

  function activityApiPaths(): string[] {
    const owner = context.activityPageRoute?.owner ?? context.initialRoute.owner;
    if (!owner) return [];
    const path = `/api/${encodeURIComponent(owner)}/activity`;
    const url = new URL(path, location.origin);
    url.searchParams.set("range", context.activityRange);
    const urls = [url.toString()];
    if (context.activityPageRoute?.fallbackApiPath || context.initialRoute.fallbackApiPath) {
      const fallback = new URL(path, fallbackApiOrigin());
      fallback.searchParams.set("range", context.activityRange);
      urls.push(fallback.toString());
    }
    return urls;
  }

  function trustProfileApiPaths(): string[] {
    if (!context.initialRoute.owner) return [];
    const path = `/api/users/${encodeURIComponent(context.initialRoute.owner)}/trust`;
    const urls = [new URL(path, location.origin).toString()];
    if (context.initialRoute.fallbackApiPath) {
      urls.push(new URL(path, fallbackApiOrigin()).toString());
    }
    return urls;
  }

  function audienceApiPath(apiPath: string): string {
    const url = new URL(apiPath, location.origin);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/audience`;
    url.searchParams.set("range", context.audienceRange);
    return url.toString();
  }

  function audienceApiPaths(): string[] {
    if (!context.repoRoute) return [];
    const urls = [audienceApiPath(context.repoRoute.apiPath)];
    if (context.repoRoute.fallbackApiPath) {
      urls.push(audienceApiPath(context.repoRoute.fallbackApiPath));
    }
    return urls;
  }

  function audienceBackfillApiPaths(): string[] {
    if (!context.repoRoute) return [];
    const path = (apiPath: string): string => {
      const url = new URL(apiPath, location.origin);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/audience/backfill`;
      return url.toString();
    };
    const urls = [path(context.repoRoute.apiPath)];
    if (context.repoRoute.fallbackApiPath) urls.push(path(context.repoRoute.fallbackApiPath));
    return urls;
  }

  function repoActivityApiPaths(): string[] {
    if (!context.repoRoute || context.repoSummaryRange === "release") return [];
    const appendActivity = (apiPath: string, origin = location.origin): string => {
      const url = new URL(`${apiPath.replace(/\/$/, "")}/activity`, origin);
      url.searchParams.set("range", context.repoSummaryRange);
      return url.toString();
    };
    const urls = [appendActivity(context.repoRoute.apiPath)];
    if (context.repoRoute.fallbackApiPath) {
      urls.push(appendActivity(context.repoRoute.fallbackApiPath, fallbackApiOrigin()));
    }
    return urls;
  }

  function isRepoAudiencePayload(body: unknown): body is RepoAudiencePayload {
    if (!body || typeof body !== "object") return false;
    const payload = body as { cache?: { state?: unknown }; fullName?: unknown; users?: unknown };
    return (
      typeof payload.fullName === "string" &&
      Array.isArray(payload.users) &&
      typeof payload.cache?.state === "string"
    );
  }

  async function fetchPayload(apiPath: string, bypassCache: boolean): Promise<Response> {
    const response = !bypassCache
      ? await fetch(apiPath)
      : await fetch(`${apiPath}${apiPath.includes("?") ? "&" : "?"}v=${Date.now()}`, {
          cache: "no-store",
        });
    context.noteGitHubRateLimit(response.status);
    return response;
  }

  function updateActivityStatus(payload: OwnerActivityPayload): void {
    context.generatedLabel =
      payload.cache.state === "stale"
        ? `refreshing · cached ${relativeDate(payload.generatedAt)}`
        : `updated ${relativeDate(payload.generatedAt)}`;
    context.generatedDetail = [
      payload.cache.state,
      quotaLabel(payload.cache.quota),
      payload.cache.message ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
    context.noteGitHubRateLimit(null, payload.cache.message);
  }

  async function loadOwnerActivity(attempt = 0): Promise<void> {
    if (!context.showOwnerActivity) return;
    const paths = activityApiPaths();
    if (paths.length === 0) return;
    const requestedRange = context.activityRange;
    let lastError = "";
    context.activityLoading = attempt === 0 && !context.activity;
    context.activityError = "";
    try {
      for (const path of paths) {
        const response = await fetch(path, { cache: attempt > 0 ? "no-store" : "default" });
        const body = (await response.json().catch(() => null)) as
          | OwnerActivityPayload
          | { error?: string }
          | null;
        context.noteGitHubRateLimit(
          response.status,
          body && "error" in body ? body.error : undefined,
          body && "events" in body ? body.cache.message : undefined,
        );
        if (body && "events" in body) {
          if (requestedRange !== context.activityRange) return;
          context.activity = body;
          if (context.activityPageRoute) updateActivityStatus(body);
          if (body.summary?.state === "warming" || body.cache.state === "stale") {
            scheduleActivityRefresh(attempt);
          }
          return;
        }
        lastError =
          body && "error" in body
            ? (body.error ?? "")
            : `activity fetch failed: ${response.status}`;
      }
      if (requestedRange !== context.activityRange) return;
      context.activityError = lastError;
      if (context.activityPageRoute && !context.activity) {
        context.generatedLabel = "activity unavailable";
        context.generatedDetail = lastError;
      }
    } catch (error) {
      if (requestedRange !== context.activityRange) return;
      context.activityError = error instanceof Error ? error.message : String(error);
      if (context.activityPageRoute && !context.activity) {
        context.generatedLabel = "activity unavailable";
        context.generatedDetail = context.activityError;
      }
    } finally {
      if (requestedRange === context.activityRange) context.activityLoading = false;
    }
  }

  async function loadTrustProfile(): Promise<void> {
    if (!context.showTrustProfile) return;
    const paths = trustProfileApiPaths();
    if (paths.length === 0) return;
    context.trustProfileLoading = !context.trustProfile;
    context.trustProfileError = "";
    try {
      for (const path of paths) {
        const response = await fetch(path);
        const body = (await response.json().catch(() => null)) as
          | TrustProfilePayload
          | { error?: string; cache?: { message?: string } }
          | null;
        context.noteGitHubRateLimit(
          response.status,
          body && "error" in body ? body.error : undefined,
          body && "cache" in body ? body.cache?.message : undefined,
        );
        if (body && "score" in body) {
          context.trustProfile = body;
          context.trustProfileError = "";
          return;
        }
        context.trustProfileError =
          body && "error" in body
            ? (body.error ?? "")
            : body?.cache?.message || `trust profile failed: ${response.status}`;
      }
    } catch (error) {
      context.trustProfileError = error instanceof Error ? error.message : String(error);
    } finally {
      context.trustProfileLoading = false;
    }
  }

  async function loadRepoAudience(attempt = 0, bypassCache = false): Promise<void> {
    if (!context.repoRoute) return;
    const requestedRange = context.audienceRange;
    context.audienceLoading = attempt === 0 && !context.audience;
    context.audienceError = "";
    try {
      for (const path of audienceApiPaths()) {
        const response = await fetchPayload(path, bypassCache || attempt > 0);
        const body = (await response.json().catch(() => null)) as
          | RepoAudiencePayload
          | { error?: string; cache?: { message?: string } }
          | null;
        context.noteGitHubRateLimit(
          response.status,
          body && "error" in body ? body.error : undefined,
          body && "cache" in body ? body.cache?.message : undefined,
        );
        if (isRepoAudiencePayload(body)) {
          if (requestedRange !== context.audienceRange) return;
          context.audience = body;
          context.audienceError = "";
          if (body.cache.state === "stale" || body.cache.state === "warming") {
            scheduleAudienceRefresh(attempt);
          }
          return;
        }
        context.audienceError =
          body && "error" in body
            ? (body.error ?? "")
            : body?.cache?.message || `audience fetch failed: ${response.status}`;
      }
    } catch (error) {
      context.audienceError = error instanceof Error ? error.message : String(error);
    } finally {
      context.audienceLoading = false;
    }
  }

  async function backfillRepoAudience(): Promise<void> {
    if (!context.repoRoute || context.audienceBackfillLoading) return;
    context.audienceBackfillLoading = true;
    context.audienceBackfillMessage = "";
    try {
      for (const path of audienceBackfillApiPaths()) {
        const response = await fetch(path, { method: "POST", cache: "no-store" });
        const body = (await response.json().catch(() => null)) as
          | RepoAudienceBackfillPayload
          | { error?: string; message?: string }
          | null;
        context.noteGitHubRateLimit(
          response.status,
          body && "error" in body ? body.error : undefined,
          body && "message" in body ? body.message : undefined,
        );
        if (body && "ranges" in body) {
          context.audienceBackfillMessage = body.ranges
            .map((range) => `${range.range} ${range.state}`)
            .join(" · ");
          context.audience = null;
          await loadRepoAudience(0, true);
          return;
        }
        context.audienceBackfillMessage =
          body && "error" in body
            ? (body.error ?? "")
            : body?.message || `backfill failed: ${response.status}`;
      }
    } catch (error) {
      context.audienceBackfillMessage = error instanceof Error ? error.message : String(error);
    } finally {
      context.audienceBackfillLoading = false;
    }
  }

  function setActivityRange(range: ActivityRange): void {
    if (context.activityRange === range) return;
    context.activityRange = range;
    context.activity = null;
    context.activityError = "";
    if (context.activityPageRoute) {
      context.generatedLabel = "loading activity";
      context.generatedDetail = `${range} range`;
    }
    if (activityRefreshTimer !== null) {
      globalThis.clearTimeout(activityRefreshTimer);
      activityRefreshTimer = null;
    }
    if (context.activityPageRoute) {
      const url = new URL(location.href);
      if (range === "week") url.searchParams.delete("range");
      else url.searchParams.set("range", range);
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    void loadOwnerActivity();
  }

  function setAudienceRange(range: AudienceRange): void {
    if (context.audienceRange === range) return;
    context.audienceRange = range;
    context.audience = null;
    context.audienceError = "";
    if (audienceRefreshTimer !== null) {
      globalThis.clearTimeout(audienceRefreshTimer);
      audienceRefreshTimer = null;
    }
    void loadRepoAudience();
  }

  async function loadRepoActivity(attempt = 0): Promise<void> {
    if (!context.repoRoute || context.repoSummaryRange === "release") return;
    const requestedRange = context.repoSummaryRange;
    context.repoActivityLoading = attempt === 0 && !context.repoActivity;
    context.repoActivityError = "";
    try {
      for (const path of repoActivityApiPaths()) {
        const response = await fetch(path, { cache: attempt > 0 ? "no-store" : "default" });
        const body = (await response.json().catch(() => null)) as
          | RepoDetailActivityPayload
          | { error?: string }
          | null;
        context.noteGitHubRateLimit(
          response.status,
          body && "error" in body ? body.error : undefined,
          body && "events" in body ? body.cache.message : undefined,
        );
        if (body && "events" in body) {
          if (requestedRange !== context.repoSummaryRange) return;
          context.repoActivity = body;
          if (body.summary?.state === "warming" || body.cache.state === "stale") {
            scheduleRepoActivityRefresh(attempt);
          }
          return;
        }
        context.repoActivityError =
          body && "error" in body
            ? (body.error ?? "")
            : `repository activity fetch failed: ${response.status}`;
      }
    } catch (error) {
      context.repoActivityError = error instanceof Error ? error.message : String(error);
    } finally {
      context.repoActivityLoading = false;
    }
  }

  function setRepoSummaryRange(range: RepoActivityRange): void {
    if (context.repoSummaryRange === range) return;
    context.repoSummaryRange = range;
    context.repoActivity = null;
    context.repoActivityError = "";
    if (repoActivityRefreshTimer !== null) {
      globalThis.clearTimeout(repoActivityRefreshTimer);
      repoActivityRefreshTimer = null;
    }
    if (range !== "release") void loadRepoActivity();
  }

  function destroy(): void {
    for (const timer of [activityRefreshTimer, audienceRefreshTimer, repoActivityRefreshTimer]) {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  }

  return {
    loadOwnerActivity,
    loadTrustProfile,
    loadRepoAudience,
    backfillRepoAudience,
    setActivityRange,
    setAudienceRange,
    loadRepoActivity,
    setRepoSummaryRange,
    destroy,
  };
}
