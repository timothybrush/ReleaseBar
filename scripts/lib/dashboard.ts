export {
  GitHubRateLimitError,
  type DashboardBuildOptions,
  type OwnerRepoCount,
} from "./dashboard-contracts.js";
export { fetchOwnerRepoCounts } from "./dashboard-github.js";
export { resolveOwnerType } from "./dashboard-project-cache.js";
export {
  dashboardCacheKey,
  filterRepo,
  freshness,
  normalizeBuildOptions,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "./dashboard-projects.js";

import type { DashboardPayload, Project } from "../../src/types.js";
import type { DashboardBuildOptions, GitHubClient, GitHubRepo } from "./dashboard-contracts.js";
import {
  githubClient,
  hydrateRepoDetailsOrEmpty,
  ownerRepos,
  ownerReposPage,
  repoByFullName,
  repoSummary,
  repoWithGraphqlDetails,
  repoWithSplitIssueCounts,
} from "./dashboard-github.js";
import {
  prioritizedHydrationQueue,
  readProjectCache,
  writeProjectCache,
} from "./dashboard-project-cache.js";
import {
  filterRepo,
  freshness,
  isRepoSearchProject,
  mergeRepoMetadata,
  repoSearchProject,
  slugOwner,
} from "./dashboard-projects.js";

export async function buildDashboard(options: DashboardBuildOptions): Promise<DashboardPayload> {
  const includeReleaseData = options.includeReleaseData ?? true;
  const defaultClient = githubClient(
    options.token,
    options.fetch,
    options.quotaSource,
    options.quotaAccount ?? null,
  );
  const ownerClients = new Map<string, GitHubClient>();
  const clientForOwner = (owner: string): GitHubClient => {
    const login = slugOwner(owner);
    const existing = ownerClients.get(login);
    if (existing) return existing;
    const credential = options.ownerCredentials?.[login];
    const client = credential
      ? githubClient(
          credential.token,
          credential.fetch ?? options.fetch,
          credential.quotaSource,
          credential.quotaAccount,
        )
      : defaultClient;
    ownerClients.set(login, client);
    return client;
  };
  const projects: Project[] = [...(options.initialProjects ?? [])];
  const ownerPageSize = Math.max(1, Math.min(100, Math.trunc(options.ownerPageSize ?? 100)));
  let capped = false;
  let scanIncomplete = false;
  let scannedThisRun = 0;
  let countsObservedAt: string | null = null;
  let countsQueryPerformed = false;
  const countedThisRun = new Set<string>();
  const seen = new Set<string>();
  const skippedRepos = new Set((options.skipRepos ?? []).map((repo) => repo.toLowerCase()));
  const reusedCheckpointData = skippedRepos.size > 0;
  for (const project of projects) {
    seen.add(project.fullName.toLowerCase());
  }

  function beginCountQuery(): void {
    countsQueryPerformed = true;
    countsObservedAt ??= new Date().toISOString();
  }

  function observeCounts(repos: GitHubRepo[]): void {
    for (const repo of repos) {
      if (repo.open_issues_total !== undefined && repo.open_pull_requests_total !== undefined) {
        countedThisRun.add(repo.full_name.toLowerCase());
      }
    }
  }

  function payload(state: NonNullable<DashboardPayload["cache"]>["state"]): DashboardPayload {
    const sortedProjects = [...projects].sort((a, b) => {
      const aDate = a.pushedAt ? Date.parse(a.pushedAt) : 0;
      const bDate = b.pushedAt ? Date.parse(b.pushedAt) : 0;
      return bDate - aDate;
    });
    const generatedAt = new Date().toISOString();
    const completedHydrationAt = (previous: string | null | undefined): string | null => {
      if (options.generationStartedAt) {
        return Date.parse(previous ?? "") > Date.parse(options.generationStartedAt)
          ? (previous ?? null)
          : options.generationStartedAt;
      }
      return reusedCheckpointData ? (previous ?? null) : generatedAt;
    };
    const released = projects.filter((project) => project.releaseDate).length;
    const scanned = skippedRepos.size + scannedThisRun;
    const countsAuthoritative =
      countsQueryPerformed &&
      sortedProjects.every(
        (project) =>
          countedThisRun.has(project.fullName.toLowerCase()) &&
          project.openIssues !== null &&
          project.openPullRequests !== null,
      );
    const projectCountsUpdatedAt = Object.fromEntries(
      sortedProjects.flatMap((project) => {
        const fullName = project.fullName.toLowerCase();
        const updatedAt = countedThisRun.has(fullName)
          ? countsObservedAt
          : options.previousProjectCountsUpdatedAt?.[fullName];
        return updatedAt ? [[fullName, updatedAt]] : [];
      }),
    );
    const progress = options.repoScanTarget
      ? {
          scanned,
          limit: options.repoScanTarget,
          done: state !== "partial" && !scanIncomplete,
        }
      : undefined;
    const usedQuotas = [...new Set(ownerClients.values())].map((client) => client.quota);
    const quota =
      usedQuotas.length === 0
        ? defaultClient.quota
        : usedQuotas.every((item) => item.source === "app")
          ? {
              source: "app" as const,
              account:
                new Set(usedQuotas.map((item) => item.account).filter(Boolean)).size === 1
                  ? (usedQuotas.find((item) => item.account)?.account ?? null)
                  : null,
              remaining:
                usedQuotas
                  .map((item) => item.remaining)
                  .filter((value): value is number => value !== null)
                  .sort((left, right) => left - right)[0] ?? null,
              limit:
                usedQuotas
                  .map((item) => item.limit)
                  .filter((value): value is number => value !== null)
                  .sort((left, right) => left - right)[0] ?? null,
              resetAt:
                usedQuotas
                  .map((item) => item.resetAt)
                  .filter((value): value is string => value !== null)
                  .sort()[0] ?? null,
              resource:
                new Set(usedQuotas.map((item) => item.resource).filter(Boolean)).size === 1
                  ? (usedQuotas.find((item) => item.resource)?.resource ?? null)
                  : null,
            }
          : defaultClient.quota;
    return {
      title: options.title,
      subtitle: options.subtitle,
      canonicalDomain: options.canonicalDomain,
      generatedAt,
      owners: options.owners,
      options: {
        includeForks: options.includeForks,
        includeArchived: options.includeArchived,
        includeUnreleased: Boolean(options.includeUnreleased),
        repoLimit: options.repoLimit ?? null,
      },
      cache: {
        state,
        stale: state !== "fresh",
        capped,
        repoLimit: options.repoLimit ?? null,
        generatedAt,
        countsUpdatedAt: countsAuthoritative
          ? (countsObservedAt ?? options.previousCountsUpdatedAt ?? generatedAt)
          : (options.previousCountsUpdatedAt ?? null),
        projectCountsUpdatedAt,
        releasesUpdatedAt: includeReleaseData
          ? state === "fresh"
            ? completedHydrationAt(options.previousReleasesUpdatedAt)
            : (options.previousReleasesUpdatedAt ?? null)
          : null,
        ciUpdatedAt: includeReleaseData
          ? state === "fresh"
            ? completedHydrationAt(options.previousCiUpdatedAt)
            : (options.previousCiUpdatedAt ?? null)
          : null,
        quota,
        ...(progress ? { progress } : {}),
        ...(!includeReleaseData
          ? {
              message: "release scan skipped until this account is synced with GitHub App quota",
            }
          : progress && !progress.done
            ? {
                message: `scanned ${progress.scanned}${progress.limit ? `/${progress.limit}` : ""} recently pushed repos; still updating`,
              }
            : capped && options.repoScanLimit
              ? {
                  message: `scanned ${options.repoScanLimit} recently pushed repos per owner`,
                }
              : {}),
      },
      totals: {
        repos: sortedProjects.length,
        released,
        unreleased: sortedProjects.length - released,
        commitsSinceRelease: sortedProjects.reduce(
          (sum, project) => sum + (project.commitsSinceRelease || 0),
          0,
        ),
      },
      projects: sortedProjects,
    };
  }

  if (!includeReleaseData && !options.includeUnreleased) {
    projects.splice(0, projects.length);
    return payload("fresh");
  }

  async function addRepo(
    repo: GitHubRepo,
    countLabel: string,
    force = false,
    client = clientForOwner(repo.owner.login),
  ): Promise<boolean> {
    const existingIndex = projects.findIndex(
      (project) => project.fullName.toLowerCase() === repo.full_name.toLowerCase(),
    );
    if (existingIndex >= 0 && !isRepoSearchProject(projects[existingIndex]!)) {
      return true;
    }
    if (
      (!force && existingIndex < 0 && seen.has(repo.full_name.toLowerCase())) ||
      !filterRepo(repo, options)
    ) {
      return false;
    }
    seen.add(repo.full_name.toLowerCase());
    options.log?.(`fetch ${countLabel} ${repo.full_name}`);
    const includeUnreleased = Boolean(options.includeUnreleased);
    const cached = await readProjectCache(
      options.projectCache,
      repo,
      includeUnreleased,
      includeReleaseData,
    );
    const project =
      cached ??
      (includeReleaseData
        ? await repoSummary(client, repo, includeUnreleased)
        : includeUnreleased
          ? repoSearchProject(repo)
          : null);
    if (!project) {
      if (existingIndex >= 0) {
        projects.splice(existingIndex, 1);
      }
      options.log?.(`skip ${repo.full_name}: no releases`);
      return false;
    }
    const projectWithFreshMetadata = mergeRepoMetadata(project, repo);
    if (!cached) {
      await writeProjectCache(
        options.projectCache,
        repo,
        includeUnreleased,
        includeReleaseData,
        projectWithFreshMetadata,
      );
    }
    const hydrated = {
      ...projectWithFreshMetadata,
      freshness: freshness(projectWithFreshMetadata),
    };
    if (existingIndex >= 0) {
      projects[existingIndex] = hydrated;
    } else {
      projects.push(hydrated);
    }
    return true;
  }

  if (options.repoLimit) {
    for (const owner of options.owners) {
      const client = clientForOwner(owner.login);
      const effectiveQuotaSource = client.quota.source;
      const ownerExisting = projects.filter(
        (project) => project.owner.toLowerCase() === owner.login.toLowerCase(),
      ).length;
      let ownerVisible = ownerExisting;
      let hydratedThisOwner = 0;
      let page = 1;
      const scanLimit = options.repoScanLimit ?? Number.POSITIVE_INFINITY;
      const configuredOwnerPageLimit =
        options.ownerPageLimit === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(1, Math.trunc(options.ownerPageLimit));
      const quotaOwnerPageLimit =
        effectiveQuotaSource === "shared" && includeReleaseData ? 3 : Number.POSITIVE_INFINITY;
      const ownerPageLimit = Math.min(configuredOwnerPageLimit, quotaOwnerPageLimit);
      if (includeReleaseData && options.includeUnreleased) {
        const hydrateQueue: GitHubRepo[] = [];
        const hydrationQueued = new Set<string>();
        const liveOwnerRepos = new Set<string>();
        const observedOwnerRepos = new Set<string>();
        const removedRepos: string[] = [];
        const absentRepos: string[] = [];
        const observedArchivedProjects = new Map<string, Project>();
        const explicitRepos = new Set(
          (options.includeRepos ?? []).map((repo) => repo.toLowerCase()),
        );
        const pageSignatures = new Set<string>();
        let metadataChanged = false;
        let liveOwnerVisible = 0;
        let enumerationComplete = false;
        const hasScanLimit = Number.isFinite(scanLimit);
        const collectPriorityCandidates =
          options.hydrateSort === "issues" || options.hydrateSort === "prs";
        while (
          ownerVisible < options.repoLimit ||
          (hasScanLimit && hydrateQueue.length < scanLimit) ||
          collectPriorityCandidates
        ) {
          beginCountQuery();
          const ownerPage = await ownerReposPage(
            client,
            owner,
            includeReleaseData,
            page,
            ownerPageSize,
          );
          const repos = ownerPage.repos;
          observeCounts(repos);
          const pageSignature =
            repos.length > 0
              ? repos.map((repo) => repo.full_name.toLowerCase()).join("\n")
              : ownerPage.cursor !== undefined
                ? `empty:graphql:${ownerPage.cursor ?? "root"}`
                : `empty:rest:${page}`;
          if (pageSignatures.has(pageSignature)) {
            capped = true;
            if (
              options.repoScanTarget &&
              skippedRepos.size + scannedThisRun + hydrateQueue.length < options.repoScanTarget
            ) {
              scanIncomplete = true;
            }
            break;
          }
          pageSignatures.add(pageSignature);
          if (repos.length === 0) {
            if (!ownerPage.hasNextPage) {
              enumerationComplete = true;
              break;
            }
            if (page >= ownerPageLimit) {
              capped = true;
              break;
            }
            page += 1;
            continue;
          }
          let exhaustedPage = false;
          for (const [index, repo] of repos.entries()) {
            const fullName = repo.full_name.toLowerCase();
            if (!repo.private) {
              observedOwnerRepos.add(fullName);
              if (repo.archived) {
                observedArchivedProjects.set(fullName, repoSearchProject(repo));
              }
            }
            if (!filterRepo(repo, options)) {
              continue;
            }
            if (liveOwnerVisible >= options.repoLimit) {
              capped = true;
              exhaustedPage = true;
              break;
            }
            liveOwnerVisible += 1;
            liveOwnerRepos.add(fullName);
            const existingIndex = projects.findIndex(
              (project) => project.fullName.toLowerCase() === fullName,
            );
            let visibleForHydration = false;
            if (existingIndex >= 0) {
              projects[existingIndex] = mergeRepoMetadata(projects[existingIndex]!, repo);
              metadataChanged = true;
              visibleForHydration = true;
            } else if (ownerVisible < options.repoLimit) {
              projects.push(repoSearchProject(repo));
              seen.add(fullName);
              ownerVisible += 1;
              metadataChanged = true;
              visibleForHydration = true;
              if (
                ownerVisible >= options.repoLimit &&
                (index < repos.length - 1 || repos.length === ownerPageSize)
              ) {
                capped = true;
              }
            } else {
              const replaceIndex = projects.reduce((oldestIndex, project, projectIndex) => {
                if (
                  project.owner.toLowerCase() !== owner.login.toLowerCase() ||
                  explicitRepos.has(project.fullName.toLowerCase()) ||
                  liveOwnerRepos.has(project.fullName.toLowerCase())
                ) {
                  return oldestIndex;
                }
                if (oldestIndex < 0) return projectIndex;
                const oldest = projects[oldestIndex]!;
                const projectDate = Date.parse(project.pushedAt ?? project.updatedAt ?? "") || 0;
                const oldestDate = Date.parse(oldest.pushedAt ?? oldest.updatedAt ?? "") || 0;
                return projectDate <= oldestDate ? projectIndex : oldestIndex;
              }, -1);
              if (replaceIndex >= 0) {
                const [removed] = projects.splice(replaceIndex, 1);
                const removedFullName = removed!.fullName.toLowerCase();
                seen.delete(removedFullName);
                skippedRepos.delete(removedFullName);
                removedRepos.push(removedFullName);
                projects.push(repoSearchProject(repo));
                seen.add(fullName);
                metadataChanged = true;
                visibleForHydration = true;
                capped = true;
              } else {
                capped = true;
                if (
                  options.repoScanTarget &&
                  skippedRepos.size + scannedThisRun + hydrateQueue.length < options.repoScanTarget
                ) {
                  scanIncomplete = true;
                }
                exhaustedPage = true;
              }
            }
            if (
              visibleForHydration &&
              !skippedRepos.has(fullName) &&
              !hydrationQueued.has(fullName)
            ) {
              hydrateQueue.push(repo);
              hydrationQueued.add(fullName);
            }
            if (exhaustedPage) {
              break;
            }
          }
          if (!ownerPage.hasNextPage) {
            enumerationComplete = !exhaustedPage;
            break;
          }
          if (exhaustedPage) {
            break;
          }
          if (page >= ownerPageLimit) {
            capped = true;
            break;
          }
          page += 1;
        }
        if (enumerationComplete) {
          for (let index = projects.length - 1; index >= 0; index -= 1) {
            const project = projects[index]!;
            const fullName = project.fullName.toLowerCase();
            if (
              project.owner.toLowerCase() !== owner.login.toLowerCase() ||
              explicitRepos.has(fullName) ||
              liveOwnerRepos.has(fullName)
            ) {
              continue;
            }
            projects.splice(index, 1);
            seen.delete(fullName);
            skippedRepos.delete(fullName);
            removedRepos.push(fullName);
            if (!observedOwnerRepos.has(fullName)) {
              absentRepos.push(fullName);
            }
            ownerVisible -= 1;
            metadataChanged = true;
          }
        }
        if (metadataChanged || observedArchivedProjects.size > 0) {
          const progressPayload = payload("partial");
          if (progressPayload.cache?.progress) {
            progressPayload.cache.progress.done = false;
          }
          await options.onProgress?.(progressPayload, {
            scannedRepo: "",
            scanned: skippedRepos.size + scannedThisRun,
            done: false,
            phase: "metadata",
            removedRepos,
            absentRepos,
            observedProjects: [...observedArchivedProjects.values()],
          });
        }
        const prioritized = prioritizedHydrationQueue(hydrateQueue, options);
        const hydrationBatch = hasScanLimit ? prioritized.slice(0, scanLimit) : prioritized;
        if (hydrationBatch.length < prioritized.length) {
          if (scanLimit > 0) {
            capped = true;
          }
          if (
            options.repoScanTarget &&
            skippedRepos.size + scannedThisRun + hydrationBatch.length < options.repoScanTarget
          ) {
            scanIncomplete = true;
          }
        }
        const graphqlDetails = await hydrateRepoDetailsOrEmpty(client, hydrationBatch);
        for (let index = 0; index < hydrationBatch.length; index += 4) {
          const hydratedRepos = hydrationBatch
            .slice(index, index + 4)
            .map((repo) => repoWithGraphqlDetails(repo, graphqlDetails));
          await Promise.all(
            hydratedRepos.map((repo) =>
              addRepo(repo, `${owner.login} ${ownerVisible}/${options.repoLimit}`),
            ),
          );
          for (const hydratedRepo of hydratedRepos) {
            hydratedThisOwner += 1;
            scannedThisRun += 1;
            const progressPayload = payload("partial");
            if (progressPayload.cache?.progress) {
              progressPayload.cache.progress.done = false;
            }
            await options.onProgress?.(progressPayload, {
              scannedRepo: hydratedRepo.full_name,
              scanned: skippedRepos.size + scannedThisRun,
              done: false,
              phase: "hydrate",
            });
          }
        }
        continue;
      }
      const pageSignatures = new Set<string>();
      while (ownerVisible < options.repoLimit || hydratedThisOwner < scanLimit) {
        beginCountQuery();
        const ownerPage = await ownerReposPage(
          client,
          owner,
          includeReleaseData,
          page,
          ownerPageSize,
        );
        const repos = ownerPage.repos;
        observeCounts(repos);
        const pageSignature =
          repos.length > 0
            ? repos.map((repo) => repo.full_name.toLowerCase()).join("\n")
            : ownerPage.cursor !== undefined
              ? `empty:graphql:${ownerPage.cursor ?? "root"}`
              : `empty:rest:${page}`;
        if (pageSignatures.has(pageSignature)) {
          capped = true;
          break;
        }
        pageSignatures.add(pageSignature);
        if (repos.length === 0) {
          if (ownerPage.hasNextPage && page < ownerPageLimit) {
            page += 1;
            continue;
          }
          if (ownerPage.hasNextPage) {
            capped = true;
          }
          break;
        }
        const detailLimit = Number.isFinite(scanLimit)
          ? Math.max(0, scanLimit - hydratedThisOwner)
          : repos.length;
        const graphqlDetails =
          includeReleaseData && detailLimit > 0
            ? await hydrateRepoDetailsOrEmpty(
                client,
                repos
                  .filter((repo) => filterRepo(repo, options))
                  .filter((repo) => !skippedRepos.has(repo.full_name.toLowerCase()))
                  .slice(0, detailLimit),
              )
            : new Map<string, Partial<GitHubRepo>>();
        let exhaustedPage = false;
        let visibleAddedThisPage = 0;
        for (const [index, repo] of repos.entries()) {
          const hydratedRepo = repoWithGraphqlDetails(repo, graphqlDetails);
          const fullName = repo.full_name.toLowerCase();
          if (!filterRepo(repo, options)) {
            continue;
          }
          const existingIndex = projects.findIndex(
            (project) => project.fullName.toLowerCase() === fullName,
          );
          let seededVisibleRow = false;
          if (existingIndex < 0 && options.includeUnreleased) {
            if (ownerVisible >= options.repoLimit) {
              capped = true;
              exhaustedPage = true;
              break;
            }
            projects.push(repoSearchProject(repo));
            seen.add(fullName);
            ownerVisible += 1;
            visibleAddedThisPage += 1;
            seededVisibleRow = true;
            if (
              ownerVisible >= options.repoLimit &&
              (index < repos.length - 1 || ownerPage.hasNextPage)
            ) {
              capped = true;
            }
          }
          if (skippedRepos.has(fullName)) {
            continue;
          }
          if (hydratedThisOwner >= scanLimit) {
            if (scanLimit > 0) {
              capped = true;
            }
            if (options.repoScanTarget) {
              scanIncomplete = true;
            }
            if (ownerVisible >= options.repoLimit) {
              exhaustedPage = true;
              break;
            }
            continue;
          }
          hydratedThisOwner += 1;
          scannedThisRun += 1;
          const added = await addRepo(
            hydratedRepo,
            `${owner.login} ${ownerVisible}/${options.repoLimit}`,
          );
          if (added && !seededVisibleRow && existingIndex < 0) {
            ownerVisible += 1;
            visibleAddedThisPage += 1;
            if (ownerVisible >= options.repoLimit) {
              if (index < repos.length - 1 || repos.length === ownerPageSize) {
                capped = true;
              }
              exhaustedPage = true;
            }
          }
          const progressPayload = payload("partial");
          if (progressPayload.cache?.progress) {
            progressPayload.cache.progress.done = false;
          }
          await options.onProgress?.(progressPayload, {
            scannedRepo: hydratedRepo.full_name,
            scanned: skippedRepos.size + scannedThisRun,
            done: false,
            phase: "hydrate",
          });
          if (exhaustedPage) {
            break;
          }
        }
        if (!ownerPage.hasNextPage) {
          break;
        }
        if (exhaustedPage) {
          break;
        }
        if (page >= ownerPageLimit) {
          capped = true;
          break;
        }
        if (hydratedThisOwner >= scanLimit && visibleAddedThisPage === 0) {
          break;
        }
        page += 1;
      }
    }
  } else {
    const repos: GitHubRepo[] = [];
    for (const owner of options.owners) {
      const client = clientForOwner(owner.login);
      beginCountQuery();
      const ownerResult = await ownerRepos(client, owner, includeReleaseData);
      observeCounts(ownerResult);
      repos.push(...ownerResult);
    }

    const uniqueRepos = [
      ...new Map(
        repos.filter((repo) => filterRepo(repo, options)).map((repo) => [repo.full_name, repo]),
      ).values(),
    ];

    for (const [index, repo] of uniqueRepos.entries()) {
      await addRepo(
        repo,
        `${index + 1}/${uniqueRepos.length}`,
        false,
        clientForOwner(repo.owner.login),
      );
    }
  }

  for (const fullName of options.includeRepos ?? []) {
    const client = clientForOwner(fullName.split("/")[0] ?? "");
    beginCountQuery();
    let repo = await repoByFullName(client, fullName);
    if (repo && !includeReleaseData && options.includeUnreleased) {
      repo = await repoWithSplitIssueCounts(client, repo);
    }
    if (repo) {
      observeCounts([repo]);
      await addRepo(repo, `custom`, true);
    }
  }

  await options.onProgress?.(payload(scanIncomplete ? "partial" : "fresh"), {
    scannedRepo: "",
    scanned: skippedRepos.size + scannedThisRun,
    done: !scanIncomplete,
    phase: "complete",
  });
  return payload(scanIncomplete ? "partial" : "fresh");
}
