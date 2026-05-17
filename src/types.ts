export type Owner = {
  type: "user" | "org";
  login: string;
  avatarUrl?: string;
  url?: string;
};

export type ReleaseBarConfig = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  owners: Owner[];
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased?: boolean;
  excludeRepos?: string[];
};

export type Freshness = "fresh" | "warm" | "busy" | "hot";

export type CiState =
  | "success"
  | "failure"
  | "running"
  | "pending"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "unknown";

export type Project = {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  defaultBranch: string;
  language: string | null;
  topics: string[];
  stars: number;
  forks: number;
  openIssues: number;
  openPullRequests: number;
  issuesUrl: string;
  pullRequestsUrl: string;
  archived: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  latestCommitSha: string | null;
  latestCommitDate: string | null;
  version: string;
  releaseName: string | null;
  releaseUrl: string;
  releaseDate: string | null;
  commitsSinceRelease: number | null;
  compareUrl: string | null;
  ciState: CiState;
  ciStatus: string | null;
  ciConclusion: string | null;
  ciWorkflow: string | null;
  ciUrl: string | null;
  ciRunDate: string | null;
  freshness: Freshness;
};

export type AuthUser = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
};

export type AuthInstallation = {
  id: number;
  accountLogin: string;
  accountType: "user" | "org";
  accountUrl: string;
  avatarUrl: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
};

export type AuthPayload = {
  configured: boolean;
  quotaConfigured: boolean;
  user: AuthUser | null;
  installations: AuthInstallation[];
  installNeeded: boolean;
  installReason: string | null;
  loginUrl: string;
  logoutUrl: string;
  installUrl: string;
  appUrl: string;
};

export type ApiQuota = {
  source: "app" | "shared" | "anonymous";
  account: string | null;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  resource: string | null;
};

export type DashboardProfile = {
  owner: string;
  includeOwners: string[];
  includeRepos: string[];
  hiddenOwners: string[];
  hiddenRepos: string[];
  updatedAt: string;
  updatedBy: string;
};

export type DashboardPayload = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  generatedAt: string;
  owners: Owner[];
  profile?: DashboardProfile;
  options?: {
    includeForks: boolean;
    includeArchived: boolean;
    includeUnreleased: boolean;
    repoLimit: number | null;
  };
  cache?: {
    state: "fresh" | "stale" | "partial" | "rebuilding" | "error";
    stale: boolean;
    capped: boolean;
    repoLimit: number | null;
    generatedAt: string;
    quota?: ApiQuota;
    message?: string;
    progress?: {
      scanned: number;
      limit: number | null;
      done: boolean;
    };
  };
  totals: {
    repos: number;
    released: number;
    unreleased: number;
    commitsSinceRelease: number;
  };
  projects: Project[];
};

export type RepoDetailContributor = {
  login: string;
  avatarUrl: string | null;
  url: string | null;
  commits: number;
};

export type RepoDetailRelease = {
  name: string | null;
  tagName: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
};

export type RepoDetailWeek = {
  week: string;
  total: number;
  days: number[];
};

export type RepoDetailCodeWeek = {
  week: string;
  additions: number;
  deletions: number;
};

export type RepoDetailLanguage = {
  name: string;
  bytes: number;
};

export type RepoDetailPayload = {
  fullName: string;
  generatedAt: string;
  cache: {
    state: "fresh" | "stale" | "warming" | "error";
    stale: boolean;
    generatedAt: string;
    message?: string;
    quota?: ApiQuota;
  };
  project: Project;
  releases: RepoDetailRelease[];
  contributors: RepoDetailContributor[];
  commitActivity: RepoDetailWeek[];
  codeFrequency: RepoDetailCodeWeek[];
  languages: RepoDetailLanguage[];
};
