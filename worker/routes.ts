function pathParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function isRepoDetailApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return parts.length === 4 && parts[0] === "api" && parts[1] === "repos";
}

export function isRepoAudienceApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return (
    parts.length === 5 && parts[0] === "api" && parts[1] === "repos" && parts[4] === "audience"
  );
}

export function isRepoAudienceBackfillApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return (
    parts.length === 6 &&
    parts[0] === "api" &&
    parts[1] === "repos" &&
    parts[4] === "audience" &&
    parts[5] === "backfill"
  );
}

export function isRepoActivityApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return (
    parts.length === 5 && parts[0] === "api" && parts[1] === "repos" && parts[4] === "activity"
  );
}

export function isOwnerActivityApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return parts.length === 3 && parts[0] === "api" && parts[2] === "activity";
}

export function isOwnerEventsApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return parts.length === 3 && parts[0] === "api" && parts[2] === "events";
}

export function isOwnerApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return parts.length === 2 && parts[0] === "api";
}

export function isOwnerRefreshApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  const owner = parts[1] ?? "";
  return isOwnerApiPath(pathname) && owner !== "me" && !owner.startsWith("_");
}

export function isTrustProfileApiPath(pathname: string): boolean {
  const parts = pathParts(pathname);
  return parts.length === 4 && parts[0] === "api" && parts[1] === "users" && parts[3] === "trust";
}
