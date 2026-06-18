import type { AuthFunnelSummary, GitHubAccessSummary, SchedulerAdminPayload } from "./types.js";

export type AdminDashboardPayload = SchedulerAdminPayload & {
  githubAccess: GitHubAccessSummary;
  auth: AuthFunnelSummary;
};
