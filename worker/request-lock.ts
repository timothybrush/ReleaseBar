import { slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type { DashboardProfile, Owner, RefreshTarget } from "../src/types.js";
import { randomNonce } from "./crypto.js";
import { jsonResponse } from "./http.js";
import type { DurableObjectState, Env, GitHubWebhookJob, StoredWebhookPending } from "./runtime.js";
import { tryJsonParse } from "./schemas.js";
import { dashboardSubtitle } from "./app-shell.js";
import { isStoredBuildProgress, storedBuildProgressExpired } from "./build-progress.js";
import {
  buildLockTtlMs,
  type DashboardRequest,
  dashboardStorageTtlSeconds,
  durableRefreshTargetEntryLimitBytes,
  durableRefreshTargetIndexLimit,
  durableRefreshTargetIndexLimitBytes,
  githubWebhookCoalescingWaitMs,
  githubWebhookDeliveryLimit,
  githubWebhookDeliveryTtlMs,
  githubWebhookProcessingLeaseMs,
  type OwnerMetadataSnapshot,
  ownerMetadataTtlSeconds,
  refreshJobReservationTtlMs,
  refreshTargetSourceLimit,
  type RequestToken,
  type StoredBuildLock,
  type StoredBuildProgress,
  type StoredRefreshDirty,
  type StoredRefreshJobReservation,
  type StoredWebhookDelivery,
  type StoredWebhookProcessing,
  webhookTargetPageSize,
} from "./config.js";
import { hydrationOptionsFromUrl, normalizeOwnerMetadataSnapshot } from "./dashboard-cache.js";
import { sleep } from "./dashboard-rebuild.js";
import {
  readOwnerMetadataKv,
  reconcileOwnerMetadataSnapshots,
  writeOwnerMetadata,
} from "./owner-metadata-read.js";
import {
  applyOwnerMetadataMutation,
  isOwnerMetadataMutation,
  safeIso,
} from "./owner-metadata-write.js";
import {
  applyRefreshTargetMutation,
  isRefreshTarget,
  isRefreshTargetMutation,
  refreshTargetStorageKey,
} from "./refresh-targets.js";
import { processGitHubWebhook } from "./webhook.js";
import {
  compareWebhookTargets,
  mergePendingWebhook,
  pendingWebhookBatch,
  pendingWebhookFits,
} from "./webhook-targets.js";

export function dashboardRequest(
  owners: Owner[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return {
    owners,
    includeRepos,
    profile,
    subtitle: dashboardSubtitle(owners, includeRepos),
    key,
    url,
    includeReleaseData,
    ...hydrationOptionsFromUrl(url),
    ...(token
      ? {
          token: token.token,
          quotaSource: token.quotaSource,
          quotaAccount: token.quotaAccount,
        }
      : {}),
  };
}

export class DashboardBuildLock {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/acquire") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) {
        return new Response(null, { status: 400 });
      }
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (existing && existing.expiresAt > Date.now()) {
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("lock", {
        token: body.token,
        expiresAt: Date.now() + buildLockTtlMs,
      } satisfies StoredBuildLock);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/release") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (existing?.token === body?.token) {
        await this.state.storage.delete("lock");
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/refresh") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (!existing || existing.token !== body?.token) {
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("lock", {
        token: existing.token,
        expiresAt: Date.now() + buildLockTtlMs,
      } satisfies StoredBuildLock);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/target-index/upsert") {
      const target = await request.json().catch(() => null);
      if (!isRefreshTarget(target)) {
        return new Response(null, { status: 400 });
      }
      if (
        new TextEncoder().encode(JSON.stringify(target)).byteLength >
        durableRefreshTargetEntryLimitBytes
      ) {
        return jsonResponse({ error: "refresh target too large" }, 413, {
          "cache-control": "no-store",
        });
      }
      const upsert = async () => {
        const cutoff = Date.now() - dashboardStorageTtlSeconds * 1000;
        const stored =
          (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
        const targets = new Map(
          stored
            .filter(
              (candidate) => isRefreshTarget(candidate) && safeIso(candidate.lastSeenAt) >= cutoff,
            )
            .map((candidate) => [candidate.key, candidate]),
        );
        const created = !targets.has(target.key);
        if (created && targets.size >= refreshTargetSourceLimit) {
          return jsonResponse({ error: "refresh target source limit reached" }, 429, {
            "cache-control": "no-store",
          });
        }
        targets.set(target.key, target);
        const updated = [...targets.values()]
          .sort((left, right) => safeIso(right.lastSeenAt) - safeIso(left.lastSeenAt))
          .slice(0, durableRefreshTargetIndexLimit);
        if (
          new TextEncoder().encode(JSON.stringify(updated)).byteLength >
          durableRefreshTargetIndexLimitBytes
        ) {
          return jsonResponse({ error: "refresh target source byte limit reached" }, 429, {
            "cache-control": "no-store",
          });
        }
        await this.state.storage.put("refresh-target-index", updated);
        return new Response(null, {
          status: 204,
          headers: { "x-refresh-target-created": String(created) },
        });
      };
      return this.state.blockConcurrencyWhile ? this.state.blockConcurrencyWhile(upsert) : upsert();
    }

    if (url.pathname === "/target-index/delete") {
      const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
      if (typeof body?.key !== "string") {
        return new Response(null, { status: 400 });
      }
      const remove = async () => {
        const stored =
          (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
        const updated = stored.filter(
          (target) => isRefreshTarget(target) && target.key !== body.key,
        );
        if (updated.length === 0) {
          await this.state.storage.delete("refresh-target-index");
        } else if (updated.length !== stored.length) {
          await this.state.storage.put("refresh-target-index", updated);
        }
        return new Response(null, { status: 204 });
      };
      return this.state.blockConcurrencyWhile ? this.state.blockConcurrencyWhile(remove) : remove();
    }

    if (url.pathname === "/target-index/list") {
      const cutoff = Date.now() - dashboardStorageTtlSeconds * 1000;
      const stored = (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
      const targets = stored
        .filter((target) => isRefreshTarget(target) && safeIso(target.lastSeenAt) >= cutoff)
        .sort(compareWebhookTargets);
      return Response.json(targets.slice(0, durableRefreshTargetIndexLimit));
    }

    if (url.pathname === "/target-index/page") {
      const body = (await request.json().catch(() => null)) as {
        cursor?: unknown;
        limit?: unknown;
      } | null;
      const cursor = typeof body?.cursor === "string" ? body.cursor : "";
      const limit =
        typeof body?.limit === "number"
          ? Math.max(1, Math.min(webhookTargetPageSize, Math.floor(body.limit)))
          : webhookTargetPageSize;
      const cutoff = Date.now() - dashboardStorageTtlSeconds * 1000;
      const stored = (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
      const targets = stored
        .filter(
          (target) =>
            isRefreshTarget(target) &&
            safeIso(target.lastSeenAt) >= cutoff &&
            (!cursor || target.key > cursor),
        )
        .sort((left, right) => left.key.localeCompare(right.key));
      const page = targets.slice(0, limit);
      return Response.json({
        targets: page,
        nextCursor: page.length < targets.length ? (page.at(-1)?.key ?? null) : null,
      });
    }

    if (url.pathname === "/owner-metadata/read") {
      const body = (await request.json().catch(() => null)) as { owner?: unknown } | null;
      const owner = typeof body?.owner === "string" ? slugOwner(body.owner) : "";
      if (!validOwnerSlug(owner)) {
        return new Response(null, { status: 400 });
      }
      const read = async () => {
        let stored = normalizeOwnerMetadataSnapshot(
          owner,
          await this.state.storage.get<OwnerMetadataSnapshot>("owner-metadata"),
        );
        if (stored && Date.now() - safeIso(stored.generatedAt) > ownerMetadataTtlSeconds * 1000) {
          await this.state.storage.delete("owner-metadata");
          stored = null;
        }
        const cached = await readOwnerMetadataKv(this.env, owner);
        const snapshot = reconcileOwnerMetadataSnapshots(owner, stored, cached, true);
        if (snapshot) {
          await this.state.storage.put("owner-metadata", snapshot);
        }
        return snapshot;
      };
      const snapshot = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(read)
        : await read();
      return snapshot ? Response.json(snapshot) : new Response(null, { status: 204 });
    }

    if (url.pathname === "/target/mutate") {
      const body = (await request.json().catch(() => null)) as {
        snapshot?: unknown;
        mutation?: unknown;
      } | null;
      const snapshot = isRefreshTarget(body?.snapshot) ? body.snapshot : null;
      const mutation = isRefreshTargetMutation(body?.mutation) ? body.mutation : null;
      const key = mutation?.kind === "observe" ? mutation.input.key : snapshot?.key;
      if (!mutation || !key) {
        return new Response(null, { status: 400 });
      }
      const mutate = async () => {
        let current = await this.state.storage.get<RefreshTarget>("refresh-target");
        if (!current && this.env.DASHBOARD_CACHE) {
          const raw = await this.env.DASHBOARD_CACHE.get(refreshTargetStorageKey(key));
          if (raw) {
            const parsed = tryJsonParse<RefreshTarget>(raw, `refresh target ${key}`);
            current = isRefreshTarget(parsed) ? parsed : undefined;
          }
        }
        const updated = applyRefreshTargetMutation(snapshot, current ?? null, mutation);
        await Promise.all([
          this.state.storage.put("refresh-target", updated),
          this.env.DASHBOARD_CACHE?.put(refreshTargetStorageKey(key), JSON.stringify(updated), {
            expirationTtl: dashboardStorageTtlSeconds,
          }),
        ]);
        return updated;
      };
      const updated = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(mutate)
        : await mutate();
      return Response.json(updated);
    }

    if (url.pathname === "/progress/get") {
      const progress = await this.state.storage.get<StoredBuildProgress>("build-progress");
      if (progress && (!isStoredBuildProgress(progress) || storedBuildProgressExpired(progress))) {
        await this.state.storage.delete("build-progress");
        return new Response(null, {
          status: 204,
          headers: { "x-releasebar-progress": "durable" },
        });
      }
      return progress
        ? Response.json(progress, {
            headers: { "x-releasebar-progress": "durable" },
          })
        : new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
    }

    if (url.pathname === "/progress/put") {
      const progress = await request.json().catch(() => null);
      if (!isStoredBuildProgress(progress)) {
        return new Response(null, {
          status: 400,
          headers: { "x-releasebar-progress": "durable" },
        });
      }
      await this.state.storage.put("build-progress", progress);
      return new Response(null, {
        status: 204,
        headers: { "x-releasebar-progress": "durable" },
      });
    }

    if (url.pathname === "/progress/delete") {
      await this.state.storage.delete("build-progress");
      return new Response(null, {
        status: 204,
        headers: { "x-releasebar-progress": "durable" },
      });
    }

    if (url.pathname === "/job/reserve") {
      const body = (await request.json().catch(() => null)) as {
        jobId?: string;
        dirtyOnConflict?: StoredRefreshDirty;
      } | null;
      if (!body?.jobId) {
        return new Response(null, { status: 400 });
      }
      const existing = await this.state.storage.get<StoredRefreshJobReservation>("refresh-job");
      if (existing && existing.jobId !== body.jobId && existing.expiresAt > Date.now()) {
        const dirty = body.dirtyOnConflict;
        if (dirty && typeof dirty.observedAt === "string" && typeof dirty.reason === "string") {
          const current = await this.state.storage.get<StoredRefreshDirty>("refresh-dirty");
          if (!current || safeIso(dirty.observedAt) >= safeIso(current.observedAt)) {
            await this.state.storage.put("refresh-dirty", dirty);
          }
        }
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("refresh-job", {
        jobId: body.jobId,
        expiresAt: Date.now() + refreshJobReservationTtlMs,
      } satisfies StoredRefreshJobReservation);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/job/release") {
      const body = (await request.json().catch(() => null)) as {
        jobId?: string;
        consumeDirty?: boolean;
      } | null;
      const existing = await this.state.storage.get<StoredRefreshJobReservation>("refresh-job");
      if (existing?.jobId === body?.jobId) {
        const dirty = await this.state.storage.get<StoredRefreshDirty>("refresh-dirty");
        await Promise.all([
          this.state.storage.delete("refresh-job"),
          ...(dirty && body?.consumeDirty ? [this.state.storage.delete("refresh-dirty")] : []),
        ]);
        if (dirty && body?.consumeDirty) {
          return Response.json(dirty);
        }
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/job/status") {
      const existing = await this.state.storage.get<StoredRefreshJobReservation>("refresh-job");
      const active = Boolean(existing && existing.expiresAt > Date.now());
      if (existing && !active) {
        await this.state.storage.delete("refresh-job");
      }
      return Response.json({ active });
    }

    if (url.pathname === "/owner-metadata/mutate") {
      const body = (await request.json().catch(() => null)) as {
        owner?: unknown;
        mutation?: unknown;
      } | null;
      const owner = typeof body?.owner === "string" ? slugOwner(body.owner) : "";
      const mutation = isOwnerMetadataMutation(body?.mutation) ? body.mutation : null;
      if (!validOwnerSlug(owner) || !mutation) {
        return new Response(null, { status: 400 });
      }
      const mutate = async () => {
        let stored = normalizeOwnerMetadataSnapshot(
          owner,
          await this.state.storage.get<OwnerMetadataSnapshot>("owner-metadata"),
        );
        if (stored && Date.now() - safeIso(stored.generatedAt) > ownerMetadataTtlSeconds * 1000) {
          await this.state.storage.delete("owner-metadata");
          stored = null;
        }
        const cached = await readOwnerMetadataKv(this.env, owner);
        const existing = reconcileOwnerMetadataSnapshots(owner, stored, cached, true);
        const updated = applyOwnerMetadataMutation(owner, existing, mutation);
        if (!updated) return null;
        await Promise.all([
          this.state.storage.put("owner-metadata", updated),
          writeOwnerMetadata(this.env, updated),
        ]);
        return updated;
      };
      const updated = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(mutate)
        : await mutate();
      return updated ? Response.json(updated) : new Response(null, { status: 204 });
    }

    if (
      url.pathname === "/webhook/enqueue" ||
      url.pathname === "/webhook/process" ||
      url.pathname === "/webhook/abandon"
    ) {
      const body = (await request.json().catch(() => null)) as {
        id?: unknown;
        event?: unknown;
        delivery?: unknown;
        payload?: unknown;
        createdAt?: unknown;
        attempts?: unknown;
      } | null;
      const jobId = typeof body?.id === "string" ? body.id : "";
      const event = typeof body?.event === "string" ? body.event : "";
      const delivery = typeof body?.delivery === "string" ? body.delivery : "";
      const payload =
        body?.payload && typeof body.payload === "object"
          ? (body.payload as Record<string, unknown>)
          : null;
      if (!delivery || (url.pathname !== "/webhook/abandon" && (!event || !payload))) {
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/webhook/abandon") {
        const abandonDelivery = async () => {
          const now = Date.now();
          const [accepted, processed, active, storedPending] = await Promise.all([
            this.state.storage.get<StoredWebhookDelivery[]>("webhook-accepted"),
            this.state.storage.get<StoredWebhookDelivery[]>("webhook-deliveries"),
            this.state.storage.get<StoredWebhookProcessing>("webhook-active"),
            this.state.storage.get<StoredWebhookPending[]>("webhook-pending"),
          ]);
          const pending = (storedPending ?? []).flatMap((entry) => {
            const deliveries = entry.deliveries.filter((item) => item !== delivery);
            if (deliveries.length === 0) return [];
            return [
              {
                ...entry,
                job:
                  entry.job.delivery === delivery
                    ? { ...entry.job, delivery: deliveries.at(-1)! }
                    : entry.job,
                deliveries,
              },
            ];
          });
          const releaseActive =
            active?.delivery === delivery || Boolean(active && active.expiresAt <= now);
          await Promise.all([
            this.state.storage.put(
              "webhook-accepted",
              (accepted ?? []).filter((item) => item.id !== delivery),
            ),
            this.state.storage.put(
              "webhook-deliveries",
              (processed ?? []).filter((item) => item.id !== delivery),
            ),
            this.state.storage.put("webhook-pending", pending),
            ...(releaseActive ? [this.state.storage.delete("webhook-active")] : []),
          ]);
          if ((!active || releaseActive) && pending.length > 0) {
            if (!this.env.REFRESH_QUEUE) {
              throw new Error("webhook queue unavailable");
            }
            const next = pendingWebhookBatch(pending, "")[0]!;
            await this.env.REFRESH_QUEUE.send({
              ...next.job,
              id: randomNonce(),
              attempts: 0,
            });
          }
          return new Response(null, { status: 204 });
        };
        return this.state.blockConcurrencyWhile
          ? this.state.blockConcurrencyWhile(abandonDelivery)
          : abandonDelivery();
      }
      if (url.pathname === "/webhook/enqueue") {
        if (!this.env.REFRESH_QUEUE) {
          return jsonResponse({ error: "webhook queue unavailable" }, 503, {
            "cache-control": "no-store",
          });
        }
        const enqueueDelivery = async () => {
          const now = Date.now();
          const deliveries = (
            (await this.state.storage.get<StoredWebhookDelivery[]>("webhook-accepted")) ?? []
          ).filter((item) => now - item.processedAt < githubWebhookDeliveryTtlMs);
          if (deliveries.some((item) => item.id === delivery)) {
            return jsonResponse({ ok: true, duplicate: true }, 202, {
              "cache-control": "no-store",
            });
          }
          await this.env.REFRESH_QUEUE!.send({
            kind: "github-webhook",
            id: randomNonce(),
            event,
            delivery,
            payload: payload!,
            createdAt: new Date(now).toISOString(),
            attempts: 0,
          });
          deliveries.push({ id: delivery, processedAt: now });
          await this.state.storage.put(
            "webhook-accepted",
            deliveries.slice(-githubWebhookDeliveryLimit),
          );
          return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
        };
        return this.state.blockConcurrencyWhile
          ? this.state.blockConcurrencyWhile(enqueueDelivery)
          : enqueueDelivery();
      }
      if (!jobId) return new Response(null, { status: 400 });
      const job = {
        kind: "github-webhook",
        id: jobId,
        event,
        delivery,
        payload: payload!,
        createdAt: typeof body?.createdAt === "string" ? body.createdAt : new Date().toISOString(),
        attempts: typeof body?.attempts === "number" ? body.attempts : 0,
      } satisfies GitHubWebhookJob;
      let processingLeaseId: string | null = null;
      const reserveProcessing = async () => {
        const now = Date.now();
        const deliveries = (
          (await this.state.storage.get<StoredWebhookDelivery[]>("webhook-deliveries")) ?? []
        ).filter((item) => now - item.processedAt < githubWebhookDeliveryTtlMs);
        const storedPending =
          (await this.state.storage.get<StoredWebhookPending[]>("webhook-pending")) ?? [];
        const currentPending = storedPending.filter(
          (entry) => now - safeIso(entry.job.createdAt) < githubWebhookDeliveryTtlMs,
        );
        const processed = deliveries.some((item) => item.id === delivery);
        const pending = processed ? currentPending : mergePendingWebhook(currentPending, job);
        if (!pendingWebhookFits(pending)) return "capacity" as const;
        const active = await this.state.storage.get<StoredWebhookProcessing>("webhook-active");
        if (processed && pending.length === 0) {
          if (
            active &&
            (active.jobId === jobId || active.delivery === delivery || active.expiresAt <= now)
          ) {
            await this.state.storage.delete("webhook-active");
          }
          return "duplicate" as const;
        }
        if (active && active.expiresAt > now) {
          await this.state.storage.put("webhook-pending", pending);
          if (processed && active.jobId === jobId) {
            processingLeaseId = randomNonce();
            await this.state.storage.put("webhook-active", {
              jobId,
              leaseId: processingLeaseId,
              delivery,
              expiresAt: now + githubWebhookProcessingLeaseMs,
            } satisfies StoredWebhookProcessing);
            return "leader" as const;
          }
          // Keep the active delivery retryable after a crash; followers are now durably covered.
          if (!active.jobId || active.jobId === jobId) return "retry" as const;
          return "coalesced" as const;
        }
        processingLeaseId = randomNonce();
        await Promise.all([
          this.state.storage.put("webhook-pending", pending),
          this.state.storage.put("webhook-active", {
            jobId,
            leaseId: processingLeaseId,
            delivery,
            expiresAt: now + githubWebhookProcessingLeaseMs,
          } satisfies StoredWebhookProcessing),
        ]);
        return "leader" as const;
      };
      const reservation = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(reserveProcessing)
        : await reserveProcessing();
      if (reservation === "duplicate") {
        return jsonResponse({ ok: true, duplicate: true }, 202, {
          "cache-control": "no-store",
        });
      }
      if (reservation === "capacity") {
        return jsonResponse({ error: "webhook coalescer full" }, 429, {
          "cache-control": "no-store",
        });
      }
      if (reservation === "retry") {
        return jsonResponse({ error: "webhook processor busy" }, 409, {
          "cache-control": "no-store",
        });
      }
      if (reservation === "coalesced") {
        return jsonResponse({ ok: true, coalesced: true }, 202, {
          "cache-control": "no-store",
        });
      }
      try {
        await sleep(githubWebhookCoalescingWaitMs);
        const pending =
          (await this.state.storage.get<StoredWebhookPending[]>("webhook-pending")) ?? [];
        const batch = pendingWebhookBatch(pending, delivery);
        for (const entry of batch) {
          const waits: Promise<unknown>[] = [];
          await processGitHubWebhook(
            entry.job.event,
            entry.job.delivery,
            entry.job.payload,
            entry.job.createdAt,
            this.env,
            {
              waitUntil: (promise) => waits.push(promise),
            },
          );
          await Promise.all(waits);
          const completeEntry = async () => {
            const now = Date.now();
            const deliveries = (
              (await this.state.storage.get<StoredWebhookDelivery[]>("webhook-deliveries")) ?? []
            ).filter((item) => now - item.processedAt < githubWebhookDeliveryTtlMs);
            const completed = new Set(entry.deliveries);
            for (const completedDelivery of completed) {
              if (!deliveries.some((item) => item.id === completedDelivery)) {
                deliveries.push({ id: completedDelivery, processedAt: now });
              }
            }
            const current =
              (await this.state.storage.get<StoredWebhookPending[]>("webhook-pending")) ?? [];
            const next = current.flatMap((candidate) => {
              if (candidate.key !== entry.key) return [candidate];
              if (candidate.revision === entry.revision) return [];
              // A newer event arrived while this entry ran; retain only its unprocessed deliveries.
              const remainingDeliveries = candidate.deliveries.filter(
                (item) => !completed.has(item),
              );
              return remainingDeliveries.length > 0
                ? [{ ...candidate, deliveries: remainingDeliveries }]
                : [];
            });
            await Promise.all([
              this.state.storage.put(
                "webhook-deliveries",
                deliveries.slice(-githubWebhookDeliveryLimit),
              ),
              this.state.storage.put("webhook-pending", next),
            ]);
          };
          if (this.state.blockConcurrencyWhile) {
            await this.state.blockConcurrencyWhile(completeEntry);
          } else {
            await completeEntry();
          }
        }
        const completeProcessing = async () => {
          const active = await this.state.storage.get<StoredWebhookProcessing>("webhook-active");
          if (active?.leaseId !== processingLeaseId) return false;
          const pending =
            (await this.state.storage.get<StoredWebhookPending[]>("webhook-pending")) ?? [];
          if (pending.length > 0) {
            if (!this.env.REFRESH_QUEUE) throw new Error("webhook queue unavailable");
            const next = pendingWebhookBatch(pending, "")[0]!;
            await this.env.REFRESH_QUEUE.send({
              ...next.job,
              id: randomNonce(),
              attempts: 0,
            });
          }
          await this.state.storage.delete("webhook-active");
          return pending.length > 0;
        };
        const remaining = this.state.blockConcurrencyWhile
          ? await this.state.blockConcurrencyWhile(completeProcessing)
          : await completeProcessing();
        return jsonResponse({ ok: true, coalesced: batch.length, remaining }, 202, {
          "cache-control": "no-store",
        });
      } catch (error) {
        const releaseProcessing = async () => {
          const active = await this.state.storage.get<StoredWebhookProcessing>("webhook-active");
          if (active?.leaseId === processingLeaseId) {
            await this.state.storage.delete("webhook-active");
          }
        };
        if (this.state.blockConcurrencyWhile) {
          await this.state.blockConcurrencyWhile(releaseProcessing);
        } else {
          await releaseProcessing();
        }
        throw error;
      }
    }

    return new Response(null, { status: 404 });
  }
}

export function webhookHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
