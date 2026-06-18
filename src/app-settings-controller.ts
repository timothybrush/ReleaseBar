import { numberFormat } from "./app-format.js";
import { ownerDashboardPath, validRepoSlug } from "./routing.js";
import type { DashboardRoute } from "./routing.js";
import type { AuthPayload, DashboardPayload } from "./types.js";

export type SettingsState = {
  auth: AuthPayload | null;
  hiddenOwners: Set<string>;
  hiddenRepos: Set<string>;
  publicProfile: DashboardPayload["profile"] | null;
  canEditPublicDefault: boolean;
  profileSaving: boolean;
  profileMessage: string;
};

type SettingsContext = {
  initialRoute: DashboardRoute;
  adminRoute: boolean;
  hiddenOwnersKey: string;
  hiddenReposKey: string;
  getState: () => SettingsState;
  update: (patch: Partial<SettingsState>) => void;
};

export function createSettingsController(context: SettingsContext) {
  const currentReturnTo = (): string => `${location.pathname}${location.search}${location.hash}`;

  function persistVisibility(owners: Set<string>, repos: Set<string>): void {
    localStorage.setItem(context.hiddenOwnersKey, JSON.stringify([...owners]));
    localStorage.setItem(context.hiddenReposKey, JSON.stringify([...repos]));
  }

  function addSource(value: string): void {
    const normalized = value.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) return;
    const url = new URL(location.href);
    const key = validRepoSlug(normalized) ? "repos" : "owners";
    if (key === "owners" && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(normalized)) {
      return;
    }
    const values = [
      ...new Set((url.searchParams.get(key) ?? "").split(",").filter(Boolean).concat(normalized)),
    ].sort();
    url.searchParams.set(key, values.join(","));
    localStorage.setItem("releasedeck:custom-sources", url.search);
    location.assign(url.toString());
  }

  function mergedProfileSources(): { includeOwners: string[]; includeRepos: string[] } {
    const state = context.getState();
    const includeOwners = [
      ...(state.publicProfile?.includeOwners ?? []),
      ...context.initialRoute.extraOwners,
    ].filter((owner) => !state.hiddenOwners.has(owner.toLowerCase()));
    return {
      includeOwners: [...new Set(includeOwners)].sort(),
      includeRepos: [
        ...new Set([...(state.publicProfile?.includeRepos ?? []), ...context.initialRoute.repos]),
      ]
        .filter((repo) => !state.hiddenRepos.has(repo.toLowerCase()))
        .sort(),
    };
  }

  async function savePublicDefault(): Promise<void> {
    const state = context.getState();
    if (!context.initialRoute.owner || !state.canEditPublicDefault) return;
    context.update({ profileSaving: true, profileMessage: "" });
    const { includeOwners, includeRepos } = mergedProfileSources();
    try {
      const response = await fetch(
        `/api/profile/${encodeURIComponent(context.initialRoute.owner)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            includeOwners,
            includeRepos,
            hiddenOwners: [
              ...new Set([...(state.publicProfile?.hiddenOwners ?? []), ...state.hiddenOwners]),
            ].sort(),
            hiddenRepos: [
              ...new Set([...(state.publicProfile?.hiddenRepos ?? []), ...state.hiddenRepos]),
            ].sort(),
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `save failed: ${response.status}`);
      }
      location.assign(`/${encodeURIComponent(context.initialRoute.owner)}?rdRefresh=${Date.now()}`);
    } catch (error) {
      context.update({ profileMessage: error instanceof Error ? error.message : String(error) });
    } finally {
      context.update({ profileSaving: false });
    }
  }

  async function resetPublicDefault(): Promise<void> {
    const state = context.getState();
    if (!context.initialRoute.owner || !state.canEditPublicDefault) return;
    context.update({ profileSaving: true, profileMessage: "" });
    try {
      const response = await fetch(
        `/api/profile/${encodeURIComponent(context.initialRoute.owner)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `reset failed: ${response.status}`);
      }
      location.assign(`/${encodeURIComponent(context.initialRoute.owner)}?rdRefresh=${Date.now()}`);
    } catch (error) {
      context.update({ profileMessage: error instanceof Error ? error.message : String(error) });
    } finally {
      context.update({ profileSaving: false });
    }
  }

  function openOwner(owner: string): void {
    location.assign(ownerDashboardPath(owner));
  }

  function openSignedInUserDashboard(): void {
    const user = context.getState().auth?.user;
    if (user) openOwner(user.login);
  }

  function toggleSet(set: Set<string>, key: string, visible: boolean): Set<string> {
    const next = new Set(set);
    if (visible) next.delete(key);
    else next.add(key);
    return next;
  }

  function toggleOwner(owner: string, visible: boolean): void {
    const state = context.getState();
    const hiddenOwners = toggleSet(state.hiddenOwners, owner, visible);
    persistVisibility(hiddenOwners, state.hiddenRepos);
    context.update({ hiddenOwners });
  }

  function toggleRepo(repo: string, visible: boolean): void {
    const state = context.getState();
    const hiddenRepos = toggleSet(state.hiddenRepos, repo.toLowerCase(), visible);
    persistVisibility(state.hiddenOwners, hiddenRepos);
    context.update({ hiddenRepos });
  }

  function resetHidden(): void {
    const hiddenOwners = new Set<string>();
    const hiddenRepos = new Set<string>();
    persistVisibility(hiddenOwners, hiddenRepos);
    context.update({ hiddenOwners, hiddenRepos });
  }

  function authUrl(kind: "login" | "install" | "logout"): URL {
    const auth = context.getState().auth;
    const configured =
      kind === "login" ? auth?.loginUrl : kind === "install" ? auth?.installUrl : auth?.logoutUrl;
    const url = new URL(configured ?? `/api/auth/${kind}`, location.origin);
    url.searchParams.set("returnTo", currentReturnTo());
    return url;
  }

  const login = (): void => location.assign(authUrl("login").toString());
  const installApp = (): void => location.assign(authUrl("install").toString());
  const logout = (): void => location.assign(authUrl("logout").toString());

  function primaryAuthAction(): void {
    const auth = context.getState().auth;
    if (!auth?.configured && !auth?.quotaConfigured) return;
    if (context.adminRoute || !auth?.quotaConfigured) login();
    else installApp();
  }

  function primaryAuthLabel(auth: AuthPayload | null, short = false): string {
    if (!auth?.configured && !auth?.quotaConfigured) return short ? "Login" : "Login Unavailable";
    if (context.adminRoute || !auth.quotaConfigured) return short ? "Connect" : "Connect GitHub";
    return short ? "Install" : "Install GitHub App";
  }

  function primaryAuthTitle(auth: AuthPayload | null): string {
    if (!auth?.configured && !auth?.quotaConfigured) return "GitHub connection unavailable";
    if (context.adminRoute || !auth.quotaConfigured) return "Connect GitHub";
    return "Install GitHub App";
  }

  function authStatus(auth: AuthPayload | null): string {
    if (!auth?.configured) return "GitHub connection is not configured.";
    if (auth.user) {
      return (
        auth.installReason ??
        (auth.quotaConfigured
          ? `${auth.installations.length === 0 ? "Signed in." : `Connected to ${numberFormat.format(auth.installations.length)} GitHub App installation${auth.installations.length === 1 ? "" : "s"}.`}`
          : "Signed in. Dedicated app quota is not configured on this deployment.")
      );
    }
    return auth.quotaConfigured
      ? "Install the GitHub App for dedicated API quota. ReleaseBar only reads public metadata."
      : "Connect GitHub to manage dashboard access.";
  }

  return {
    currentReturnTo,
    addSource,
    savePublicDefault,
    resetPublicDefault,
    openOwner,
    openSignedInUserDashboard,
    toggleOwner,
    toggleRepo,
    resetHidden,
    login,
    installApp,
    primaryAuthAction,
    primaryAuthLabel,
    primaryAuthTitle,
    logout,
    authStatus,
  };
}
