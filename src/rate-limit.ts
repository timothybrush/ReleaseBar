const githubRateLimitPattern =
  /rate limit|secondary rate|api rate limit exceeded|quota (?:is )?(?:exhausted|paused|reserved)|quota recovers/i;

export function isGitHubRateLimit(
  status: number | null,
  ...messages: Array<string | null | undefined>
): boolean {
  return status === 429 || messages.some((message) => githubRateLimitPattern.test(message ?? ""));
}
