/**
 * W29-P0/A2: the connection-creation configuration contract.
 *
 * The guided Connections flow shows typed endpoint fields when a provider declares
 * that it needs an endpoint, and keeps raw provider JSON behind an explicit
 * Advanced disclosure. Both paths funnel through this one builder, so a typed value
 * can never be silently discarded: it is bound into the outgoing `config` request,
 * and an explicit conflict with the Advanced JSON is refused rather than guessed at.
 *
 * This module is deliberately BROWSER-SAFE (no node built-ins): the same function
 * runs in the web application and in the API. The authoritative host
 * canonicalization lives in `egress-policy.ts` and runs server-side, because a
 * browser bundle must never pull in the policy module's node:net dependency. The
 * shape check here is exactly that: a pre-check, named as one.
 */
export type ConnectionConfigInput = {
  /** Raw provider JSON from the Advanced disclosure, when the caller used it. */
  advanced_json?: string | null;
  /**
   * The configuration keys this deployment actually stores. Anything else would be
   * silently dropped by the persistence layer, so it is refused here instead, with
   * the offending keys named.
   */
  allowed_keys: readonly string[];
};

export type ConnectionConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Builds the connection `config` request from the guided form.
 *
 * Nothing is silently discarded: a key this deployment does not store is a refusal
 * that names it, and values are normalized to exactly the shapes the persistence
 * layer accepts (a bounded string, or a bounded list of strings).
 */
/**
 * The value bounds the persistence layer enforces. A value outside them is REFUSED
 * here, never quietly trimmed: a truncated credential label or a silently dropped
 * scope would tell the administrator something was stored that was not.
 */
export const CONNECTION_CONFIG_BOUNDS = Object.freeze({
  max_string_length: 512,
  max_list_entries: 32,
});

export function buildConnectionConfig(
  input: ConnectionConfigInput,
): ConnectionConfigResult {
  const raw = String(input.advanced_json ?? "").trim();
  if (!raw) return { ok: true, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Advanced configuration is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, error: "Advanced configuration must be a JSON object." };
  const allowed = new Set(input.allowed_keys);
  const config: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      rejected.push(`${key} (not stored by this deployment)`);
      continue;
    }
    if (typeof value === "string") {
      if (value.length > CONNECTION_CONFIG_BOUNDS.max_string_length) {
        rejected.push(
          `${key} (longer than ${CONNECTION_CONFIG_BOUNDS.max_string_length} characters)`,
        );
        continue;
      }
      config[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > CONNECTION_CONFIG_BOUNDS.max_list_entries) {
        rejected.push(
          `${key} (more than ${CONNECTION_CONFIG_BOUNDS.max_list_entries} entries)`,
        );
        continue;
      }
      const bad = value.findIndex((item) => typeof item !== "string");
      if (bad >= 0) {
        rejected.push(`${key} (entry ${bad + 1} is not a string)`);
        continue;
      }
      config[key] = [...(value as string[])];
      continue;
    }
    rejected.push(`${key} (must be a string or a list of strings)`);
  }
  if (rejected.length)
    return {
      ok: false,
      error: `Refused: ${rejected.slice(0, 8).join(", ")}. Supported keys: ${[...allowed].join(", ")}.`,
    };
  return { ok: true, config };
}
