import { assert, type Property } from "../contracts/index.ts";
import {
  KEY_NORMALIZATION_VERSION,
  normalizeKeyValue,
  resolveKeyProperty,
  type ImportMode,
} from "./keys.ts";

// W09d keyed import planning.
//
// This module decides, for every source row, whether it inserts, updates,
// skips or conflicts, and it does so without touching the database. The caller
// supplies the records it is allowed to see, so an invisible record can never
// be turned into a decision or a number here. That keeps the security boundary
// in one place: whatever the caller cannot see is reported as a restricted
// conflict and nothing else.

/** A record the caller is authorized to see and, for updates, to write. */
export type VisibleRecord = {
  resource_id: string;
  revision: number;
  /** Stored property values, used only to read the key property. */
  values: Record<string, unknown>;
};

export type KeyedRowDecision =
  | { index: number; action: "insert"; key: string | null }
  | {
      index: number;
      action: "update";
      key: string;
      resource_id: string;
      expected_revision: number;
    }
  | { index: number; action: "skip"; key: string; reason: "existing_record" }
  | {
      index: number;
      action: "conflict";
      key: string | null;
      reason:
        | "missing_key"
        | "malformed_key"
        | "duplicate_key_in_source"
        | "existing_record"
        | "ambiguous_match";
    }
  | { index: number; action: "conflict_restricted"; key: string | null };

export type KeyedPlan = {
  mode: ImportMode;
  key_property_id: string | null;
  normalization_version: number;
  rows: KeyedRowDecision[];
  counts: {
    insert: number;
    update: number;
    skip: number;
    conflict: number;
    conflict_restricted: number;
  };
};

export type PlanKeyedImport = {
  mode: ImportMode;
  /** Raw key property value per source row, already mapped to property ids. */
  rows: Array<Record<string, unknown>>;
  targetProperties: Property[];
  /** Explicitly selected key property. Required by every mode except append. */
  keyPropertyId?: string | null;
  /** Records the caller may see, in the target database. */
  visible: VisibleRecord[];
  /**
   * Normalized keys known to collide with a record the caller may not see.
   * Callers must be able to compute this without learning which record it is.
   */
  restrictedKeys?: Iterable<string>;
};

/**
 * Build the governed plan for a keyed import.
 *
 * Append is deliberately key-blind: it keeps the accepted behaviour of the
 * pre-existing product, where every row is inserted and no existing record is
 * probed. Every other mode requires an explicit key property.
 */
export function planKeyedImport(input: PlanKeyedImport): KeyedPlan {
  const { mode, rows, targetProperties } = input;

  if (mode === "append") {
    assert(
      input.keyPropertyId === undefined || input.keyPropertyId === null,
      400,
      "Append mode does not take a key property",
    );
    return {
      mode,
      key_property_id: null,
      normalization_version: KEY_NORMALIZATION_VERSION,
      rows: rows.map((_, index) => ({ index, action: "insert", key: null })),
      counts: {
        insert: rows.length,
        update: 0,
        skip: 0,
        conflict: 0,
        conflict_restricted: 0,
      },
    };
  }

  assert(input.keyPropertyId, 400, "Keyed import modes require a key property");
  const keyProperty = resolveKeyProperty(targetProperties, input.keyPropertyId!);
  const restricted = new Set(input.restrictedKeys || []);

  // Index the visible records by normalized key. Duplicate stored keys are
  // kept as a list because a key matching more than one record is ambiguous.
  const storedByKey = new Map<string, VisibleRecord[]>();
  for (const record of input.visible) {
    const key = normalizeStoredKey(keyProperty, record.values[keyProperty.id]);
    if (key === null) continue;
    const bucket = storedByKey.get(key) || [];
    bucket.push(record);
    storedByKey.set(key, bucket);
  }

  // Normalize every source key first, so duplicates inside the file are known
  // before any single row is classified.
  const normalized: Array<string | null | "malformed"> = rows.map((row) => {
    try {
      return normalizeKeyValue(keyProperty, row[keyProperty.id]);
    } catch {
      return "malformed";
    }
  });
  const occurrences = new Map<string, number>();
  for (const key of normalized)
    if (typeof key === "string")
      occurrences.set(key, (occurrences.get(key) || 0) + 1);

  const decisions: KeyedRowDecision[] = normalized.map((key, index) => {
    if (key === "malformed") return { index, action: "conflict", key: null, reason: "malformed_key" };
    if (key === null) return { index, action: "conflict", key: null, reason: "missing_key" };
    // A key repeated inside the same file cannot identify one row.
    if ((occurrences.get(key) || 0) > 1)
      return { index, action: "conflict", key, reason: "duplicate_key_in_source" };
    // An invisible collision is reported generically and counted once, with no
    // identifier, value, owner or revision revealed.
    if (restricted.has(key)) return { index, action: "conflict_restricted", key: null };

    const matches = storedByKey.get(key) || [];
    if (mode === "authorized-update") {
      if (matches.length === 0) return { index, action: "insert", key };
      if (matches.length > 1)
        return { index, action: "conflict", key, reason: "ambiguous_match" };
      const match = matches[0];
      return {
        index,
        action: "update",
        key,
        resource_id: match.resource_id,
        expected_revision: match.revision,
      };
    }
    if (matches.length === 0) {
      // reject-on-existing and skip-existing both insert a genuinely new key.
      return { index, action: "insert", key };
    }
    if (mode === "skip-existing") return { index, action: "skip", key, reason: "existing_record" };
    // reject-on-existing, including the ambiguous case, refuses the operation.
    return {
      index,
      action: "conflict",
      key,
      reason: matches.length > 1 ? "ambiguous_match" : "existing_record",
    };
  });

  const counts = {
    insert: decisions.filter((d) => d.action === "insert").length,
    update: decisions.filter((d) => d.action === "update").length,
    skip: decisions.filter((d) => d.action === "skip").length,
    conflict: decisions.filter((d) => d.action === "conflict").length,
    conflict_restricted: decisions.filter((d) => d.action === "conflict_restricted").length,
  };
  return {
    mode,
    key_property_id: keyProperty.id,
    normalization_version: KEY_NORMALIZATION_VERSION,
    rows: decisions,
    counts,
  };
}

/**
 * Normalize a stored key the same way a source key is normalized. A stored
 * value that cannot be normalized is skipped rather than matched loosely, so a
 * malformed stored value cannot silently swallow a new row.
 */
function normalizeStoredKey(property: Property, value: unknown): string | null {
  try {
    return normalizeKeyValue(property, value);
  } catch {
    return null;
  }
}

/**
 * The decision set bound into the idempotency digest. Only decisions that a
 * replay must reproduce are included, and nothing here reveals a restricted
 * match beyond the fact that the row conflicted.
 */
export function keyedDecisionSet(plan: KeyedPlan): string[] {
  return plan.rows.map((row) => {
    switch (row.action) {
      case "update":
        return `row:${row.index}:update:${row.resource_id}:rev${row.expected_revision}`;
      case "insert":
        return `row:${row.index}:insert`;
      case "skip":
        return `row:${row.index}:skip`;
      case "conflict":
        return `row:${row.index}:conflict:${row.reason}`;
      case "conflict_restricted":
        return `row:${row.index}:conflict`;
    }
  });
}
