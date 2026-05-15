export type DashboardRoute = {
  owner: string | null;
  apiPath: string;
  fallbackApiPath: string | null;
  label: string;
  isDefault: boolean;
  extraOwners: string[];
  repos: string[];
};

export type RouteOptions = {
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased: boolean;
};

export const workerApiOrigin = "";
export const workersDevApiOrigin = "https://releasedeck-api.steipete.workers.dev";
const ownerListKey = "owners";
const repoListKey = "repos";

export function ownerFromPath(pathname: string): string | null {
  const [first] = pathname.split("/").filter(Boolean);
  if (!first || first === "index.html") {
    return null;
  }
  const owner = decodeURIComponent(first).trim().replace(/^@/, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) {
    return null;
  }
  return owner;
}

export function optionsFromSearch(search: string): RouteOptions {
  const params = new URLSearchParams(search);
  return {
    includeForks: params.get("forks") === "true",
    includeArchived: params.get("archived") === "true",
    includeUnreleased: params.get("unreleased") === "true",
  };
}

export function listParam(search: string, key: string): string[] {
  const params = new URLSearchParams(search);
  return [
    ...new Set(
      (params.get(key) ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function validRepoSlug(repo: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d._-]{1,100}$/i.test(repo);
}

export function dashboardRoute(
  pathname: string,
  search = "",
  apiOrigin = workerApiOrigin,
): DashboardRoute {
  const owner = ownerFromPath(pathname);
  const options = optionsFromSearch(search);
  const extraOwners = listParam(search, ownerListKey).filter(
    (extraOwner) =>
      /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(extraOwner) &&
      extraOwner !== owner?.toLowerCase(),
  );
  const repos = listParam(search, repoListKey).filter(validRepoSlug);
  const query = new URLSearchParams();
  if (options.includeForks) query.set("forks", "true");
  if (options.includeArchived) query.set("archived", "true");
  if (options.includeUnreleased) query.set("unreleased", "true");
  if (extraOwners.length > 0) query.set(ownerListKey, extraOwners.join(","));
  if (repos.length > 0) query.set(repoListKey, repos.join(","));
  const suffix = query.size > 0 ? `?${query}` : "";

  if (!owner) {
    const custom = extraOwners.length > 0 || repos.length > 0;
    const apiPath = custom ? `/api/dashboard${suffix}` : `/api/_hot${suffix}`;
    return {
      owner: null,
      apiPath: `${apiOrigin}${apiPath}`,
      fallbackApiPath: apiOrigin === "" ? `${workersDevApiOrigin}${apiPath}` : null,
      label: custom ? "custom deck" : "ReleaseBar Hot",
      isDefault: !custom,
      extraOwners,
      repos,
    };
  }

  const ownerPath = `/api/${encodeURIComponent(owner)}${suffix}`;
  return {
    owner,
    apiPath: `${apiOrigin}${ownerPath}`,
    fallbackApiPath: apiOrigin === "" ? `${workersDevApiOrigin}${ownerPath}` : null,
    label:
      extraOwners.length > 0 || repos.length > 0
        ? `@${owner} +${extraOwners.length + repos.length}`
        : `@${owner}`,
    isDefault: false,
    extraOwners,
    repos,
  };
}
