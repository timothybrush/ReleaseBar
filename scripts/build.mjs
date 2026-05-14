import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const configPath = path.join(root, "releasedeck.config.json");
const publicDir = path.join(root, "src");
const checkOnly = process.argv.includes("--check");

const config = JSON.parse(await readFile(configPath, "utf8"));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const headers = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "ReleaseDeck",
  "X-GitHub-Api-Version": "2022-11-28"
};

if (token) headers.Authorization = `Bearer ${token}`;

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function githubPages(pathname) {
  let page = 1;
  const items = [];
  while (true) {
    const joiner = pathname.includes("?") ? "&" : "?";
    const result = await github(`${pathname}${joiner}per_page=100&page=${page}`);
    if (!result || result.length === 0) break;
    items.push(...result);
    if (result.length < 100) break;
    page += 1;
  }
  return items;
}

async function ownerRepos(owner) {
  const base = owner.type === "org" ? `/orgs/${owner.login}/repos` : `/users/${owner.login}/repos`;
  return githubPages(`${base}?type=public&sort=pushed&direction=desc`);
}

function repoAllowed(repo) {
  const fullName = repo.full_name;
  if (!config.includeForks && repo.fork) return false;
  if (!config.includeArchived && repo.archived) return false;
  if ((config.excludeRepos || []).includes(fullName)) return false;
  return !repo.private;
}

async function repoSummary(repo) {
  const [release, latestCommit] = await Promise.all([
    github(`/repos/${repo.full_name}/releases/latest`),
    github(`/repos/${repo.full_name}/commits/${repo.default_branch}`)
  ]);

  let commitsSinceRelease = null;
  let compareUrl = null;
  if (release?.tag_name) {
    const compare = await github(
      `/repos/${repo.full_name}/compare/${encodeURIComponent(release.tag_name)}...${encodeURIComponent(repo.default_branch)}`
    );
    commitsSinceRelease = compare?.total_commits ?? null;
    compareUrl = compare?.html_url ?? null;
  }

  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    archived: repo.archived,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: latestCommit?.sha?.slice(0, 7) ?? null,
    latestCommitDate: latestCommit?.commit?.committer?.date ?? null,
    version: release?.tag_name ?? null,
    releaseName: release?.name ?? null,
    releaseUrl: release?.html_url ?? null,
    releaseDate: release?.published_at ?? null,
    commitsSinceRelease,
    compareUrl
  };
}

function freshness(project) {
  if (!project.version) return "unreleased";
  if (project.commitsSinceRelease === 0) return "fresh";
  if (project.commitsSinceRelease <= 5) return "warm";
  if (project.commitsSinceRelease <= 25) return "busy";
  return "hot";
}

async function main() {
  const repos = [];
  for (const owner of config.owners) {
    repos.push(...await ownerRepos(owner));
  }

  const uniqueRepos = [...new Map(repos.filter(repoAllowed).map((repo) => [repo.full_name, repo])).values()];
  const projects = [];

  for (const [index, repo] of uniqueRepos.entries()) {
    process.stdout.write(`fetch ${index + 1}/${uniqueRepos.length} ${repo.full_name}\n`);
    const project = await repoSummary(repo);
    projects.push({ ...project, freshness: freshness(project) });
  }

  projects.sort((a, b) => {
    const aDate = Date.parse(a.pushedAt || 0);
    const bDate = Date.parse(b.pushedAt || 0);
    return bDate - aDate;
  });

  const generatedAt = new Date().toISOString();
  const payload = {
    title: config.title,
    subtitle: config.subtitle,
    canonicalDomain: config.canonicalDomain,
    generatedAt,
    owners: config.owners,
    totals: {
      repos: projects.length,
      released: projects.filter((project) => project.version).length,
      unreleased: projects.filter((project) => !project.version).length,
      commitsSinceRelease: projects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0)
    },
    projects
  };

  if (checkOnly) {
    console.log(JSON.stringify(payload.totals, null, 2));
    return;
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, "data"), { recursive: true });

  for (const file of ["index.html", "styles.css", "app.js"]) {
    const source = await readFile(path.join(publicDir, file), "utf8");
    await writeFile(path.join(distDir, file), source);
  }

  await writeFile(path.join(distDir, "CNAME"), `${config.canonicalDomain}\n`);
  await writeFile(path.join(distDir, "data", "projects.json"), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`built ${projects.length} projects at ${generatedAt}`);
}

await main();
