import { type OwnerRepoCount, slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type { Project } from "../src/types.js";
import { mapConcurrent } from "./concurrency.js";
import type { Env } from "./runtime.js";
import { tryJsonParse } from "./schemas.js";
import { type OwnerMetadataSnapshot, ownerMetadataTtlSeconds } from "./config.js";
import {
  newestOwnerTimestamp,
  normalizeOwnerMetadataSnapshot,
  ownerMetadataKey,
  ownerSnapshotIsNewer,
} from "./dashboard-cache.js";
import { safeIso } from "./owner-metadata-write.js";

export function reconcileOwnerMetadataSnapshots(
  owner: string,
  storedValue: unknown,
  cachedValue: unknown,
  durablePrivacy = false,
): OwnerMetadataSnapshot | null {
  const stored = normalizeOwnerMetadataSnapshot(owner, storedValue);
  const cached = normalizeOwnerMetadataSnapshot(owner, cachedValue);
  const snapshots = [stored, cached].filter(
    (snapshot): snapshot is OwnerMetadataSnapshot => snapshot !== null,
  );
  if (snapshots.length === 0) return null;
  if (snapshots.length === 1) return snapshots[0]!;

  const authority = snapshots.reduce((current, candidate) =>
    ownerSnapshotIsNewer(candidate, current) ? candidate : current,
  );
  const names = new Set<string>();
  for (const snapshot of [authority, ...snapshots]) {
    for (const project of snapshot.projects) names.add(project.fullName.toLowerCase());
    for (const name of snapshot.knownRepos ?? []) names.add(name);
    for (const name of Object.keys(snapshot.privateRepos)) names.add(name);
    for (const name of Object.keys(snapshot.removedRepos)) names.add(name);
    for (const name of Object.keys(snapshot.projectMetadataUpdatedAt)) names.add(name);
    for (const name of Object.keys(snapshot.projectCountsUpdatedAt)) names.add(name);
    for (const name of Object.keys(snapshot.countOverlays)) names.add(name);
  }

  const privateRepos =
    durablePrivacy && stored
      ? { ...stored.privateRepos }
      : Object.fromEntries(
          [...names].flatMap((fullName) => {
            const privatizedAt = newestOwnerTimestamp(
              ...snapshots.map((snapshot) => snapshot.privateRepos[fullName]),
            );
            return privatizedAt ? [[fullName, privatizedAt]] : [];
          }),
        );
  const removedRepos: Record<string, string> = {};
  const projectMetadataUpdatedAt: Record<string, string> = {};
  const projectCountsUpdatedAt: Record<string, string> = {};
  const countOverlays: Record<string, OwnerRepoCount> = {};
  const projects: Project[] = [];
  const authoritativeRepos = authority.knownRepos === null ? null : new Set(authority.knownRepos);

  for (const fullName of names) {
    const privatizedAt = privateRepos[fullName];
    const removedAt = newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.removedRepos[fullName]),
    );
    const metadataAt = newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.projectMetadataUpdatedAt[fullName]),
    );
    const countsAt = newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.projectCountsUpdatedAt[fullName]),
    );
    if (metadataAt) projectMetadataUpdatedAt[fullName] = metadataAt;
    if (countsAt) projectCountsUpdatedAt[fullName] = countsAt;
    const countOverlay = snapshots
      .map((snapshot) => ({
        count: snapshot.countOverlays[fullName],
        observedAt: snapshot.projectCountsUpdatedAt[fullName],
      }))
      .filter((candidate): candidate is { count: OwnerRepoCount; observedAt: string } =>
        Boolean(candidate.count && candidate.observedAt),
      )
      .sort((left, right) => safeIso(right.observedAt) - safeIso(left.observedAt))[0];
    if (countOverlay) countOverlays[fullName] = countOverlay.count;
    if (privatizedAt) {
      removedRepos[fullName] = newestOwnerTimestamp(privatizedAt, removedAt)!;
      continue;
    }

    let metadataSource: { project: Project; observedAt: string | null } | null = null;
    let countSource: { project: Project; observedAt: string | null } | null = null;
    for (const snapshot of snapshots) {
      const project = snapshot.projects.find(
        (candidate) => candidate.fullName.toLowerCase() === fullName,
      );
      if (!project) continue;
      const projectMetadataAt =
        snapshot.projectMetadataUpdatedAt[fullName] ?? snapshot.metadataUpdatedAt;
      if (!metadataSource || safeIso(projectMetadataAt) >= safeIso(metadataSource.observedAt)) {
        metadataSource = { project, observedAt: projectMetadataAt };
      }
      const projectCountsAt = snapshot.projectCountsUpdatedAt[fullName] ?? snapshot.countsUpdatedAt;
      if (!countSource || safeIso(projectCountsAt) >= safeIso(countSource.observedAt)) {
        countSource = { project, observedAt: projectCountsAt };
      }
    }

    const publicMetadataAt = metadataSource?.observedAt ?? null;
    if (removedAt && safeIso(removedAt) >= safeIso(publicMetadataAt)) {
      removedRepos[fullName] = removedAt;
      continue;
    }
    if (!metadataSource) continue;
    if (
      authoritativeRepos &&
      !authoritativeRepos.has(fullName) &&
      safeIso(publicMetadataAt) <= safeIso(authority.countsUpdatedAt)
    ) {
      continue;
    }

    let project = metadataSource.project;
    if (countSource) {
      project =
        safeIso(countSource.observedAt) > safeIso(publicMetadataAt)
          ? mergeProjectCountFields(project, countSource.project)
          : mergeProjectIssuePullCounts(project, countSource.project);
    }
    projects.push(project);
  }

  const knownRepos =
    authority.knownRepos === null
      ? null
      : [
          ...new Set([
            ...authority.knownRepos,
            ...projects
              .filter(
                (project) =>
                  safeIso(projectMetadataUpdatedAt[project.fullName.toLowerCase()]) >
                  safeIso(authority.countsUpdatedAt),
              )
              .map((project) => project.fullName.toLowerCase()),
          ]),
        ].filter((fullName) => !removedRepos[fullName]);

  return {
    owner,
    generatedAt: newestOwnerTimestamp(...snapshots.map((snapshot) => snapshot.generatedAt))!,
    metadataUpdatedAt: newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.metadataUpdatedAt),
    )!,
    countsUpdatedAt: newestOwnerTimestamp(...snapshots.map((snapshot) => snapshot.countsUpdatedAt)),
    countsAttemptedAt: newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.countsAttemptedAt),
    ),
    releaseDataComplete: snapshots.some((snapshot) => snapshot.releaseDataComplete),
    knownRepos,
    privateRepos,
    removedRepos,
    projectMetadataUpdatedAt,
    projectCountsUpdatedAt,
    countOverlays,
    projects,
  };
}

export async function readOwnerMetadataKv(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  const raw = await env.DASHBOARD_CACHE?.get(ownerMetadataKey(owner));
  if (!raw) return null;
  return normalizeOwnerMetadataSnapshot(
    owner,
    tryJsonParse<OwnerMetadataSnapshot>(raw, `owner metadata ${owner}`),
  );
}

export async function readDurableOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  const normalizedOwner = slugOwner(owner);
  if (!env.DASHBOARD_LOCKS) return readOwnerMetadataKv(env, normalizedOwner);
  const id = env.DASHBOARD_LOCKS.idFromName(`owner-metadata:${normalizedOwner}`);
  const response = await env.DASHBOARD_LOCKS.get(id).fetch(
    new Request("https://releasebar.internal/owner-metadata/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: normalizedOwner }),
    }),
  );
  if (response.status === 404 || response.status === 409) {
    return readOwnerMetadataKv(env, normalizedOwner);
  }
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`owner metadata read returned ${response.status}`);
  }
  return normalizeOwnerMetadataSnapshot(normalizedOwner, await response.json());
}

export async function readOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  return readOwnerMetadataKv(env, owner);
}

export type PublicCacheBarrier = "clear" | "blocked" | "unknown";

export async function repositoryPublicCacheBarrier(
  env: Env,
  fullName: string,
): Promise<PublicCacheBarrier> {
  const normalized = fullName.toLowerCase();
  const owner = normalized.split("/")[0];
  if (!owner) return "blocked";
  try {
    const snapshot = await readDurableOwnerMetadata(env, owner);
    return snapshot?.removedRepos[normalized] || snapshot?.privateRepos[normalized]
      ? "blocked"
      : "clear";
  } catch {
    return "unknown";
  }
}

export async function privateRepositoryNames(
  env: Env,
  fullNames: string[],
): Promise<Set<string> | null> {
  const normalized = [...new Set(fullNames.map((fullName) => fullName.toLowerCase()))];
  const owners = [
    ...new Set(
      normalized
        .map((fullName) => fullName.split("/")[0] ?? "")
        .filter((owner) => validOwnerSlug(owner)),
    ),
  ];
  try {
    const snapshots = await mapConcurrent(
      owners,
      8,
      async (owner) => [owner, await readDurableOwnerMetadata(env, owner)] as const,
    );
    const byOwner = new Map(snapshots);
    return new Set(
      normalized.filter((fullName) => {
        const owner = fullName.split("/")[0] ?? "";
        return Boolean(byOwner.get(owner)?.privateRepos[fullName]);
      }),
    );
  } catch {
    return null;
  }
}

export async function writeOwnerMetadata(env: Env, snapshot: OwnerMetadataSnapshot): Promise<void> {
  await env.DASHBOARD_CACHE?.put(ownerMetadataKey(snapshot.owner), JSON.stringify(snapshot), {
    expirationTtl: ownerMetadataTtlSeconds,
  });
}

export function mergeProjectMetadata(project: Project, metadata: Project): Project {
  return {
    ...project,
    owner: metadata.owner,
    name: metadata.name,
    fullName: metadata.fullName,
    description: metadata.description,
    url: metadata.url,
    defaultBranch: metadata.defaultBranch,
    language: metadata.language,
    topics: metadata.topics,
    stars: metadata.stars,
    forks: metadata.forks,
    issuesUrl: metadata.issuesUrl,
    pullRequestsUrl: metadata.pullRequestsUrl,
    archived: metadata.archived,
    fork: metadata.fork,
    pushedAt: metadata.pushedAt,
    updatedAt: metadata.updatedAt,
  };
}

export function projectWithoutReleaseData(project: Project): Project {
  return {
    ...project,
    openIssues: null,
    openPullRequests: null,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `${project.url}/releases`,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "hot",
  };
}

export function mergeProjectCountFields(
  project: Project,
  counts: Project | OwnerRepoCount,
): Project {
  return {
    ...project,
    openIssues: counts.openIssues ?? project.openIssues,
    openPullRequests: counts.openPullRequests ?? project.openPullRequests,
    archived: counts.archived,
    fork: counts.fork,
    pushedAt: counts.pushedAt,
    updatedAt: counts.updatedAt,
  };
}

export function mergeProjectIssuePullCounts(
  project: Project,
  counts: Project | OwnerRepoCount,
): Project {
  return {
    ...project,
    openIssues: counts.openIssues ?? project.openIssues,
    openPullRequests: counts.openPullRequests ?? project.openPullRequests,
  };
}

export function ownerSnapshotWithCounts(
  snapshot: OwnerMetadataSnapshot,
  counts: OwnerRepoCount[],
  updatedAt: string,
  complete: boolean,
): OwnerMetadataSnapshot {
  if (safeIso(updatedAt) < safeIso(snapshot.countsAttemptedAt)) {
    return snapshot;
  }
  const byName = new Map(counts.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const publicNames = new Set(
    counts.filter((repo) => !repo.private).map((repo) => repo.fullName.toLowerCase()),
  );
  const privateNames = counts
    .filter((repo) => repo.private)
    .map((repo) => repo.fullName.toLowerCase());
  const newerMetadataNames = new Set(
    Object.entries(snapshot.projectMetadataUpdatedAt)
      .filter(([, metadataUpdatedAt]) => safeIso(metadataUpdatedAt) > safeIso(updatedAt))
      .map(([fullName]) => fullName),
  );
  const removedRepos = { ...snapshot.removedRepos };
  const projectCountsUpdatedAt = { ...snapshot.projectCountsUpdatedAt };
  const countOverlays = { ...snapshot.countOverlays };
  for (const fullName of publicNames) {
    if (snapshot.privateRepos[fullName]) continue;
    if (safeIso(updatedAt) > safeIso(removedRepos[fullName])) {
      delete removedRepos[fullName];
    }
  }
  for (const fullName of privateNames) {
    if (newerMetadataNames.has(fullName)) continue;
    if (safeIso(updatedAt) >= safeIso(removedRepos[fullName])) {
      removedRepos[fullName] = updatedAt;
    }
    delete countOverlays[fullName];
  }
  if (complete) {
    for (const fullName of Object.keys(countOverlays)) {
      if (!publicNames.has(fullName) && !newerMetadataNames.has(fullName)) {
        delete countOverlays[fullName];
      }
    }
  }
  for (const count of counts) {
    const fullName = count.fullName.toLowerCase();
    if (count.private || newerMetadataNames.has(fullName)) continue;
    countOverlays[fullName] = { ...count, fullName };
    if (safeIso(updatedAt) >= safeIso(projectCountsUpdatedAt[fullName])) {
      projectCountsUpdatedAt[fullName] = updatedAt;
    }
  }
  return {
    ...snapshot,
    countsUpdatedAt: complete ? updatedAt : snapshot.countsUpdatedAt,
    countsAttemptedAt: updatedAt,
    knownRepos: complete
      ? [
          ...new Set([
            ...publicNames,
            ...(snapshot.knownRepos ?? []).filter((fullName) => newerMetadataNames.has(fullName)),
            ...snapshot.projects
              .map((project) => project.fullName.toLowerCase())
              .filter((fullName) => newerMetadataNames.has(fullName)),
          ]),
        ]
      : (snapshot.knownRepos ?? null),
    removedRepos,
    countOverlays,
    projects: snapshot.projects.flatMap((project) => {
      const fullName = project.fullName.toLowerCase();
      if (snapshot.privateRepos[fullName]) return [];
      const count = byName.get(fullName);
      const preserveNewerMetadata = newerMetadataNames.has(fullName);
      if (!count) return complete && !preserveNewerMetadata ? [] : [project];
      if (count.private) return preserveNewerMetadata ? [project] : [];
      return [
        {
          ...project,
          openIssues: count.openIssues,
          openPullRequests: count.openPullRequests,
          archived: preserveNewerMetadata ? project.archived : count.archived,
          fork: preserveNewerMetadata ? project.fork : count.fork,
          pushedAt: preserveNewerMetadata ? project.pushedAt : count.pushedAt,
          updatedAt: preserveNewerMetadata ? project.updatedAt : count.updatedAt,
        },
      ];
    }),
    projectCountsUpdatedAt,
  };
}
