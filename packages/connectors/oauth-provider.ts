/**
 * W29-P0/A3: operator-registered OAuth provider descriptors.
 *
 * A descriptor is DEPLOYMENT CONFIGURATION, never tenant input. The authorization,
 * token and revocation URLs, the client identity, the exact redirect URI, the scope
 * mapping and the refresh behaviour are all fixed by the operator and validated at
 * load, so a customer can never point a token exchange at an arbitrary URL, invent
 * a scope, or widen a grant.
 *
 * The deterministic test provider exists only when the deployment explicitly enables
 * test wiring, and that wiring is REFUSED in production mode: a production
 * deployment cannot offer a fake "Connect" that appears to succeed.
 */
import { assert } from "../contracts/index.ts";

/** A capability a scope grants, in the customer's own language. */
export type OAuthScopeMapping = {
  /** The provider's own scope string. */
  scope: string;
  /** The connector capability this scope is required for, when it maps to one. */
  capability: string | null;
  /** Short customer-facing label ("Read calendar events"). */
  label: string;
  /** One sentence explaining what the access allows. */
  description: string;
};

export type OAuthProviderDescriptor = {
  /** Matches the connector provider key in the catalog. */
  key: string;
  display_name: string;
  authorization_url: string;
  token_url: string;
  revoke_url: string | null;
  client_id: string;
  client_secret: string;
  client_auth: "client_secret_post" | "client_secret_basic";
  /** PKCE policy. Every non-test descriptor must be S256. */
  pkce: "S256" | "none";
  /** The EXACT redirect URI registered with the provider. */
  redirect_uri: string;
  scopes: OAuthScopeMapping[];
  /** How the provider rotates refresh tokens, which decides honest retry behaviour. */
  refresh_rotation: "rotates" | "static" | "unknown";
  /**
   * The token-response field that carries a safe account hint (for example an email
   * address). Bounded and sanitized; never a token.
   */
  account_hint_field: string | null;
  /** True only for the deterministic test fixture. */
  test_only: boolean;
};

export type OAuthRegistry = {
  descriptors: Map<string, OAuthProviderDescriptor>;
  /** True when the deployment has enabled the deterministic test provider. */
  test_provider_enabled: boolean;
};

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_FIELD = /^[a-z0-9_.-]{1,64}$/;

function httpsUrl(value: unknown, label: string, allowInsecure = false): string {
  const text = String(value ?? "").trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  // Only the deterministic acceptance fixture may be plain http, and only because
  // its transport never leaves the process. Every registered provider is https.
  assert(
    url.protocol === "https:" || (allowInsecure && url.protocol === "http:"),
    500,
    `${label} must use https`,
  );
  assert(!url.username && !url.password, 500, `${label} must not embed credentials`);
  assert(!url.hash, 500, `${label} must not carry a fragment`);
  return url.toString();
}

/** Absolute, query-free redirect URI: the exact registered callback. */
function redirectUri(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  assert(
    url.protocol === "https:" || url.protocol === "http:",
    500,
    `${label} must use http or https`,
  );
  assert(!url.search && !url.hash, 500, `${label} must not carry a query or fragment`);
  return url.toString();
}

export function parseOAuthDescriptor(
  raw: unknown,
  options: { test_only?: boolean } = {},
): OAuthProviderDescriptor {
  const testOnly = options.test_only === true;
  const input = (raw ?? {}) as Record<string, unknown>;
  const key = String(input.key ?? "").trim();
  assert(KEY.test(key), 500, "An OAuth provider needs a bounded key");
  const label = `OAuth provider ${key}`;
  const scopesRaw = Array.isArray(input.scopes) ? input.scopes : [];
  assert(
    scopesRaw.length > 0 && scopesRaw.length <= 32,
    500,
    `${label} needs 1..32 scope mappings`,
  );
  const scopes: OAuthScopeMapping[] = scopesRaw.map((entry) => {
    const scope = (entry ?? {}) as Record<string, unknown>;
    const value = String(scope.scope ?? "").trim();
    assert(
      value.length > 0 && value.length <= 200 && !/\s/.test(value),
      500,
      `${label} declares an invalid scope`,
    );
    return {
      scope: value,
      capability:
        scope.capability === null || scope.capability === undefined
          ? null
          : String(scope.capability),
      label: String(scope.label ?? value).slice(0, 120),
      description: String(scope.description ?? "").slice(0, 240),
    };
  });
  const clientAuth = String(input.client_auth ?? "client_secret_post");
  assert(
    clientAuth === "client_secret_post" || clientAuth === "client_secret_basic",
    500,
    `${label} declares an invalid client authentication method`,
  );
  const pkce = String(input.pkce ?? "S256");
  assert(
    pkce === "S256" || (pkce === "none" && testOnly),
    500,
    `${label} must use PKCE S256`,
  );
  const clientSecret = String(input.client_secret ?? "");
  assert(
    clientSecret.length >= 8 && clientSecret.length <= 512,
    500,
    `${label} needs an operator-registered client secret`,
  );
  const accountHintField =
    input.account_hint_field === null || input.account_hint_field === undefined
      ? null
      : String(input.account_hint_field);
  if (accountHintField !== null)
    assert(
      SAFE_FIELD.test(accountHintField),
      500,
      `${label} declares an invalid account hint field`,
    );
  const rotation = String(input.refresh_rotation ?? "unknown");
  assert(
    ["rotates", "static", "unknown"].includes(rotation),
    500,
    `${label} declares an invalid refresh rotation policy`,
  );

  const authorization_url = httpsUrl(
    input.authorization_url,
    `${label} authorization URL`,
    testOnly,
  );
  const token_url = httpsUrl(input.token_url, `${label} token URL`, testOnly);
  const revoke_url =
    input.revoke_url === null || input.revoke_url === undefined
      ? null
      : httpsUrl(input.revoke_url, `${label} revocation URL`, testOnly);

  return {
    key,
    display_name: String(input.display_name ?? key).slice(0, 120),
    authorization_url,
    token_url,
    revoke_url,
    client_id: String(input.client_id ?? "").trim().slice(0, 200),
    client_secret: clientSecret,
    client_auth: clientAuth as OAuthProviderDescriptor["client_auth"],
    pkce: pkce as OAuthProviderDescriptor["pkce"],
    redirect_uri: redirectUri(input.redirect_uri, `${label} redirect URI`),
    scopes,
    refresh_rotation: rotation as OAuthProviderDescriptor["refresh_rotation"],
    account_hint_field: accountHintField,
    test_only: testOnly,
  };
}

/**
 * The deterministic acceptance provider. Its authorization and token endpoints are
 * served by the deployment itself, and its transport is injected in-process, so the
 * browser journey is real while no external network is involved. It is registered
 * only when test wiring is enabled AND the deployment is not in production mode.
 */
export const OAUTH_TEST_PROVIDER_KEY = "oauth-test-provider";

export function oauthTestDescriptor(input: {
  base_url: string;
  redirect_uri: string;
  client_secret: string;
}): OAuthProviderDescriptor {
  const base = input.base_url.replace(/\/$/, "");
  return parseOAuthDescriptor(
    {
      key: OAUTH_TEST_PROVIDER_KEY,
      display_name: "Acceptance OAuth provider (test only)",
      // Served by the deployment's own API origin, under the API's public prefix, so
      // the browser reaches it through the same edge that serves /api/v1.
      authorization_url: `${base}/api/v1/oauth-test/authorize`,
      token_url: `${base}/api/v1/oauth-test/token`,
      revoke_url: `${base}/api/v1/oauth-test/revoke`,
      client_id: "workspace-acceptance-client",
      client_secret: input.client_secret,
      client_auth: "client_secret_post",
      pkce: "S256",
      redirect_uri: input.redirect_uri,
      refresh_rotation: "rotates",
      account_hint_field: "account_hint",
      scopes: [
        {
          scope: "profile.read",
          capability: "connection.health",
          label: "Read account identity",
          description: "Confirms which external account this connection uses.",
        },
        {
          scope: "messages.read",
          capability: "message.receive",
          label: "Read messages",
          description: "Reads messages the account already has access to.",
        },
        {
          scope: "messages.send",
          capability: "message.send",
          label: "Send messages",
          description: "Sends messages as the authorized account.",
        },
      ],
    },
    { test_only: true },
  );
}

/** True when the deployment runs in production mode (test wiring must be refused). */
export function productionMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

/**
 * Loads the operator-registered descriptors. A malformed registration throws, so a
 * misconfigured deployment fails loudly instead of silently losing a provider.
 */
export function loadOAuthRegistry(
  env: Record<string, string | undefined> = process.env,
  options: { base_url?: string | null } = {},
): OAuthRegistry {
  const descriptors = new Map<string, OAuthProviderDescriptor>();
  const raw = (env.CONNECTOR_OAUTH_PROVIDERS ?? "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("CONNECTOR_OAUTH_PROVIDERS must be valid JSON");
    }
    assert(Array.isArray(parsed), 500, "CONNECTOR_OAUTH_PROVIDERS must be an array");
    assert(parsed.length <= 32, 500, "Too many OAuth providers registered");
    for (const entry of parsed) {
      const descriptor = parseOAuthDescriptor(entry);
      assert(
        !descriptors.has(descriptor.key),
        500,
        `Duplicate OAuth provider: ${descriptor.key}`,
      );
      descriptors.set(descriptor.key, descriptor);
    }
  }

  const testRequested = (env.CONNECTOR_OAUTH_TEST_PROVIDER ?? "").trim();
  let testProviderEnabled = false;
  if (testRequested && testRequested !== "0" && testRequested !== "false") {
    // A production deployment may not offer a deterministic fake provider.
    assert(
      !productionMode(env),
      500,
      "The deterministic OAuth test provider cannot be enabled in production",
    );
    const baseUrl = options.base_url ?? env.APP_URL ?? "http://localhost:3000";
    const secret = String(
      env.CONNECTOR_OAUTH_TEST_CLIENT_SECRET ?? "acceptance-test-client-secret",
    );
    const descriptor = oauthTestDescriptor({
      base_url: baseUrl,
      redirect_uri: `${baseUrl.replace(/\/$/, "")}/api/v1/connectors/oauth/callback`,
      client_secret: secret,
    });
    descriptors.set(descriptor.key, descriptor);
    testProviderEnabled = true;
  }
  return { descriptors, test_provider_enabled: testProviderEnabled };
}

let cachedRegistry: OAuthRegistry | null = null;
let registryOverride: OAuthRegistry | null = null;

/**
 * The deployment's registered OAuth providers. Loaded once per process; a malformed
 * registration throws, so a misconfigured deployment fails loudly.
 */
export function oauthRegistry(
  env: Record<string, string | undefined> = process.env,
): OAuthRegistry {
  if (registryOverride) return registryOverride;
  if (!cachedRegistry) cachedRegistry = loadOAuthRegistry(env);
  return cachedRegistry;
}

/**
 * Test seam: an acceptance run installs a registry directly (the deterministic
 * provider plus a descriptor). It is not reachable from configuration, from a route
 * or from a request.
 */
export function setOAuthRegistryForTesting(registry: OAuthRegistry | null): void {
  registryOverride = registry;
}

/** The descriptor for a provider key, or null when it is not registered here. */
export function oauthDescriptorFor(
  key: string,
  env: Record<string, string | undefined> = process.env,
): OAuthProviderDescriptor | null {
  return oauthRegistry(env).descriptors.get(key) ?? null;
}

/** The exact scopes an attempt requests for a chosen capability set. */
export function scopesForCapabilities(
  descriptor: OAuthProviderDescriptor,
  capabilities: string[],
): string[] {
  const wanted = new Set(capabilities);
  const scopes = descriptor.scopes
    .filter((entry) => entry.capability !== null && wanted.has(entry.capability))
    .map((entry) => entry.scope);
  // Only scopes the descriptor declares can ever be requested.
  return [...new Set(scopes)].slice(0, 32);
}

/**
 * The effective grant is the INTERSECTION of what was requested, what the provider
 * returned and what the descriptor declares. A provider cannot widen authority, and
 * a deficient response cannot promote a connection to connected.
 */
export function effectiveGrant(input: {
  descriptor: OAuthProviderDescriptor;
  requested_scopes: string[];
  granted_scopes: string[];
}): { capabilities: string[]; scopes: string[]; complete: boolean } {
  const declared = new Set(input.descriptor.scopes.map((entry) => entry.scope));
  const requested = input.requested_scopes.filter((scope) => declared.has(scope));
  const granted = new Set(input.granted_scopes.filter((scope) => declared.has(scope)));
  const scopes = requested.filter((scope) => granted.has(scope));
  const capabilities = [
    ...new Set(
      input.descriptor.scopes
        .filter((entry) => entry.capability !== null && scopes.includes(entry.scope))
        .map((entry) => entry.capability as string),
    ),
  ];
  return {
    scopes,
    capabilities,
    complete: requested.every((scope) => granted.has(scope)),
  };
}

/** A bounded, non-secret account hint. Never a token, never free-form. */
export function sanitizeAccountHint(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, 160);
  if (!text) return null;
  if (/[\s]/.test(text)) return null;
  if (!/^[^\s@]{3,160}$/.test(text)) return null;
  // Refuse anything that looks like a bearer credential rather than an identity.
  if (/^(ey[A-Za-z0-9_-]{10,}|ya29\.|1\/\/|bearer)/i.test(text)) return null;
  if (text.length > 3 && text.split(".").length >= 3 && /^[A-Za-z0-9_-]+$/.test(text.replaceAll(".", "")))
    return null;
  return text;
}
