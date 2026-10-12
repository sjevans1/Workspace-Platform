// OCP-1 source enrichment: small read-only adapters that replace honestly-unknown
// telemetry fields with real local operational data.
//
// Rules enforced here:
// - read-only and side-effect free; nothing is mutated and no claim semantics change;
// - bounded work only (indexed aggregates, one statfs, one bounded directory listing);
// - every adapter fails independently to "unknown" and cannot fail composition;
// - no payloads, job ids, tenant/user/object ids, error text, filenames, paths,
//   bucket names, database identifiers, connection strings or secrets;
// - no invented thresholds or SLAs.
//
// The accepted openjm.workspace.operator-telemetry.v1 wire shape is unchanged.

import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { verifyBackup } from "../../scripts/backup.ts";

export type HealthState = "healthy" | "degraded" | "unhealthy" | "unknown";

export type QueueSignal = { depth: number | null; state: HealthState };
export type StorageSignal = { usedPercent: number | null };
// The adapter keeps the precise verification vocabulary; the wiring maps it into the
// accepted wire field readiness.backup_state, whose vocabulary is
// healthy | degraded | unhealthy | unknown.
export type BackupVerificationState = "verified" | "failed" | "never_verified" | "unknown";
export type BackupSignal = { lastBackupAt: string | null; state: BackupVerificationState };

export type OperationalSources = {
  queue: QueueSignal;
  storage: StorageSignal;
  backup: BackupSignal;
};

// Bounded discovery: never read more than this many archive candidates.
export const BACKUP_CANDIDATE_LIMIT = 5;

export type QueryLike = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

const asCount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

// Queue depth: two bounded, index-supported aggregates over the existing product job
// tables. No payload, id, error text or tenant value is selected.
export async function collectQueueSignal(q: QueryLike): Promise<QueueSignal> {
  try {
    // Count-only privileged aggregate. Direct tenant-less aggregation is not used
    // because the product job tables are FORCE RLS and would falsely report an empty
    // queue; the function returns three integers and can expose nothing else.
    const result = await q.query("SELECT pending, retry, dead FROM public.workspace_queue_depth()");
    const row: any = result.rows?.[0] ?? {};
    const counts = {
      pending: asCount(row.pending),
      retry: asCount(row.retry),
      dead: asCount(row.dead),
    };
    const depth = counts.pending + counts.retry + counts.dead;
    // Factual semantics in the ACCEPTED wire vocabulary (healthy | degraded |
    // unhealthy | unknown): healthy means no pending, retryable or dead work exists;
    // degraded means queue contents exist, stated as a fact about the contents and
    // NOT an SLA breach or severity judgment; unknown means the aggregate failed.
    const state: HealthState =
      counts.dead > 0 || counts.pending + counts.retry > 0 ? "degraded" : "healthy";
    return { depth, state };
  } catch {
    return { depth: null, state: "unknown" };
  }
}

// One shared mapping into the existing OCP-1A composition inputs, so the API and the
// worker cannot diverge. databaseCapacity is deliberately null: see the docs.
export function toTelemetryInputs(sources: OperationalSources) {
  return {
    queueDepth: sources.queue.depth,
    queueState: sources.queue.state,
    storageCapacity: sources.storage.usedPercent,
    databaseCapacity: null as number | null,
    lastBackupAt: sources.backup.lastBackupAt,
    backupVerified:
      sources.backup.state === "verified" ? true : sources.backup.state === "failed" ? false : null,
  };
}

// Storage capacity: the filesystem backing the actual Workspace storage root, and
// only for the local backend. Object storage has no meaningful finite capacity, so
// it is reported as unknown rather than fabricated.
export async function collectStorageSignal(
  env: Record<string, string | undefined>,
): Promise<StorageSignal> {
  try {
    if ((env.STORAGE_PROVIDER ?? "local") !== "local") return { usedPercent: null };
    const root = env.STORAGE_LOCAL_PATH || ".data/files";
    const fs = await statfs(root);
    const total = Number(fs.blocks) * Number(fs.bsize);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (!Number.isFinite(total) || total <= 0) return { usedPercent: null };
    const usedPercent = Math.min(100, Math.max(0, Math.round(((total - free) / total) * 100)));
    return { usedPercent };
  } catch {
    return { usedPercent: null };
  }
}

// Backup state: bounded discovery of archive candidates, then the existing integrity
// verification path. A backup counts only after verification succeeds.
export async function collectBackupSignal(
  directory: string | null,
  options: { now?: Date; limit?: number } = {},
): Promise<BackupSignal> {
  const unknown: BackupSignal = { lastBackupAt: null, state: "unknown" };
  if (!directory) return unknown;
  try {
    const limit = options.limit ?? BACKUP_CANDIDATE_LIMIT;
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    if (!names.length) return { lastBackupAt: null, state: "never_verified" };
    // Deterministic bounded candidate selection: newest by modification time first,
    // capped, and metadata only. Contents are read only for the verification attempt.
    const candidates: { name: string; mtimeMs: number }[] = [];
    for (const name of names.slice(0, 64)) {
      try {
        const info = await stat(join(directory, name));
        candidates.push({ name, mtimeMs: info.mtimeMs });
      } catch {
        // Unreadable entries are skipped, never fatal.
      }
    }
    if (!candidates.length) return { lastBackupAt: null, state: "never_verified" };
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    for (const candidate of candidates.slice(0, limit)) {
      try {
        const summary = verifyBackup(await readFile(join(directory, candidate.name), "utf8"));
        return { lastBackupAt: summary.created_at ?? null, state: "verified" };
      } catch {
        // A corrupt or partial archive is never success; try the next candidate.
      }
    }
    // Candidates existed but none verified: report failure rather than a timestamp.
    return { lastBackupAt: null, state: "failed" };
  } catch {
    return unknown;
  }
}

// Collect everything, each adapter independently fail-soft. Nothing here can throw.
export async function collectOperationalSources(input: {
  q: QueryLike;
  env: Record<string, string | undefined>;
  backupDirectory?: string | null;
  now?: Date;
}): Promise<OperationalSources> {
  const [queue, storage, backup] = await Promise.all([
    collectQueueSignal(input.q).catch(() => ({ depth: null, state: "unknown" as HealthState })),
    collectStorageSignal(input.env).catch(() => ({ usedPercent: null })),
    collectBackupSignal(input.backupDirectory ?? null, { now: input.now }).catch(() => ({
      lastBackupAt: null,
      state: "unknown" as BackupVerificationState,
    })),
  ]);
  return { queue, storage, backup };
}
