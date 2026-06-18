import { slugOwner, validOwnerSlug, validRepoSlug } from "../scripts/lib/dashboard.js";
import type { AuthUser, DashboardPayload, DashboardProfile } from "../src/types.js";
import { authFunnelSummary } from "./auth-observability.js";
import { githubAccessAdminHours, githubAccessSummary } from "./github-audit.js";
import { jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { currentSession, uniqueSorted } from "./app-shell.js";
import { syncGithubAppInstallations } from "./auth-oauth.js";
import { requireAdmin } from "./auth-tokens.js";
import {
  type DashboardRequest,
  hotCacheKey,
  maxCustomSources,
  type ProfileInput,
  type RequestToken,
  repoLimit,
  schedulerBatchLimit,
} from "./config.js";
import {
  deleteProfile,
  errorMessage,
  optionsFromUrl,
  quotaForDashboard,
  readProfile,
  writeProfile,
} from "./dashboard-cache.js";
import { schedulerTick } from "./refresh-queue.js";
import { dashboardRequest } from "./request-lock.js";
import { schedulerAdminPayload } from "./scheduler.js";

export function unresolvedDashboardRequest(
  ownerSlugs: string[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(
    ownerSlugs.map((login) => ({ type: "user", login })),
    includeRepos,
    profile,
    key,
    url,
    includeReleaseData,
    token,
  );
}

export function rebuildingPayload(dashboard: DashboardRequest, env: Env): DashboardPayload {
  return statusPayload(
    dashboard,
    env,
    "rebuilding",
    "dashboard build queued",
    new Date().toISOString(),
  );
}

export function statusPayload(
  dashboard: DashboardRequest,
  env: Env,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message: string,
  generatedAt: string,
): DashboardPayload {
  return {
    title: "ReleaseBar",
    subtitle: dashboard.subtitle,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: dashboard.owners,
    ...(dashboard.profile ? { profile: dashboard.profile } : {}),
    options: {
      ...optionsFromUrl(dashboard.url),
      repoLimit,
    },
    cache: {
      state,
      stale: true,
      capped: false,
      repoLimit,
      generatedAt,
      countsUpdatedAt: null,
      projectCountsUpdatedAt: {},
      releasesUpdatedAt: null,
      ciUpdatedAt: null,
      quota: quotaForDashboard(dashboard, env),
      message,
    },
    totals: {
      repos: 0,
      released: 0,
      unreleased: 0,
      commitsSinceRelease: 0,
    },
    projects: [],
  };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function profileFromInput(
  owner: string,
  input: ProfileInput,
  user: AuthUser,
): DashboardProfile {
  const normalizedOwner = slugOwner(owner);
  const includeOwners = uniqueSorted(
    stringList(input.includeOwners)
      .map(slugOwner)
      .filter((value) => validOwnerSlug(value) && value !== normalizedOwner),
  );
  const includeRepos = uniqueSorted(
    stringList(input.includeRepos)
      .map((value) => value.trim().replace(/^@/, "").toLowerCase())
      .filter(validRepoSlug),
  );
  if (includeOwners.length + includeRepos.length > maxCustomSources) {
    throw new Error(`too many custom sources; max ${maxCustomSources}`);
  }
  return {
    owner: normalizedOwner,
    includeOwners,
    includeRepos,
    hiddenOwners: uniqueSorted(
      stringList(input.hiddenOwners).map(slugOwner).filter(validOwnerSlug),
    ),
    hiddenRepos: uniqueSorted(
      stringList(input.hiddenRepos)
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(validRepoSlug),
    ),
    updatedAt: new Date().toISOString(),
    updatedBy: user.login,
  };
}

export async function profileResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const owner = slugOwner(url.pathname.replace(/^\/api\/profile\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(owner)) {
    return jsonResponse({ error: "invalid owner" }, 400, { "cache-control": "no-store" });
  }
  const session = await currentSession(request, env);
  const canEdit = session?.user.login.toLowerCase() === owner;

  if (request.method === "GET") {
    return jsonResponse({ profile: await readProfile(env, owner), canEdit }, 200, {
      "cache-control": "no-store",
    });
  }
  if (!session) {
    return jsonResponse({ error: "login required" }, 401, { "cache-control": "no-store" });
  }
  if (!canEdit) {
    return jsonResponse({ error: "only the dashboard owner can edit this default" }, 403, {
      "cache-control": "no-store",
    });
  }
  if (request.method === "DELETE") {
    await deleteProfile(env, owner);
    await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
    return jsonResponse({ profile: null, canEdit: true }, 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405, {
      allow: "GET, POST, DELETE",
      "cache-control": "no-store",
    });
  }

  const input = (await request.json().catch(() => null)) as ProfileInput | null;
  if (!input) {
    return jsonResponse({ error: "invalid profile" }, 400, { "cache-control": "no-store" });
  }
  try {
    const profile = profileFromInput(owner, input, session.user);
    await writeProfile(env, profile);
    await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
    return jsonResponse({ profile, canEdit: true }, 200, { "cache-control": "no-store" });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, { "cache-control": "no-store" });
  }
}

export async function adminResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/scheduler" && request.method === "GET") {
    return jsonResponse(await schedulerAdminPayload(env), 200, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/admin/github-access" && request.method === "GET") {
    const hours = Math.max(
      1,
      Math.min(
        72,
        Number.parseInt(url.searchParams.get("hours") ?? "", 10) || githubAccessAdminHours,
      ),
    );
    return jsonResponse(await githubAccessSummary(env, hours), 200, {
      "cache-control": "no-store",
    });
  }
  if (url.pathname === "/api/admin/installations" && request.method === "GET") {
    return jsonResponse(await authFunnelSummary(env), 200, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/admin/installations/sync" && request.method === "POST") {
    try {
      const installations = await syncGithubAppInstallations(env);
      return jsonResponse({ ok: true, installations, count: installations.length }, 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: errorMessage(error) }, 400, {
        "cache-control": "no-store",
      });
    }
  }
  if (url.pathname === "/api/admin/scheduler/run" && request.method === "POST") {
    const result = await schedulerTick(
      env,
      context,
      `manual:${admin.user.login}`,
      schedulerBatchLimit,
    );
    return jsonResponse({ ok: true, ...result }, 200, { "cache-control": "no-store" });
  }
  return jsonResponse({ error: "not found" }, 404, { "cache-control": "no-store" });
}
