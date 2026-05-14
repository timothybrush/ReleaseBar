export type Owner = {
  type: "user" | "org";
  login: string;
};

export type ReleaseDeckConfig = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  owners: Owner[];
  includeForks: boolean;
  includeArchived: boolean;
  excludeRepos?: string[];
};

export type Freshness = "fresh" | "warm" | "busy" | "hot" | "unreleased";

export type Project = {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  defaultBranch: string;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  latestCommitSha: string | null;
  latestCommitDate: string | null;
  version: string | null;
  releaseName: string | null;
  releaseUrl: string | null;
  releaseDate: string | null;
  commitsSinceRelease: number | null;
  compareUrl: string | null;
  freshness: Freshness;
};

export type DashboardPayload = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  generatedAt: string;
  owners: Owner[];
  totals: {
    repos: number;
    released: number;
    unreleased: number;
    commitsSinceRelease: number;
  };
  projects: Project[];
};
