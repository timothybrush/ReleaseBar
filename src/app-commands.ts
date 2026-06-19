import { ciLabel, countLabel, numberFormat } from "./app-format.js";
import { primaryAuthLabelFor } from "./auth-ui.js";
import {
  devSortOptions,
  filterLabel,
  filterOptions,
  sortLabel,
  sortOptions,
  type DashboardFilter,
  type SortDirection,
  type SortKey,
} from "./dashboard-view.js";
import { repoDetailPath, validRepoSlug, type DiscoverPeriod } from "./routing.js";
import type { AuthPayload, Project } from "./types.js";

type CommandAction = {
  actionId?: number | string | null;
  title: string;
  description?: string;
  subTitle?: string;
  onRun?: (args: unknown) => void;
  keywords?: string[];
  group?: string;
};

type DiscoverOption = { value: DiscoverPeriod; label: string };

export type CommandState = {
  projects: Project[];
  owners: string[];
  languages: string[];
  language: string;
  typedText: string;
  hiddenOwners: Set<string>;
  hiddenRepos: Set<string>;
  auth: AuthPayload | null;
  devMode: boolean;
  sortKey: SortKey;
  sortDirection: SortDirection;
  filter: DashboardFilter;
  settingsSummary: string;
  adminRoute: boolean;
  discoverPeriods: DiscoverOption[];
};

export type CommandActions = {
  openOwner: (owner: string) => void;
  addSource: (source: string) => void;
  discoverHref: (period: DiscoverPeriod) => string;
  setSort: (key: SortKey) => void;
  setFilter: (filter: DashboardFilter) => void;
  setLanguage: (language: string) => void;
  openUrl: (url: string | null) => void;
  toggleRepo: (repo: string, visible: boolean) => void;
  toggleOwner: (owner: string, visible: boolean) => void;
  setDevMode: (enabled: boolean) => void;
  focusSearch: () => void;
  copyDashboardUrl: () => Promise<void>;
  openSettings: () => void;
  resetHidden: () => void;
  primaryAuthAction: () => void;
  installApp: () => void;
  logout: () => void;
};

function repoCommands(
  project: Project,
  state: CommandState,
  actions: CommandActions,
): CommandAction[] {
  const topics = project.topics ?? [];
  const commands: CommandAction[] = [
    {
      actionId: `repo:${project.fullName}`,
      title: project.fullName,
      subTitle: `${project.version} · ${project.freshness} · ${numberFormat.format(project.stars)} stars`,
      description: project.description ?? undefined,
      group: "Repos",
      keywords: [project.owner, project.name, project.language ?? "", project.version, ...topics],
      onRun: () => location.assign(repoDetailPath(project.fullName)),
    },
    {
      actionId: `github:${project.fullName}`,
      title: `Open ${project.fullName} on GitHub`,
      subTitle: "github.com",
      group: "Repos",
      keywords: ["github", "external", project.fullName],
      onRun: () => actions.openUrl(project.url),
    },
    {
      actionId: `release:${project.fullName}`,
      title: `Open release ${project.version}`,
      subTitle: project.fullName,
      group: "Repos",
      keywords: ["tag", "version", project.fullName],
      onRun: () => actions.openUrl(project.releaseUrl),
    },
    {
      actionId: `issues:${project.fullName}`,
      title: "Open issues",
      subTitle: `${project.fullName} · ${countLabel(project.openIssues)}`,
      group: "Repos",
      keywords: ["bugs", "issues", project.fullName],
      onRun: () => actions.openUrl(project.issuesUrl),
    },
    {
      actionId: `prs:${project.fullName}`,
      title: "Open pull requests",
      subTitle: `${project.fullName} · ${countLabel(project.openPullRequests)}`,
      group: "Repos",
      keywords: ["prs", "pulls", "pull requests", project.fullName],
      onRun: () => actions.openUrl(project.pullRequestsUrl),
    },
    {
      actionId: `hide:${project.fullName}`,
      title: `${state.hiddenRepos.has(project.fullName.toLowerCase()) ? "Show" : "Hide"} ${project.fullName}`,
      subTitle: "local visibility",
      group: "Visibility",
      keywords: ["hide", "show", "visible", project.fullName],
      onRun: () =>
        actions.toggleRepo(project.fullName, state.hiddenRepos.has(project.fullName.toLowerCase())),
    },
  ];
  if (project.compareUrl) {
    commands.splice(2, 0, {
      actionId: `compare:${project.fullName}`,
      title: "Open compare",
      subTitle: `${project.fullName} · ${project.commitsSinceRelease ?? "n/a"} commits`,
      group: "Repos",
      keywords: ["compare", "commits", project.fullName],
      onRun: () => actions.openUrl(project.compareUrl),
    });
  }
  if (project.ciUrl) {
    commands.push({
      actionId: `ci:${project.fullName}`,
      title: "Open CI",
      subTitle: `${project.fullName} · ${ciLabel(project)}`,
      group: "Repos",
      keywords: ["ci", "checks", "actions", project.fullName],
      onRun: () => actions.openUrl(project.ciUrl),
    });
  }
  return commands;
}

export function buildCommands(state: CommandState, actions: CommandActions): CommandAction[] {
  const rawTyped = state.typedText.trim();
  const typed = rawTyped.replace(/^@/, "").toLowerCase();
  const typedCommands: CommandAction[] = [];
  if (rawTyped.startsWith("@") && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(typed)) {
    typedCommands.push({
      actionId: `typed-owner:${typed}`,
      title: `Open @${typed}`,
      subTitle: "public dashboard",
      group: "Dashboards",
      keywords: ["owner", "org", typed],
      onRun: () => actions.openOwner(typed),
    });
  }
  if (validRepoSlug(typed)) {
    typedCommands.push({
      actionId: `typed-repo:${typed}`,
      title: `Add ${typed}`,
      subTitle: "explicit public repo source",
      group: "Dashboards",
      keywords: ["repo", "source", typed],
      onRun: () => actions.addSource(typed),
    });
  }

  const sortCommand = (key: SortKey): CommandAction => ({
    actionId: `sort:${key}`,
    title: `Sort by ${sortLabel(key)}`,
    subTitle: state.sortKey === key ? `currently ${state.sortDirection}` : "table order",
    group: "View",
    keywords: ["order", "table", key, sortLabel(key)],
    onRun: () => actions.setSort(key),
  });
  const filterCommand = (filter: DashboardFilter): CommandAction => ({
    actionId: `filter:${filter}`,
    title: `Show ${filterLabel(filter)}`,
    subTitle: state.filter === filter ? "current filter" : "filter dashboard",
    group: "View",
    keywords: ["filter", filter, filterLabel(filter)],
    onRun: () => actions.setFilter(filter),
  });
  const languageCommand = (language: string): CommandAction => ({
    actionId: `language:${language.toLowerCase()}`,
    title: `Show ${language}`,
    subTitle:
      state.language.trim().toLowerCase() === language.toLowerCase()
        ? "current language filter"
        : "language filter",
    group: "Languages",
    keywords: ["language", "tech", "stack", language],
    onRun: () => actions.setLanguage(language),
  });
  const ownerCommands: CommandAction[] = state.owners.map((owner) => ({
    actionId: `owner:${owner}`,
    title: `Open @${owner}`,
    subTitle: state.hiddenOwners.has(owner) ? "hidden locally" : "owner dashboard",
    group: "Dashboards",
    keywords: ["owner", "dashboard", owner],
    onRun: () => actions.openOwner(owner),
  }));
  const authLogin = state.auth?.user?.login ?? null;

  return [
    ...typedCommands,
    {
      actionId: "dashboard:home",
      title: "Open GitHub Hot",
      subTitle: "root dashboard",
      group: "Dashboards",
      keywords: ["home", "root", "hot", "discover", "trending"],
      onRun: () => location.assign("/"),
    },
    ...state.discoverPeriods.map((period) => ({
      actionId: `dashboard:discover:${period.value}`,
      title: `Open ${period.label}`,
      subTitle: period.value === "releasebar" ? "cached ReleaseBar dashboards" : "GitHub Hot",
      group: "Dashboards",
      keywords: ["hot", "discover", "trending", period.value, period.label],
      onRun: () => location.assign(actions.discoverHref(period.value)),
    })),
    ...ownerCommands,
    ...state.languages.map(languageCommand),
    ...state.projects.flatMap((project) => repoCommands(project, state, actions)).slice(0, 420),
    ...filterOptions.map(filterCommand),
    ...sortOptions.map(sortCommand),
    ...(state.devMode ? devSortOptions.map(sortCommand) : []),
    {
      actionId: "view:search",
      title: "Focus search",
      subTitle: "filter visible rows",
      group: "View",
      keywords: ["search", "find", "filter"],
      onRun: actions.focusSearch,
    },
    {
      actionId: "view:copy-url",
      title: "Copy dashboard URL",
      subTitle: "share current filters",
      group: "View",
      keywords: ["copy", "share", "url", "link"],
      onRun: () => void actions.copyDashboardUrl(),
    },
    {
      actionId: "view:dev",
      title: `${state.devMode ? "Disable" : "Enable"} dev columns`,
      subTitle: "issues, PRs, CI",
      group: "View",
      keywords: ["dev", "issues", "prs", "ci"],
      onRun: () => actions.setDevMode(!state.devMode),
    },
    {
      actionId: "view:settings",
      title: "Open settings",
      subTitle: state.settingsSummary,
      group: "View",
      keywords: ["settings", "sources", "visibility"],
      onRun: actions.openSettings,
    },
    {
      actionId: "visibility:reset",
      title: "Show all hidden items",
      subTitle: state.settingsSummary,
      group: "Visibility",
      keywords: ["reset", "hidden", "visibility"],
      onRun: actions.resetHidden,
    },
    ...state.owners.map((owner) => ({
      actionId: `visibility:owner:${owner}`,
      title: `${state.hiddenOwners.has(owner) ? "Show" : "Hide"} @${owner}`,
      subTitle: "local visibility",
      group: "Visibility",
      keywords: ["hide", "show", "owner", owner],
      onRun: () => actions.toggleOwner(owner, state.hiddenOwners.has(owner)),
    })),
    ...((state.auth?.configured || state.auth?.quotaConfigured) && !state.auth.user
      ? [
          {
            actionId: "auth:login",
            title: primaryAuthLabelFor(state.auth, state.adminRoute),
            subTitle: "detect existing App installations",
            group: "Account",
            keywords: ["login", "sign in", "github", "quota"],
            onRun: actions.primaryAuthAction,
          },
        ]
      : []),
    ...(state.auth?.user
      ? [
          ...(authLogin
            ? [
                {
                  actionId: "account:dashboard",
                  title: "Open my dashboard",
                  subTitle: `@${authLogin}`,
                  group: "Account",
                  keywords: ["me", "account", "dashboard", authLogin],
                  onRun: () => actions.openOwner(authLogin),
                },
              ]
            : []),
          ...(state.auth.installNeeded
            ? [
                {
                  actionId: "auth:install",
                  title: "Install GitHub App",
                  subTitle: state.auth.installReason ?? "dedicated API quota",
                  group: "Account",
                  keywords: ["install", "github", "app"],
                  onRun: actions.installApp,
                },
              ]
            : []),
          {
            actionId: "auth:logout",
            title: "Log out",
            subTitle: `@${state.auth.user.login}`,
            group: "Account",
            keywords: ["logout", "sign out", state.auth.user.login],
            onRun: actions.logout,
          },
        ]
      : []),
  ];
}
