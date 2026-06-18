import { slugOwner, validOwnerSlug, validRepoSlug } from "../scripts/lib/dashboard.js";
import type { ApiQuota, Project } from "../src/types.js";
import { workerFetch } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import {
  gitHubCompareSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
  tryJsonParse,
} from "./schemas.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import * as v from "valibot";
import {
  escapeHtml,
  ownerActivityPageOwner,
  ownerListFromUrl,
  repoFullNameFromPath,
  repoListFromUrl,
} from "./app-shell.js";
import { releaseProject } from "./audience-data.js";
import { bestInstallationToken } from "./auth-tokens.js";
import {
  dashboardStorageTtlSeconds,
  maxDisplayStaleMs,
  repoDetailCacheTtlMs,
  socialRepoCachePrefix,
  type StoredSocialRepo,
} from "./config.js";
import { repositoryPublicCacheBarrier } from "./owner-metadata-read.js";
import { allowRequestRefresh } from "./owner-metadata-write.js";
import {
  optionalRepoDetail,
  readRepoDetail,
  repoDetailAgeMs,
  repoDetailCacheKey,
} from "./release-summary.js";
import { freshnessForDetail, refreshRepoDetail } from "./repo-detail.js";
import { detailGitHubJson } from "./repo-github.js";

export function socialLabel(url: URL): string {
  if (url.pathname === "/_admin") return "ReleaseBar Admin";
  const activityOwner = ownerActivityPageOwner(url.pathname);
  if (activityOwner) return `@${activityOwner} activity`;
  const repo = repoFullNameFromPath(url.pathname);
  if (repo) return repo;
  const owner = slugOwner(url.pathname.split("/").filter(Boolean)[0] ?? "");
  if (validOwnerSlug(owner)) {
    const extra = ownerListFromUrl(url, owner).length + repoListFromUrl(url).length;
    return extra > 0 ? `@${owner} +${extra}` : `@${owner}`;
  }
  const owners = ownerListFromUrl(url);
  const repos = repoListFromUrl(url);
  if (owners[0]) {
    const extra = owners.length - 1 + repos.length;
    return extra > 0 ? `@${owners[0]} +${extra}` : `@${owners[0]}`;
  }
  if (repos.length === 1) {
    return repos[0] ?? "custom deck";
  }
  return repos.length > 1 ? `custom deck +${repos.length}` : "ReleaseBar Hot";
}

export function socialPreviewTitle(label: string): string {
  return `ReleaseBar release freshness dashboard for ${label}`;
}

export type SocialCard = {
  title: string;
  avatarUrl: string | null;
  detail: string;
  metric: string;
};

export const socialNumberFormat = new Intl.NumberFormat("en", { notation: "compact" });
export const socialAvatarMaxBytes = 256 * 1024;
export const socialAvatarTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const socialRendererWasmAsset = "/resvg.wasm";
export const socialRendererFontAssets = [
  "/jetbrains-mono-latin-400-normal.woff2",
  "/jetbrains-mono-latin-700-normal.woff2",
] as const;
export let socialRendererReady: Promise<Uint8Array[]> | null = null;

export function ownerAvatarUrl(owner: string, size = 240): string {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=${size}`;
}

export function socialOwnerFromLabel(label: string): string | null {
  const repo = validRepoSlug(label) ? label.split("/")[0] : null;
  if (repo) return repo;
  const owner = label.match(/^@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)/i)?.[1];
  return owner ? slugOwner(owner) : null;
}

export function socialRepoMetric(project: Project | null): string {
  if (!project) return "release freshness dashboard";
  const commits =
    project.commitsSinceRelease === null
      ? "commits n/a"
      : `${socialNumberFormat.format(project.commitsSinceRelease)} commits since release`;
  return `${project.version} · ${commits}`;
}

export function socialLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function socialAvatarInitials(title: string): string {
  const normalized = title.replace(/^@/, "").replaceAll("/", " ").trim();
  const initials = normalized
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || "RB";
}

export async function socialAvatarDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await workerFetch(url, {
      headers: { "user-agent": "ReleaseBar" },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || !socialAvatarTypes.has(contentType)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > socialAvatarMaxBytes) return null;
    return `data:${contentType};base64,${base64(bytes)}`;
  } catch {
    return null;
  }
}

export function socialRepoCacheKey(owner: string, repo: string): string {
  return `${socialRepoCachePrefix}${slugOwner(owner)}/${repo.toLowerCase()}`;
}

export function socialRepoAgeMs(entry: StoredSocialRepo | null): number {
  if (!entry) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(entry.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export async function readSocialRepo(
  env: Env,
  owner: string,
  repo: string,
): Promise<StoredSocialRepo | null> {
  const raw = await env.DASHBOARD_CACHE?.get(socialRepoCacheKey(owner, repo));
  const parsed = raw ? tryJsonParse<StoredSocialRepo>(raw, `social repo ${owner}/${repo}`) : null;
  return parsed?.project?.fullName?.toLowerCase() === `${slugOwner(owner)}/${repo.toLowerCase()}`
    ? parsed
    : null;
}

export async function writeSocialRepo(env: Env, project: Project): Promise<void> {
  await env.DASHBOARD_CACHE?.put(
    socialRepoCacheKey(project.owner, project.name),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      project,
    } satisfies StoredSocialRepo),
    { expirationTtl: dashboardStorageTtlSeconds },
  );
}

export async function refreshSocialRepo(
  owner: string,
  repo: string,
  request: Request,
  env: Env,
): Promise<void> {
  const project = await buildSocialRepoProject(owner, repo, request, env);
  if (project) {
    await writeSocialRepo(env, project);
  }
}

export async function buildSocialRepoProject(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
): Promise<Project | null> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = (_quota: ApiQuota) => undefined;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository social card",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "social-card",
    undefined,
    env,
  );
  if (repo.private) return null;
  const releases = await detailGitHubJson(
    `${path}/releases?per_page=5`,
    v.array(gitHubReleaseSchema),
    "repository social card releases",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "social-card",
    undefined,
    env,
  );
  const latestRelease = releases.find((release) => !release.draft) ?? null;
  const compare = latestRelease
    ? await optionalRepoDetail(
        detailGitHubJson(
          `${path}/compare/${encodeURIComponent(latestRelease.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
          gitHubCompareSchema,
          "repository social card compare",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          "social-card",
          undefined,
          env,
        ),
        null,
      )
    : null;
  const project = releaseProject(repo);
  project.version = latestRelease?.tag_name ?? "unreleased";
  project.releaseName = latestRelease?.name ?? null;
  project.releaseUrl = latestRelease?.html_url ?? repo.html_url;
  project.releaseDate = latestRelease?.published_at ?? null;
  project.commitsSinceRelease = compare?.total_commits ?? null;
  project.compareUrl = compare?.html_url ?? null;
  project.freshness = freshnessForDetail(project.commitsSinceRelease);
  return project;
}

export async function socialRepoProject(
  label: string,
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Project | null> {
  if (!validRepoSlug(label)) return null;
  const [owner, repo] = label.split("/");
  if (!owner || !repo) return null;
  const barrier = await repositoryPublicCacheBarrier(env, label);
  if (barrier === "blocked") return null;
  const key = repoDetailCacheKey(owner, repo);
  const cached = barrier === "clear" ? await readRepoDetail(env, key) : null;
  const allowRefresh = allowRequestRefresh(request);
  const ageMs = repoDetailAgeMs(cached);
  if (cached && ageMs > repoDetailCacheTtlMs && allowRefresh) {
    context.waitUntil(refreshRepoDetail(key, owner, repo, request, env).catch(() => undefined));
  }
  if (cached && ageMs <= maxDisplayStaleMs) return cached.project;
  const social = barrier === "clear" ? await readSocialRepo(env, owner, repo) : null;
  const socialAgeMs = socialRepoAgeMs(social);
  if (social && socialAgeMs > repoDetailCacheTtlMs && allowRefresh) {
    context.waitUntil(refreshSocialRepo(owner, repo, request, env).catch(() => undefined));
  }
  if (social && socialAgeMs <= maxDisplayStaleMs) return social.project;
  try {
    const project = await buildSocialRepoProject(owner, repo, request, env);
    if (project) {
      await writeSocialRepo(env, project);
    }
    return project;
  } catch {
    return null;
  }
}

export async function socialCardForLabel(
  label: string,
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<SocialCard> {
  const project = await socialRepoProject(label, request, env, context);
  const owner = project?.owner ?? socialOwnerFromLabel(label);
  return {
    title: label,
    avatarUrl: owner ? ownerAvatarUrl(owner) : null,
    detail: project?.description ?? "Open source release freshness",
    metric: socialRepoMetric(project),
  };
}

export async function socialSvg(card: SocialCard): Promise<string> {
  const title = escapeHtml(socialLine(card.title, 42));
  const detail = escapeHtml(socialLine(card.detail, 68));
  const metric = escapeHtml(socialLine(card.metric, 58));
  const avatar = await socialAvatarDataUrl(card.avatarUrl);
  const initials = escapeHtml(socialAvatarInitials(card.title));
  const titleSize =
    card.title.length > 34 ? 54 : card.title.length > 24 ? 66 : card.title.length > 17 ? 82 : 104;
  const titleX = card.avatarUrl ? 276 : 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	  <defs>
	    <clipPath id="avatarClip"><rect x="96" y="198" width="148" height="148" rx="28"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#080908"/>
  <path d="M0 124H1200M0 248H1200M0 372H1200M0 496H1200M160 0V630M400 0V630M640 0V630M880 0V630M1120 0V630" stroke="#182014" stroke-width="1"/>
	  <rect x="72" y="70" width="1056" height="490" rx="0" fill="none" stroke="#8cff4b" stroke-width="2"/>
	  <text x="96" y="148" fill="#a8ff6b" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="38" letter-spacing="0">ReleaseBar</text>
	  ${
      card.avatarUrl
        ? `<rect x="96" y="198" width="148" height="148" rx="28" fill="#121b0f" stroke="#8cff4b" stroke-width="2"/>
	  ${
      avatar
        ? `<image x="96" y="198" width="148" height="148" href="${avatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
        : `<text x="170" y="289" text-anchor="middle" fill="#a8ff6b" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="54" font-weight="700" letter-spacing="0">${initials}</text>`
    }`
        : ""
    }
  <text x="${titleX}" y="318" fill="#f2ffe9" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="${titleSize}" font-weight="700" letter-spacing="0">${title}</text>
  <text x="96" y="424" fill="#a8ff6b" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="34" font-weight="700" letter-spacing="0">${metric}</text>
  <text x="96" y="474" fill="#8f9b89" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="28" letter-spacing="0">${detail}</text>
  <text x="96" y="506" fill="#52604d" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="24" letter-spacing="0">release.bar</text>
</svg>`;
}

export async function socialImage(card: SocialCard): Promise<Response> {
  const svg = await socialSvg(card);
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export async function socialRendererBytes(request: Request, env: Env): Promise<Uint8Array[]> {
  if (!env.ASSETS) throw new Error("missing assets binding");
  if (socialRendererReady) return socialRendererReady;
  socialRendererReady = (async () => {
    const fetchAsset = async (pathname: string) => {
      const url = new URL(request.url);
      url.pathname = pathname;
      url.search = "";
      const response = await env.ASSETS!.fetch(new Request(url, request));
      if (!response.ok) throw new Error(`missing social renderer asset ${pathname}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);
    const wasm = isNode
      ? await fetchAsset(socialRendererWasmAsset)
      : (await import("@resvg/resvg-wasm/index_bg.wasm")).default;
    const fontBuffers = await Promise.all(socialRendererFontAssets.map(fetchAsset));
    await initWasm(wasm);
    return fontBuffers;
  })().catch((error) => {
    socialRendererReady = null;
    throw error;
  });
  return socialRendererReady;
}

export async function socialPng(card: SocialCard, request: Request, env: Env): Promise<Response> {
  const fontBuffers = await socialRendererBytes(request, env);
  const svg = await socialSvg(card);
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      defaultFontFamily: "JetBrains Mono",
      monospaceFamily: "JetBrains Mono",
      fontBuffers,
    },
  });
  const image = resvg.render();
  const png = image.asPng();
  image.free();
  resvg.free();
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
    },
  });
}

export function socialRouteLabel(pathname: string): { label: string; extension: string } {
  const raw = decodeURIComponent(pathname.replace(/^\/og\//, ""));
  const match = raw.match(/\.(svg|png)$/i);
  const label = match ? raw.slice(0, -match[0].length) : raw;
  return { label, extension: match?.[1]?.toLowerCase() ?? "svg" };
}
