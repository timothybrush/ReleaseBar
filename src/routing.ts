export type DashboardRoute = {
  owner: string | null;
  apiPath: string;
  label: string;
  isDefault: boolean;
};

export type RouteOptions = {
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased: boolean;
};

export const workerApiOrigin = "https://releasedeck-api.services-91b.workers.dev";

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

export function dashboardRoute(
  pathname: string,
  search = "",
  apiOrigin = workerApiOrigin,
): DashboardRoute {
  const owner = ownerFromPath(pathname);
  const options = optionsFromSearch(search);
  const query = new URLSearchParams();
  if (options.includeForks) query.set("forks", "true");
  if (options.includeArchived) query.set("archived", "true");
  if (options.includeUnreleased) query.set("unreleased", "true");
  const suffix = query.size > 0 ? `?${query}` : "";

  if (!owner) {
    return {
      owner: null,
      apiPath: `./data/projects.json${suffix}`,
      label: "@steipete",
      isDefault: true,
    };
  }

  return {
    owner,
    apiPath: `${apiOrigin}/api/${encodeURIComponent(owner)}${suffix}`,
    label: `@${owner}`,
    isDefault: false,
  };
}
