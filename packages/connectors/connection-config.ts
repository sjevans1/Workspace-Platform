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
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      unknown.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      config[key] = value.filter((item) => typeof item === "string").slice(0, 32);
      continue;
    }
    if (typeof value === "string") config[key] = value.slice(0, 512);
    else unknown.push(key);
  }
  if (unknown.length)
    return {
      ok: false,
      error: `This deployment does not store: ${unknown.slice(0, 8).join(", ")}. Supported keys: ${[...allowed].join(", ")}.`,
    };
  return { ok: true, config };
}
