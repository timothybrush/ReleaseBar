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
  openIssues: number | null;
  openPullRequests: number | null;
  issuesUrl: string;
  pullRequestsUrl: string;
  archived: boolean;
  fork?: boolean;
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

export type AuthInstallationRecord = AuthInstallation & {
  updatedAt: string;
};

export type AuthFunnelEvent = {
  id: string;
  at: string;
  event: string;
  account: string | null;
  installationId: number | null;
  repositorySelection: "all" | "selected" | null;
  status: string | null;
  detail: string | null;
};

export type AuthFunnelSummary = {
  generatedAt: string;
  installations: AuthInstallationRecord[];
  events: AuthFunnelEvent[];
  counts: Array<{ key: string; count: number }>;
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
    countsUpdatedAt?: string | null;
    projectCountsUpdatedAt?: Record<string, string>;
    releasesUpdatedAt?: string | null;
    ciUpdatedAt?: string | null;
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

export type ActivityRange = "day" | "week" | "month";
export type RepoActivityRange = ActivityRange | "release";

export type OwnerActivityKind =
  | "commit"
  | "pull_request"
  | "issue"
  | "comment"
  | "release"
  | "repository"
  | "other";

export type OwnerActivityEvent = {
  id: string;
  kind: OwnerActivityKind;
  title: string;
  repo: string;
  url: string | null;
  createdAt: string;
  count: number;
};

export type OwnerActivityRepository = {
  fullName: string;
  url: string;
  events: number;
  commits: number;
  lastActiveAt: string;
};

export type OwnerActivitySummary = {
  state: "ready" | "warming" | "unavailable";
  text: string | null;
  generatedAt: string | null;
  model: string | null;
  inputHash: string | null;
  eventsUsed: number;
  promptVersion?: number;
  message?: string;
};

export type OwnerActivityPayload = {
  owner: Owner;
  range: ActivityRange;
  generatedAt: string;
  cache: {
    state: "fresh" | "stale" | "warming" | "error";
    stale: boolean;
    generatedAt: string;
    message?: string;
    quota?: ApiQuota;
  };
  totals: {
    events: number;
    commits: number;
    pullRequests: number;
    issues: number;
    comments: number;
    releases: number;
    repositories: number;
  };
  repositories: OwnerActivityRepository[];
  events: OwnerActivityEvent[];
  summary?: OwnerActivitySummary;
};

export type TrustProfileRepository = {
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  updatedAt: string | null;
  topics: string[];
};

export type TrustProfileSignalCount = {
  name: string;
  count: number;
};

export type TrustProfilePayload = {
  login: string;
  type: "user" | "org";
  profileKind: "user_trust" | "org_signal";
  scoreLabel: "trust score" | "org signal";
  avatarUrl: string;
  url: string;
  name: string | null;
  company: string | null;
  bio: string | null;
  location: string | null;
  blog: string | null;
  twitterUsername: string | null;
  followers: number;
  following: number;
  publicRepos: number;
  publicGists: number;
  accountCreatedAt: string | null;
  accountUpdatedAt: string | null;
  accountAgeDays: number | null;
  score: number;
  tier: AudienceScoreTier;
  reasons: string[];
  dimensions: AudienceScoreDimensions;
  factors: AudienceScoreFactor[];
  orgs: RepoAudienceOrg[];
  topRepositories: TrustProfileRepository[];
  stats: {
    totalStars: number;
    totalForks: number;
    recentRepositories: number;
    activeRepositories: number;
    publicOrganizations: number;
    languages: TrustProfileSignalCount[];
    topics: TrustProfileSignalCount[];
  };
  generatedAt: string;
  cache: {
    state: "fresh" | "stale" | "error";
    stale: boolean;
    generatedAt: string;
    message?: string;
    quota?: ApiQuota;
  };
};

export type RepoDetailActivityPayload = {
  fullName: string;
  range: ActivityRange;
  generatedAt: string;
  cache: {
    state: "fresh" | "stale" | "warming" | "error";
    stale: boolean;
    generatedAt: string;
    message?: string;
    quota?: ApiQuota;
  };
  totals: {
    events: number;
    commits: number;
    pullRequests: number;
    issues: number;
    comments: number;
    releases: number;
    repositories: number;
  };
  repositories: OwnerActivityRepository[];
  events: OwnerActivityEvent[];
  summary?: OwnerActivitySummary;
};

export type RepoDetailContributor = {
  login: string;
  avatarUrl: string | null;
  url: string | null;
  commits: number;
  trustScore?: number;
  trustTier?: AudienceScoreTier;
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

export type RepoDetailWorkTrend = {
  since: string;
  issuesOpened30d: number;
  issuesClosed30d: number;
  pullRequestsOpened30d: number;
  pullRequestsClosed30d: number;
};

export type RepoDetailStatState = {
  state: "ready" | "warming" | "unavailable";
  message?: string;
};

export type RepoDetailReleaseSummary = {
  state: "ready" | "warming" | "unavailable";
  text: string | null;
  generatedAt: string | null;
  model: string | null;
  releaseTag: string | null;
  headSha: string | null;
  commitCount: number | null;
  commitsUsed: number;
  message?: string;
};

export type AudienceRange = "week" | "month";

export type AudienceScoreTier = "high" | "medium" | "low" | "bot";

export type AudienceScoreDimensions = {
  trust: number;
  influence: number;
  builder: number;
  recency: number;
  risk: number;
};

export type AudienceScoreFactor = {
  key: "age" | "profile" | "orgs" | "reach" | "builder" | "recency" | "risk";
  label: string;
  value: number;
  maxValue: number;
  weight: number;
  weightedValue: number;
  detail: string;
  sentiment: "positive" | "neutral" | "negative";
};

export type RepoAudienceOrg = {
  login: string;
  description: string | null;
};

export type RepoAudienceTopRepository = {
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  updatedAt: string | null;
};

export type RepoAudienceUser = {
  login: string;
  avatarUrl: string;
  url: string;
  name: string | null;
  company: string | null;
  bio: string | null;
  location: string | null;
  followers: number;
  publicRepos: number;
  starredAt: string | null;
  score: number;
  tier: AudienceScoreTier;
  trustScore?: number;
  trustTier?: AudienceScoreTier;
  reasons: string[];
  dimensions: AudienceScoreDimensions;
  factors: AudienceScoreFactor[];
  orgs: RepoAudienceOrg[];
  topRepositories: RepoAudienceTopRepository[];
  accountCreatedAt: string | null;
};

export type RepoAudiencePayload = {
  fullName: string;
  range: AudienceRange;
  generatedAt: string;
  cache: {
    state: "fresh" | "stale" | "warming" | "error";
    stale: boolean;
    generatedAt: string;
    message?: string;
    quota?: ApiQuota;
  };
  totals: {
    stargazers: number;
    stargazersSampled: number;
    highSignal: number;
    mediumSignal: number;
    lowSignal: number;
    bots: number;
    highSignalPercent: number;
    mediumSignalPercent: number;
    lowSignalPercent: number;
    botPercent: number;
  };
  users: RepoAudienceUser[];
};

export type RepoAudienceBackfillPayload = {
  fullName: string;
  ranges: Array<{
    range: AudienceRange;
    state: "busy" | "fresh" | "rebuilt";
    users: number;
    generatedAt: string;
  }>;
  quota: {
    source: ApiQuota["source"];
    account: string | null;
  };
  message: string;
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
  stats?: {
    commitActivity: RepoDetailStatState;
    codeFrequency: RepoDetailStatState;
  };
  releaseSummary?: RepoDetailReleaseSummary;
  project: Project;
  releases: RepoDetailRelease[];
  contributors: RepoDetailContributor[];
  commitActivity: RepoDetailWeek[];
  codeFrequency: RepoDetailCodeWeek[];
  languages: RepoDetailLanguage[];
  workTrend: RepoDetailWorkTrend | null;
};

export type RefreshTarget = {
  key: string;
  kind: "dashboard";
  indexVersion?: number;
  owner: string;
  owners: string[];
  repos: string[];
  profileSnapshotKey?: string | null;
  includeReleaseData: boolean;
  path: string;
  priority: number;
  lastSeenAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string;
  failureCount: number;
  terminalBackoffUntil?: string | null;
  message?: string;
};

export type RefreshJob = {
  id: string;
  targetKey: string;
  target?: RefreshTarget;
  targetSnapshotKey?: string;
  kind: "dashboard";
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  reason: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  durationMs: number | null;
  error?: string;
};

export type SchedulerAuditEvent = {
  id: string;
  event: string;
  at: string;
  targetKey?: string;
  jobId?: string;
  status?: string;
  reason?: string;
  account?: string | null;
  detail?: string;
  phase?: string;
  source?: string;
  durationMs?: number;
  scanned?: number | null;
  limit?: number | null;
  projects?: number;
  events?: number;
  done?: boolean;
};

export type SchedulerAdminPayload = {
  generatedAt: string;
  authorized: boolean;
  status: {
    targets: number;
    dueTargets: number;
    queuedJobs: number;
    runningJobs: number;
    failedJobs: number;
    lastTickAt: string | null;
    nextDueAt: string | null;
    queueConfigured: boolean;
  };
  targets: RefreshTarget[];
  jobs: RefreshJob[];
  events: SchedulerAuditEvent[];
  githubAccess: GitHubAccessSummary;
  auth: AuthFunnelSummary;
};

export type GitHubAccessRouteSummary = {
  key: string;
  area: string;
  route: string;
  status: number;
  source: ApiQuota["source"];
  account: string | null;
  resource: string | null;
  count: number;
  lastAt: string | null;
  lastPath: string | null;
};

export type GitHubAccessSummary = {
  generatedAt: string;
  hours: number;
  buckets: number;
  total: number;
  cooldown: {
    active: boolean;
    resource: string | null;
    remaining: number | null;
    limit: number | null;
    resetAt: string | null;
    reason: string | null;
  };
  byArea: Array<{ key: string; count: number }>;
  bySource: Array<{ key: string; count: number }>;
  byStatus: Array<{ key: string; count: number }>;
  topRoutes: GitHubAccessRouteSummary[];
};
