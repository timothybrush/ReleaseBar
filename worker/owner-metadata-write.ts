import { slugOwner } from "../scripts/lib/dashboard.js";
import type { DashboardPayload } from "../src/types.js";
import { jsonResponse } from "./http.js";
import type { Env, RequestCf } from "./runtime.js";
import { dashboardTotals } from "./build-progress.js";
import {
  crawlerUserAgentPattern,
  type OwnerMetadataMutation,
  type OwnerMetadataSnapshot,
} from "./config.js";
import {
  canDisplayOwnerCounts,
  canDisplayOwnerMetadata,
  canDisplayOwnerProjectCounts,
  canDisplayOwnerProjectMetadata,
  dashboardWithVisibleProjects,
  newestOwnerTimestamp,
  readCachedRaw,
} from "./dashboard-cache.js";
import {
  mergeProjectCountFields,
  mergeProjectIssuePullCounts,
  mergeProjectMetadata,
  ownerSnapshotWithCounts,
  readDurableOwnerMetadata,
  readOwnerMetadataKv,
  writeOwnerMetadata,
} from "./owner-metadata-read.js";

export function applyOwnerMetadataMutation(
  owner: string,
  existing: OwnerMetadataSnapshot | null,
  mutation: OwnerMetadataMutation,
): OwnerMetadataSnapshot | null {
  if (mutation.kind === "counts") {
    return existing
      ? ownerSnapshotWithCounts(existing, mutation.counts, mutation.updatedAt, mutation.complete)
      : null;
  }

  if (mutation.kind === "visibility") {
    if (!existing) return null;
    const latestObservation = Math.max(
      safeIso(existing.projectMetadataUpdatedAt[mutation.fullName]),
      safeIso(existing.projectCountsUpdatedAt[mutation.fullName]),
      safeIso(existing.removedRepos[mutation.fullName]),
    );
    if (safeIso(mutation.observedAt) < latestObservation) {
      return existing;
    }
    return {
      ...existing,
      generatedAt:
        safeIso(existing.generatedAt) > safeIso(mutation.observedAt)
          ? existing.generatedAt
          : mutation.observedAt,
      metadataUpdatedAt:
        safeIso(existing.metadataUpdatedAt) > safeIso(mutation.observedAt)
          ? existing.metadataUpdatedAt
          : mutation.observedAt,
      projectMetadataUpdatedAt: {
        ...existing.projectMetadataUpdatedAt,
        [mutation.fullName]:
          safeIso(existing.projectMetadataUpdatedAt[mutation.fullName]) >
          safeIso(mutation.observedAt)
            ? existing.projectMetadataUpdatedAt[mutation.fullName]!
            : mutation.observedAt,
      },
      countOverlays: existing.countOverlays[mutation.fullName]
        ? {
            ...existing.countOverlays,
            [mutation.fullName]: {
              ...existing.countOverlays[mutation.fullName]!,
              archived: mutation.archived,
              updatedAt:
                safeIso(mutation.repositoryUpdatedAt) >=
                safeIso(existing.countOverlays[mutation.fullName]!.updatedAt)
                  ? mutation.repositoryUpdatedAt
                  : existing.countOverlays[mutation.fullName]!.updatedAt,
            },
          }
        : existing.countOverlays,
      projects: existing.projects.map((project) =>
        project.fullName.toLowerCase() === mutation.fullName &&
        safeIso(mutation.observedAt) >=
          safeIso(existing.projectMetadataUpdatedAt[mutation.fullName])
          ? {
              ...project,
              archived: mutation.archived,
              updatedAt:
                safeIso(mutation.repositoryUpdatedAt) >= safeIso(project.updatedAt)
                  ? (mutation.repositoryUpdatedAt ?? project.updatedAt)
                  : project.updatedAt,
            }
          : project,
      ),
    };
  }

  if (mutation.kind === "remove") {
    const project = existing?.projects.find(
      (candidate) => candidate.fullName.toLowerCase() === mutation.fullName,
    );
    const latestRepositoryObservation = Math.max(
      safeIso(existing?.projectMetadataUpdatedAt?.[mutation.fullName]),
      safeIso(existing?.removedRepos?.[mutation.fullName]),
      safeIso(project?.updatedAt),
    );
    if (safeIso(mutation.observedAt) < latestRepositoryObservation) {
      return existing;
    }
    return {
      owner,
      generatedAt:
        safeIso(existing?.generatedAt) > safeIso(mutation.observedAt)
          ? existing!.generatedAt
          : mutation.observedAt,
      metadataUpdatedAt:
        safeIso(existing?.metadataUpdatedAt) > safeIso(mutation.observedAt)
          ? existing!.metadataUpdatedAt
          : mutation.observedAt,
      countsUpdatedAt: existing?.countsUpdatedAt ?? null,
      countsAttemptedAt: existing?.countsAttemptedAt ?? null,
      releaseDataComplete: existing?.releaseDataComplete === true,
      knownRepos: existing?.knownRepos?.filter((repo) => repo !== mutation.fullName) ?? null,
      privateRepos: {
        ...existing?.privateRepos,
        [mutation.fullName]:
          safeIso(existing?.privateRepos?.[mutation.fullName]) > safeIso(mutation.observedAt)
            ? existing!.privateRepos[mutation.fullName]!
            : mutation.observedAt,
      },
      removedRepos: {
        ...existing?.removedRepos,
        [mutation.fullName]:
          safeIso(existing?.removedRepos?.[mutation.fullName]) > safeIso(mutation.observedAt)
            ? existing!.removedRepos[mutation.fullName]!
            : mutation.observedAt,
      },
      projectMetadataUpdatedAt: {
        ...existing?.projectMetadataUpdatedAt,
        [mutation.fullName]:
          safeIso(existing?.projectMetadataUpdatedAt?.[mutation.fullName]) >
          safeIso(mutation.observedAt)
            ? existing!.projectMetadataUpdatedAt[mutation.fullName]!
            : mutation.observedAt,
      },
      projectCountsUpdatedAt: {
        ...existing?.projectCountsUpdatedAt,
      },
      countOverlays: Object.fromEntries(
        Object.entries(existing?.countOverlays ?? {}).filter(
          ([fullName]) => fullName !== mutation.fullName,
        ),
      ),
      projects: (existing?.projects ?? []).filter(
        (project) => project.fullName.toLowerCase() !== mutation.fullName,
      ),
    };
  }

  if (mutation.kind === "restore") {
    if (!existing) return null;
    const removedRepos = { ...existing.removedRepos };
    const privateRepos = { ...existing.privateRepos };
    const accepted = safeIso(mutation.observedAt) >= safeIso(privateRepos[mutation.fullName]);
    if (accepted) {
      delete privateRepos[mutation.fullName];
      delete removedRepos[mutation.fullName];
    }
    return {
      ...existing,
      generatedAt:
        safeIso(existing.generatedAt) > safeIso(mutation.observedAt)
          ? existing.generatedAt
          : mutation.observedAt,
      metadataUpdatedAt:
        safeIso(existing.metadataUpdatedAt) > safeIso(mutation.observedAt)
          ? existing.metadataUpdatedAt
          : mutation.observedAt,
      knownRepos:
        accepted && existing.knownRepos
          ? [...new Set([...existing.knownRepos, mutation.fullName])]
          : existing.knownRepos,
      privateRepos,
      removedRepos,
      projectMetadataUpdatedAt: {
        ...existing.projectMetadataUpdatedAt,
        [mutation.fullName]:
          safeIso(existing.projectMetadataUpdatedAt[mutation.fullName]) >
          safeIso(mutation.observedAt)
            ? existing.projectMetadataUpdatedAt[mutation.fullName]!
            : mutation.observedAt,
      },
    };
  }

  const projects = new Map(
    (existing?.projects ?? []).map((project) => [project.fullName.toLowerCase(), project]),
  );
  const projectMetadataUpdatedAt = { ...existing?.projectMetadataUpdatedAt };
  const projectCountsUpdatedAt = { ...existing?.projectCountsUpdatedAt };
  const countOverlays = { ...existing?.countOverlays };
  const privateRepos = { ...existing?.privateRepos };
  const removedRepos = { ...existing?.removedRepos };
  const incomingNames = new Set(mutation.projects.map((project) => project.fullName.toLowerCase()));
  const removedNames = new Set(mutation.removedRepos);
  const acceptedRemovedNames = new Set<string>();
  const coversExistingProjects = (existing?.projects ?? []).every(
    (project) =>
      incomingNames.has(project.fullName.toLowerCase()) ||
      removedNames.has(project.fullName.toLowerCase()),
  );
  const incomingCountsUpdatedAt =
    mutation.countsComplete &&
    coversExistingProjects &&
    mutation.projects.every(
      (project) => project.openIssues !== null && project.openPullRequests !== null,
    )
      ? mutation.countsUpdatedAt
      : (existing?.countsUpdatedAt ?? null);
  for (const fullName of mutation.removedRepos) {
    if (
      safeIso(mutation.observedAt) >= safeIso(projectMetadataUpdatedAt[fullName]) &&
      fullName.startsWith(`${owner}/`)
    ) {
      projects.delete(fullName);
      delete countOverlays[fullName];
      projectMetadataUpdatedAt[fullName] = mutation.observedAt;
      removedRepos[fullName] = mutation.observedAt;
      acceptedRemovedNames.add(fullName);
    }
  }
  for (const project of mutation.projects) {
    const fullName = project.fullName.toLowerCase();
    if (privateRepos[fullName]) {
      projects.delete(fullName);
      delete countOverlays[fullName];
      continue;
    }
    if (safeIso(mutation.observedAt) <= safeIso(removedRepos[fullName])) {
      continue;
    }
    if (
      existing?.knownRepos &&
      !existing.knownRepos.includes(fullName) &&
      safeIso(existing.countsUpdatedAt) > safeIso(mutation.observedAt)
    ) {
      continue;
    }
    const current = projects.get(fullName);
    const incomingMetadataIsNewer =
      safeIso(mutation.observedAt) >= safeIso(projectMetadataUpdatedAt[fullName]);
    const incomingHasCounts =
      project.openIssues !== null &&
      project.openPullRequests !== null &&
      Boolean(mutation.countsUpdatedAt);
    const incomingProjectCountsAreNewer =
      incomingHasCounts &&
      safeIso(mutation.countsUpdatedAt) > safeIso(projectCountsUpdatedAt[fullName]);
    const preserveCurrentCounts =
      Boolean(current) &&
      (!incomingHasCounts ||
        safeIso(projectCountsUpdatedAt[fullName]) >= safeIso(mutation.countsUpdatedAt));
    if (safeIso(mutation.observedAt) > safeIso(removedRepos[fullName])) {
      delete removedRepos[fullName];
    }
    let merged = project;
    if (current && mutation.mode === "metadata" && incomingMetadataIsNewer) {
      merged = mergeProjectMetadata(current, project);
    } else if (current && !incomingMetadataIsNewer) {
      merged = incomingProjectCountsAreNewer ? mergeProjectCountFields(current, project) : current;
    }
    if (current && preserveCurrentCounts) {
      merged = mergeProjectIssuePullCounts(merged, current);
    }
    projects.set(fullName, merged);
    if (incomingMetadataIsNewer) {
      projectMetadataUpdatedAt[fullName] = mutation.observedAt;
    }
    if (
      incomingHasCounts &&
      !preserveCurrentCounts &&
      safeIso(mutation.countsUpdatedAt) >= safeIso(projectCountsUpdatedAt[fullName])
    ) {
      projectCountsUpdatedAt[fullName] = mutation.countsUpdatedAt!;
      countOverlays[fullName] = {
        fullName,
        openIssues: project.openIssues!,
        openPullRequests: project.openPullRequests!,
        archived: project.archived,
        fork: project.fork === true,
        private: false,
        pushedAt: project.pushedAt,
        updatedAt: project.updatedAt,
      };
    }
  }
  return {
    owner,
    generatedAt:
      safeIso(existing?.generatedAt) > safeIso(mutation.generatedAt)
        ? existing!.generatedAt
        : mutation.generatedAt,
    metadataUpdatedAt:
      safeIso(existing?.metadataUpdatedAt) > safeIso(mutation.observedAt)
        ? existing!.metadataUpdatedAt
        : mutation.observedAt,
    countsUpdatedAt:
      safeIso(existing?.countsUpdatedAt) > safeIso(incomingCountsUpdatedAt)
        ? existing!.countsUpdatedAt
        : incomingCountsUpdatedAt,
    countsAttemptedAt: newestOwnerTimestamp(existing?.countsAttemptedAt, mutation.countsUpdatedAt),
    releaseDataComplete: existing?.releaseDataComplete === true || mutation.releaseDataComplete,
    knownRepos:
      existing?.knownRepos?.filter((fullName) => !acceptedRemovedNames.has(fullName)) ?? null,
    privateRepos,
    removedRepos,
    projectMetadataUpdatedAt,
    projectCountsUpdatedAt,
    countOverlays,
    projects: [...projects.values()],
  };
}

export function isOwnerMetadataMutation(value: unknown): value is OwnerMetadataMutation {
  const mutation = value as OwnerMetadataMutation | null;
  if (!mutation || typeof mutation !== "object" || typeof mutation.kind !== "string") return false;
  if (mutation.kind === "merge") {
    return (
      typeof mutation.generatedAt === "string" &&
      typeof mutation.observedAt === "string" &&
      (mutation.countsUpdatedAt === null || typeof mutation.countsUpdatedAt === "string") &&
      typeof mutation.countsComplete === "boolean" &&
      typeof mutation.releaseDataComplete === "boolean" &&
      (mutation.mode === "metadata" || mutation.mode === "hydrated") &&
      Array.isArray(mutation.projects) &&
      Array.isArray(mutation.removedRepos)
    );
  }
  if (mutation.kind === "counts") {
    return (
      typeof mutation.updatedAt === "string" &&
      typeof mutation.complete === "boolean" &&
      Array.isArray(mutation.counts)
    );
  }
  return (
    (mutation.kind === "visibility" &&
      typeof mutation.fullName === "string" &&
      typeof mutation.archived === "boolean" &&
      typeof mutation.observedAt === "string" &&
      (mutation.repositoryUpdatedAt === null ||
        typeof mutation.repositoryUpdatedAt === "string")) ||
    ((mutation.kind === "remove" || mutation.kind === "restore") &&
      typeof mutation.fullName === "string" &&
      typeof mutation.observedAt === "string")
  );
}

export async function mutateOwnerMetadataSnapshot(
  env: Env,
  owner: string,
  mutation: OwnerMetadataMutation,
): Promise<OwnerMetadataSnapshot | null> {
  const normalizedOwner = slugOwner(owner);
  const requireDurablePrivacy = mutation.kind === "remove" || mutation.kind === "restore";
  if (env.DASHBOARD_LOCKS) {
    try {
      const id = env.DASHBOARD_LOCKS.idFromName(`owner-metadata:${normalizedOwner}`);
      const response = await env.DASHBOARD_LOCKS.get(id).fetch(
        new Request("https://releasebar.internal/owner-metadata/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: normalizedOwner, mutation }),
        }),
      );
      if (response.status === 204) return null;
      if (response.ok) return (await response.json()) as OwnerMetadataSnapshot;
      if (requireDurablePrivacy) {
        throw new Error(`owner metadata mutation returned ${response.status}`);
      }
    } catch (error) {
      if (requireDurablePrivacy) throw error;
      // KV fallback keeps preview and degraded Durable Object paths operational.
    }
  }
  const existing = await readOwnerMetadataKv(env, normalizedOwner);
  const updated = applyOwnerMetadataMutation(normalizedOwner, existing, mutation);
  if (updated) await writeOwnerMetadata(env, updated);
  return updated;
}

export async function mergeOwnerMetadata(
  env: Env,
  payload: DashboardPayload,
  observedAt = payload.generatedAt,
): Promise<DashboardPayload> {
  const owners = [
    ...new Set([
      ...payload.owners.map((owner) => slugOwner(owner.login)),
      ...payload.projects.map((project) => slugOwner(project.owner)),
    ]),
  ];
  if (owners.length === 0) return dashboardWithVisibleProjects(payload);
  const snapshots = (
    await Promise.all(owners.map((owner) => readDurableOwnerMetadata(env, owner)))
  ).filter((snapshot): snapshot is OwnerMetadataSnapshot => Boolean(snapshot));
  if (snapshots.length === 0) return dashboardWithVisibleProjects(payload);
  const snapshotByOwner = new Map(snapshots.map((snapshot) => [snapshot.owner, snapshot]));
  const payloadObservedAt = safeIso(observedAt);
  const payloadProjectCountClocks = payload.cache?.projectCountsUpdatedAt ?? {};
  const payloadCountClock = (fullName: string) =>
    safeIso(
      payloadProjectCountClocks[fullName] ??
        (owners.length === 1 ? payload.cache?.countsUpdatedAt : observedAt),
    );
  const payloadOwnerCountClock = (owner: string) => {
    const ownerProjects = payload.projects.filter((project) => slugOwner(project.owner) === owner);
    const clocks = ownerProjects.map(
      (project) => payloadProjectCountClocks[project.fullName.toLowerCase()],
    );
    if (clocks.length > 0 && clocks.every(Boolean)) {
      return Math.min(...clocks.map((clock) => safeIso(clock)));
    }
    return safeIso(owners.length === 1 ? payload.cache?.countsUpdatedAt : observedAt);
  };
  const countSnapshotNewer = (snapshot: OwnerMetadataSnapshot) =>
    canDisplayOwnerCounts(snapshot) &&
    safeIso(snapshot.countsUpdatedAt) > payloadOwnerCountClock(snapshot.owner);
  const metadataByRepo = new Map(
    snapshots.flatMap((snapshot) =>
      canDisplayOwnerMetadata(snapshot)
        ? snapshot.projects.flatMap((project) => {
            const fullName = project.fullName.toLowerCase();
            return canDisplayOwnerProjectMetadata(snapshot, fullName) &&
              safeIso(snapshot.projectMetadataUpdatedAt[fullName]) > payloadObservedAt
              ? [[fullName, project] as const]
              : [];
          })
        : [],
    ),
  );
  const countsByRepo = new Map(
    snapshots.flatMap((snapshot) =>
      Object.entries(snapshot.countOverlays).flatMap(([fullName, count]) => {
        return canDisplayOwnerProjectCounts(snapshot, fullName) &&
          safeIso(snapshot.projectCountsUpdatedAt[fullName]) > payloadCountClock(fullName) &&
          !count.private
          ? [[fullName, count] as const]
          : [];
      }),
    ),
  );
  const projects = payload.projects.flatMap((project) => {
    const snapshot = snapshotByOwner.get(slugOwner(project.owner));
    if (snapshot?.removedRepos[project.fullName.toLowerCase()]) {
      return [];
    }
    if (
      snapshot &&
      countSnapshotNewer(snapshot) &&
      snapshot.knownRepos &&
      !snapshot.knownRepos.includes(project.fullName.toLowerCase())
    ) {
      return [];
    }
    const metadata = metadataByRepo.get(project.fullName.toLowerCase());
    const counts = countsByRepo.get(project.fullName.toLowerCase());
    const merged = metadata ? mergeProjectMetadata(project, metadata) : project;
    if (!counts) return [merged];
    const fullName = project.fullName.toLowerCase();
    const metadataClock = metadata
      ? safeIso(snapshot?.projectMetadataUpdatedAt[fullName])
      : payloadObservedAt;
    const countClock = safeIso(snapshot?.projectCountsUpdatedAt[fullName]);
    return [
      countClock >= metadataClock
        ? mergeProjectCountFields(merged, counts)
        : mergeProjectIssuePullCounts(merged, counts),
    ];
  });
  const countsUpdatedAt =
    owners.every((owner) => {
      const snapshot = snapshotByOwner.get(owner);
      return snapshot?.countsUpdatedAt && countSnapshotNewer(snapshot);
    }) && projects.every((project) => countsByRepo.has(project.fullName.toLowerCase()))
      ? snapshots
          .map((snapshot) => snapshot.countsUpdatedAt)
          .filter((value): value is string => Boolean(value))
          .sort()[0]
      : (payload.cache?.countsUpdatedAt ?? null);
  const projectCountsUpdatedAt = Object.fromEntries(
    projects.flatMap((project) => {
      const fullName = project.fullName.toLowerCase();
      const snapshot = countsByRepo.get(fullName);
      const updatedAt = snapshot
        ? snapshotByOwner.get(slugOwner(project.owner))?.projectCountsUpdatedAt[fullName]
        : payloadProjectCountClocks[fullName];
      return updatedAt ? [[fullName, updatedAt]] : [];
    }),
  );
  return dashboardWithVisibleProjects({
    ...payload,
    cache: payload.cache
      ? {
          ...payload.cache,
          countsUpdatedAt: countsUpdatedAt ?? payload.cache.countsUpdatedAt ?? null,
          projectCountsUpdatedAt,
        }
      : payload.cache,
    totals: dashboardTotals(projects),
    projects,
  });
}

export async function readCachedWithOwnerMetadata(
  env: Env,
  key: string,
): Promise<DashboardPayload | null> {
  const payload = await readCachedRaw(env, key);
  if (!payload) return null;
  try {
    return await mergeOwnerMetadata(env, payload);
  } catch {
    // Never serve cached public metadata when its durable privacy barrier is unavailable.
    return null;
  }
}

export async function rememberOwnerMetadata(
  env: Env,
  payload: DashboardPayload,
  mode: "metadata" | "hydrated",
  removedRepos: Iterable<string> = [],
  observedAt = payload.generatedAt,
): Promise<void> {
  const removed = new Set([...removedRepos].map((repo) => repo.toLowerCase()));
  const owners = [
    ...new Set([
      ...payload.owners.map((owner) => slugOwner(owner.login)),
      ...payload.projects.map((project) => slugOwner(project.owner)),
    ]),
  ];
  await Promise.all(
    owners.map(async (owner) => {
      const incoming = payload.projects.filter((project) => slugOwner(project.owner) === owner);
      const countsUpdatedAt = payload.cache?.countsUpdatedAt ?? null;
      await mutateOwnerMetadataSnapshot(env, owner, {
        kind: "merge",
        generatedAt: payload.generatedAt,
        observedAt,
        countsUpdatedAt,
        countsComplete: payload.cache?.progress?.done !== false,
        releaseDataComplete: mode === "hydrated" && payload.cache?.progress?.done !== false,
        mode,
        projects: incoming,
        removedRepos: [...removed],
      });
    }),
  );
}

export function safeIso(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isCrawlerRequest(request: Request): boolean {
  const cf = (request as Request & { cf?: RequestCf }).cf;
  if (cf?.verifiedBotCategory || cf?.botManagement?.verifiedBot) return true;
  return crawlerUserAgentPattern.test(request.headers.get("user-agent") ?? "");
}

export function allowRequestRefresh(request: Request): boolean {
  return !isCrawlerRequest(request);
}

export function crawlerCacheOnlyResponse(message: string, status = 202): Response {
  return jsonResponse(
    {
      error: message,
      cache: {
        state: "warming",
        stale: true,
        generatedAt: new Date().toISOString(),
        message,
      },
    },
    status,
    { "cache-control": "no-store" },
  );
}
