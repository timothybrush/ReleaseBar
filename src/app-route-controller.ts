import { tick } from "svelte";

import { numberFormat, quotaLabel, relativeDate } from "./app-format.js";
import type { DashboardRoute, OwnerActivityRoute, RepoRoute } from "./routing.js";
import type {
  DashboardPayload,
  RepoActivityRange,
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "./types.js";

export type RouteState = {
  data: DashboardPayload | null;
  repoDetail: RepoDetailPayload | null;
  repoSummaryRange: RepoActivityRange;
  repoActivity: RepoDetailActivityPayload | null;
  generatedLabel: string;
  generatedDetail: string;
  errorMessage: string;
  manualRefreshLoading: boolean;
};

export type RouteControllerContext = {
  initialRoute: DashboardRoute;
  activityPageRoute: OwnerActivityRoute | null;
  repoRoute: RepoRoute | null;
  manualRefreshAvailable: () => boolean;
  getState: () => RouteState;
  update: (patch: Partial<RouteState>) => void;
  noteGitHubRateLimit: (
    status: number | null,
    ...messages: Array<string | null | undefined>
  ) => void;
  loadRepoActivity: () => Promise<void>;
};

export type RouteController = {
  updateStatus: () => void;
  updateRepoDetailStatus: () => void;
  reportDashboardTiming: (
    payload: DashboardPayload,
    fields: Record<string, string | number | boolean | null | undefined>,
  ) => Promise<void>;
  shouldAutoRefresh: (payload: DashboardPayload) => boolean;
  closeDashboardStream: () => void;
  loadDashboard: (attempt?: number) => Promise<void>;
  manualRefreshDashboard: () => Promise<void>;
  loadRepoDetail: (attempt?: number) => Promise<void>;
  destroy: () => void;
};

export function createRouteController(context: RouteControllerContext): RouteController {
  let dashboardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let repoDetailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let dashboardEventSource: EventSource | null = null;
  let dashboardStreamTimingSent = false;

  const nowMs = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());
  const roundedMs = (value: number | null | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : undefined;

  function navigationTiming(): Record<string, number> {
    if (typeof performance === "undefined") return {};
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (!entry) return {};
    return {
      ...(roundedMs(entry.responseStart - entry.startTime) !== undefined
        ? { navigationTtfbMs: roundedMs(entry.responseStart - entry.startTime) as number }
        : {}),
      ...(roundedMs(entry.domInteractive - entry.startTime) !== undefined
        ? { navigationInteractiveMs: roundedMs(entry.domInteractive - entry.startTime) as number }
        : {}),
    };
  }

  function postClientTiming(
    fields: Record<string, string | number | boolean | null | undefined>,
  ): void {
    const body = JSON.stringify({
      route: context.activityPageRoute ? "activity" : context.repoRoute ? "repo" : "dashboard",
      path: location.pathname,
      ...fields,
    });
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon?.("/api/_client-timing", blob)) return;
    void fetch("/api/_client-timing", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);
  }

  async function reportDashboardTiming(
    payload: DashboardPayload,
    fields: Record<string, string | number | boolean | null | undefined>,
  ): Promise<void> {
    const renderStart = nowMs();
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const renderMs = roundedMs(nowMs() - renderStart);
    const baseTotalMs = typeof fields.totalMs === "number" ? fields.totalMs : undefined;
    postClientTiming({
      event: "dashboard",
      cacheState: payload.cache?.state ?? "ready",
      projects: payload.projects.length,
      scanned: payload.cache?.progress?.scanned ?? null,
      limit: payload.cache?.progress?.limit ?? null,
      done: payload.cache?.progress?.done ?? null,
      ...navigationTiming(),
      ...fields,
      renderMs: fields.renderMs ?? renderMs,
      totalMs:
        baseTotalMs === undefined || renderMs === undefined
          ? fields.totalMs
          : roundedMs(baseTotalMs + renderMs),
    });
  }

  function updateStatus(): void {
    const { data } = context.getState();
    if (!data) return;
    const cacheState = data.cache?.state;
    const stale = data.cache?.stale && cacheState !== "stale" ? "stale" : "";
    const capped = data.cache?.capped
      ? `capped at ${numberFormat.format(data.cache.repoLimit ?? data.projects.length)}`
      : "";
    const freshness = [
      data.cache?.countsUpdatedAt ? `counts ${relativeDate(data.cache.countsUpdatedAt)}` : "",
      data.cache?.releasesUpdatedAt ? `releases ${relativeDate(data.cache.releasesUpdatedAt)}` : "",
      data.cache?.ciUpdatedAt ? `CI ${relativeDate(data.cache.ciUpdatedAt)}` : "",
    ].filter(Boolean);
    context.update({
      generatedLabel:
        cacheState === "partial"
          ? `updating · cached ${relativeDate(data.generatedAt)}`
          : `updated ${relativeDate(data.generatedAt)}`,
      generatedDetail: [
        cacheState,
        stale,
        capped,
        ...freshness,
        quotaLabel(data.cache?.quota),
        data.cache?.message ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
    context.noteGitHubRateLimit(null, data.cache?.message);
  }

  function updateRepoDetailStatus(): void {
    const { repoDetail } = context.getState();
    if (!repoDetail) return;
    const cacheState = repoDetail.cache.state;
    context.update({
      generatedLabel:
        cacheState === "warming"
          ? `warming stats · cached ${relativeDate(repoDetail.generatedAt)}`
          : `updated ${relativeDate(repoDetail.generatedAt)}`,
      generatedDetail: [
        cacheState,
        quotaLabel(repoDetail.cache.quota),
        repoDetail.cache.message ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
    context.noteGitHubRateLimit(null, repoDetail.cache.message);
  }

  async function fetchPayload(apiPath: string, bypassCache = false): Promise<Response> {
    const response = !bypassCache
      ? await fetch(apiPath)
      : await fetch(`${apiPath}${apiPath.includes("?") ? "&" : "?"}v=${Date.now()}`, {
          cache: "no-store",
        });
    context.noteGitHubRateLimit(response.status);
    return response;
  }

  const readDashboardResponse = async (
    response: Response,
  ): Promise<DashboardPayload | { error?: string } | null> =>
    (await response.json().catch(() => null)) as DashboardPayload | { error?: string } | null;

  function shouldAutoRefresh(payload: DashboardPayload): boolean {
    return ["rebuilding", "partial", "stale"].includes(payload.cache?.state ?? "");
  }

  function closeDashboardStream(): void {
    dashboardEventSource?.close();
    dashboardEventSource = null;
  }

  function scheduleDashboardRefresh(attempt: number): void {
    if (dashboardRefreshTimer !== null) globalThis.clearTimeout(dashboardRefreshTimer);
    if (attempt >= 60) return;
    dashboardRefreshTimer = globalThis.setTimeout(
      () => {
        dashboardRefreshTimer = null;
        if (document.hidden) {
          scheduleDashboardRefresh(attempt);
          return;
        }
        void loadDashboard(attempt + 1).catch(() => undefined);
      },
      attempt < 24 ? 5000 : 15000,
    );
  }

  function scheduleRepoDetailRefresh(attempt: number): void {
    if (!context.repoRoute) return;
    if (repoDetailRefreshTimer !== null) globalThis.clearTimeout(repoDetailRefreshTimer);
    if (attempt >= 36) return;
    repoDetailRefreshTimer = globalThis.setTimeout(
      () => {
        repoDetailRefreshTimer = null;
        if (document.hidden) {
          scheduleRepoDetailRefresh(attempt);
          return;
        }
        void loadRepoDetail(attempt + 1).catch(() => undefined);
      },
      attempt < 8 ? 5000 : 15000,
    );
  }

  function clearDashboardRefreshParam(): void {
    const params = new URLSearchParams(location.search);
    if (!params.has("rdRefresh")) return;
    params.delete("rdRefresh");
    const search = params.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
    );
  }

  function dashboardEventsPath(apiPath: string): string | null {
    const url = new URL(apiPath, location.origin);
    if (url.pathname === "/api/_hot" || url.pathname === "/api/_discover") return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/events`;
    return url.toString();
  }

  function startDashboardStream(attempt: number): boolean {
    if (typeof EventSource === "undefined") return false;
    const eventsPath = dashboardEventsPath(context.initialRoute.apiPath);
    if (!eventsPath) return false;
    closeDashboardStream();
    const startedAt = nowMs();
    dashboardStreamTimingSent = false;
    dashboardEventSource = new EventSource(eventsPath);
    dashboardEventSource.addEventListener("dashboard", (event) => {
      const receivedAt = nowMs();
      const next = JSON.parse((event as MessageEvent).data) as DashboardPayload;
      context.update({ data: next });
      updateStatus();
      if (!dashboardStreamTimingSent) {
        dashboardStreamTimingSent = true;
        void reportDashboardTiming(next, {
          source: "stream",
          attempt,
          apiPath: new URL(eventsPath).pathname,
          streamMs: roundedMs(receivedAt - startedAt),
          totalMs: roundedMs(nowMs() - startedAt),
        });
      }
      if (!shouldAutoRefresh(next)) closeDashboardStream();
    });
    dashboardEventSource.onerror = () => {
      closeDashboardStream();
      scheduleDashboardRefresh(attempt);
    };
    return true;
  }

  async function loadDashboard(attempt = 0): Promise<void> {
    const forceRefresh = new URLSearchParams(location.search).has("rdRefresh");
    const bypassCache = attempt > 0 || forceRefresh;
    try {
      const startedAt = nowMs();
      let response = await fetchPayload(context.initialRoute.apiPath, bypassCache);
      const headerAt = nowMs();
      let body = await readDashboardResponse(response);
      context.noteGitHubRateLimit(
        response.status,
        body && "error" in body ? body.error : undefined,
        body && "cache" in body ? body.cache?.message : undefined,
      );
      const bodyAt = nowMs();
      if (response.ok && body && "projects" in body) {
        context.update({ data: body });
        updateStatus();
        void reportDashboardTiming(body, {
          source: "fetch",
          attempt,
          apiPath: new URL(context.initialRoute.apiPath, location.origin).pathname,
          httpStatus: response.status,
          headerMs: roundedMs(headerAt - startedAt),
          bodyMs: roundedMs(bodyAt - headerAt),
          totalMs: roundedMs(bodyAt - startedAt),
        });
        if (shouldAutoRefresh(body)) {
          if (!startDashboardStream(attempt)) scheduleDashboardRefresh(attempt);
        } else closeDashboardStream();
        return;
      }
      if (body && "cache" in body) {
        context.update({ data: body });
        updateStatus();
        context.update({ errorMessage: body.cache?.message || "dashboard error" });
        return;
      }
      if (context.initialRoute.fallbackApiPath) {
        const fallbackStartedAt = nowMs();
        response = await fetchPayload(context.initialRoute.fallbackApiPath, bypassCache);
        const fallbackHeaderAt = nowMs();
        body = await readDashboardResponse(response);
        context.noteGitHubRateLimit(
          response.status,
          body && "error" in body ? body.error : undefined,
          body && "cache" in body ? body.cache?.message : undefined,
        );
        const fallbackBodyAt = nowMs();
        if (response.ok && body && "projects" in body) {
          context.update({ data: body });
          updateStatus();
          void reportDashboardTiming(body, {
            source: "fetch-fallback",
            attempt,
            apiPath: new URL(context.initialRoute.fallbackApiPath, location.origin).pathname,
            httpStatus: response.status,
            headerMs: roundedMs(fallbackHeaderAt - fallbackStartedAt),
            bodyMs: roundedMs(fallbackBodyAt - fallbackHeaderAt),
            totalMs: roundedMs(fallbackBodyAt - fallbackStartedAt),
          });
          return;
        }
      }
      const message =
        body && "error" in body ? body.error : `dashboard fetch failed: ${response.status}`;
      throw new Error(message || `dashboard fetch failed: ${response.status}`);
    } finally {
      if (forceRefresh) clearDashboardRefreshParam();
    }
  }

  async function manualRefreshDashboard(): Promise<void> {
    const state = context.getState();
    if (!context.manualRefreshAvailable() || state.manualRefreshLoading) return;
    context.update({
      manualRefreshLoading: true,
      generatedLabel: "refreshing",
      generatedDetail: "refreshing issue and PR counts first",
      errorMessage: "",
    });
    closeDashboardStream();
    if (dashboardRefreshTimer !== null) {
      globalThis.clearTimeout(dashboardRefreshTimer);
      dashboardRefreshTimer = null;
    }
    const read = async (apiPath: string) => {
      const response = await fetch(apiPath, { method: "POST", cache: "no-store" });
      const body = await readDashboardResponse(response);
      context.noteGitHubRateLimit(
        response.status,
        body && "error" in body ? body.error : undefined,
        body && "cache" in body ? body.cache?.message : undefined,
      );
      return { response, body };
    };
    try {
      let { response, body } = await read(context.initialRoute.apiPath);
      if (
        context.initialRoute.fallbackApiPath &&
        (!response.ok || !body || !("projects" in body))
      ) {
        ({ response, body } = await read(context.initialRoute.fallbackApiPath));
      }
      if (response.ok && body && "projects" in body) {
        context.update({ data: body });
        updateStatus();
        if (shouldAutoRefresh(body) && !startDashboardStream(0)) scheduleDashboardRefresh(0);
        return;
      }
      const message =
        body && "cache" in body && body.cache?.message
          ? body.cache.message
          : body && "error" in body
            ? body.error
            : `dashboard refresh failed: ${response.status}`;
      throw new Error(message || `dashboard refresh failed: ${response.status}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.update({
        errorMessage,
        generatedLabel: "refresh failed",
        generatedDetail: errorMessage,
      });
    } finally {
      context.update({ manualRefreshLoading: false });
    }
  }

  async function loadRepoDetail(attempt = 0): Promise<void> {
    if (!context.repoRoute) return;
    const read = async (apiPath: string) => {
      const response = await fetchPayload(apiPath, attempt > 0);
      const body = (await response.json().catch(() => null)) as
        | RepoDetailPayload
        | { error?: string; cache?: { state?: string; message?: string } }
        | null;
      context.noteGitHubRateLimit(
        response.status,
        body && "error" in body ? body.error : undefined,
        body && "cache" in body ? body.cache?.message : undefined,
      );
      return { response, body };
    };
    let { response, body } = await read(context.repoRoute.apiPath);
    if (context.repoRoute.fallbackApiPath && (!response.ok || !body || !("project" in body))) {
      ({ response, body } = await read(context.repoRoute.fallbackApiPath));
    }
    if (body && "project" in body) {
      context.update({
        repoDetail: body,
        ...(!body.project.releaseDate && context.getState().repoSummaryRange === "release"
          ? { repoSummaryRange: "month" as const }
          : {}),
      });
      updateRepoDetailStatus();
      if (
        body.cache.state === "warming" ||
        body.cache.state === "stale" ||
        body.releaseSummary?.state === "warming"
      ) {
        scheduleRepoDetailRefresh(attempt);
      }
      const state = context.getState();
      if (state.repoSummaryRange !== "release" && !state.repoActivity) {
        void context.loadRepoActivity();
      }
      return;
    }
    if (response.status === 202 && body?.cache?.state === "warming") {
      context.update({
        generatedLabel: "warming",
        generatedDetail: body.cache.message ?? "Repository detail is warming.",
      });
      scheduleRepoDetailRefresh(attempt);
      return;
    }
    const message =
      body && "error" in body
        ? body.error
        : body?.cache?.message || `repository detail failed: ${response.status}`;
    throw new Error(message || `repository detail failed: ${response.status}`);
  }

  function destroy(): void {
    if (dashboardRefreshTimer !== null) globalThis.clearTimeout(dashboardRefreshTimer);
    if (repoDetailRefreshTimer !== null) globalThis.clearTimeout(repoDetailRefreshTimer);
    closeDashboardStream();
  }

  return {
    updateStatus,
    updateRepoDetailStatus,
    reportDashboardTiming,
    shouldAutoRefresh,
    closeDashboardStream,
    loadDashboard,
    manualRefreshDashboard,
    loadRepoDetail,
    destroy,
  };
}
