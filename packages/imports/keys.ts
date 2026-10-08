import { createHash } from "node:crypto";
import { z } from "zod";
import { assert, type Property } from "../contracts/index.ts";

// W09d governed keyed imports.
//
// Workspace record titles are not unique, so a keyed import must never infer
// identity from a title. The key property is chosen explicitly by the user and
// must be one whose comparison semantics are deterministic. This module owns
// that decision, the normalization it implies, and the digest that binds a
// keyed operation for idempotent replay.

/**
 * Import modes. Absence of a mode is append (the pre-existing behaviour), and
 * append is never reinterpreted as an update.
 */
export const importModes = [
  "append",
  "reject-on-existing",
  "skip-existing",
  "authorized-update",
] as const;
export type ImportMode = (typeof importModes)[number];
export const importMode = z.enum(importModes);

/**
 * Property types accepted as an import key.
 *
 * Every entry has an exact, total comparison rule with no hidden structure:
 * title/text/select compare as exact NFC strings (case and whitespace
 * significant), number compares as a canonical finite decimal, and date
 * compares as an ISO calendar day.
 *
 * Deliberately excluded: relation, rollup and formula (values are derived from
 * other rows, so a key would change without the imported data changing),
 * title (CSV title conversion trims and therefore cannot preserve exact
 * identity), select (CSV mapping does not yet support select values),
 * multi_select (no total order), person (identity is a membership, not a
 * value), status (option sets have their own lifecycle), checkbox (two values
 * cannot identify a row), and url/email (normalization needs a separately
 * reviewed contract).
 */
export const supportedKeyTypes = ["text", "number", "date"] as const;
export type SupportedKeyType = (typeof supportedKeyTypes)[number];

/**
 * Bump when the normalization below changes meaning. The value is bound into
 * the idempotency digest, so a change to normalization cannot silently replay
 * under an old key.
 *
 * Version 3: identity became exact NFC. Title, text and select keys preserve
 * case and every whitespace character, so only byte-equal values (modulo
 * Unicode normalization) match. Version 2 preserved case but still collapsed
 * surrounding and repeated whitespace, which merged values the approved
 * safe-exact contract treats as distinct. Blankness is still decided separately,
 * before normalization.
 */
export const KEY_NORMALIZATION_VERSION = 3;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function isSupportedKeyType(type: string): type is SupportedKeyType {
  return (supportedKeyTypes as readonly string[]).includes(type);
}

/**
 * Resolve an explicitly named property to a usable key, refusing everything
 * whose comparison semantics are not settled.
 */
export function resolveKeyProperty(
  properties: Property[],
  keyPropertyId: string,
): Property {
  const property = properties.find((p) => p.id === keyPropertyId);
  assert(property, 400, "Selected import key property is not in the target schema");
  assert(
    isSupportedKeyType(property!.type),
    400,
    "Import key must be one of " + supportedKeyTypes.join(", "),
  );
  return property!;
}

/**
 * Normalize a key value to its canonical comparison form.
 *
 * Returns null when the value is absent or blank, which is reported as a
 * missing key rather than matched against anything. Never returns a form that
 * depends on locale, and never throws a value-specific error that could leak
 * the value.
 */
export function normalizeKeyValue(
  property: Property,
  value: unknown,
): string | null {
  assert(
    isSupportedKeyType(property.type),
    400,
    "Import key must be one of " + supportedKeyTypes.join(", "),
  );
  const raw = value === null || value === undefined ? "" : String(value);
  const nfc = raw.normalize("NFC");
  // Blankness is decided on its own, before any normalization for matching, so
  // a value that is only whitespace is missing rather than a key.
  if (!nfc.trim()) return null;
  switch (property.type) {
    case "number": {
      // Canonical parsing: the numeric value is the identity.
      const num = Number(nfc.trim());
      assert(Number.isFinite(num), 400, "Import key number is not finite");
      return Object.is(num, -0) ? "0" : String(num);
    }
    case "date": {
      // Canonical parsing: the calendar day is the identity.
      const day = nfc.trim();
      assert(
        isoDate.test(day) &&
          !Number.isNaN(Date.parse(day)) &&
          new Date(day).toISOString().slice(0, 10) === day,
        400,
        "Import key date must be YYYY-MM-DD",
      );
      return day;
    }
    default:
      // title, text. NFC only: case and every whitespace character are part of
      // the identity, so "AC-1", "ac-1" and "AC-1 " are three different keys.
      // Unmatched keys insert instead, which fails safe.
      return nfc;
  }
}

export type KeyedImportBinding = {
  mode: ImportMode;
  key_property_id: string;
  target_database_id: string;
  schema_digest: string;
  content_hash: string;
  mapping: unknown;
  decision_set: string[];
};

/**
 * Bind a keyed import operation for idempotent replay.
 *
 * Every input that can change what the operation would do is part of the
 * digest, including the normalization version and the decisions taken at
 * preview time. Replaying a key with any of them changed is a conflict rather
 * than a resumption of the earlier operation.
 */
export function keyedImportDigest(binding: KeyedImportBinding): string {
  assert(binding.decision_set.length <= 2000, 400, "Decision set exceeds 2000 entries");
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: "workspace.keyed_import.v1",
        mode: binding.mode,
        key_property_id: binding.key_property_id,
        normalization_version: KEY_NORMALIZATION_VERSION,
        target_database_id: binding.target_database_id,
        schema_digest: binding.schema_digest,
        content_hash: binding.content_hash,
        mapping: binding.mapping,
        // Sorted so the digest depends on the decision set, not on the order a
        // caller happened to build it in.
        decision_set: [...binding.decision_set].sort(),
      }),
    )
    .digest("hex");
}

/**
 * Report whether an import mode may write to an existing record. Only
 * authorized-update does, and it still needs a per-record write decision and an
 * expected revision before any update is applied.
 */
export function modeWritesExisting(mode: ImportMode) {
  return mode === "authorized-update";
}
