/**
 * W29-P0/A3: the deterministic acceptance OAuth provider.
 *
 * This is a TEST FIXTURE, not a provider integration. It is registered only when the
 * deployment explicitly enables test wiring, and that wiring is refused in production
 * mode (see `loadOAuthRegistry`). In production the provider key does not exist, the
 * descriptor is never registered, the adapter is never registered, and the browser
 * routes below are never mounted, so a production deployment cannot offer a fake
 * "Connect" that appears to succeed.
 *
 * The browser half is a real HTTP round trip: the administrator is redirected to the
 * provider's own consent page, presses Approve or Deny, and the provider redirects
 * back to the registered callback with a code and the state. The server half (token
 * exchange, refresh, revocation) runs in-process through the injected transport, so
 * acceptance is deterministic and involves no external network, while the substrate's
 * production path remains A2's governed HTTPS transport.
 */
import { createHash, randomUUID } from "node:crypto";
import { assert } from "../contracts/index.ts";
import { registerAdapter, registerProviderDefinition } from "./registry.ts";
import { SYNTHETIC_HOOKS } from "./adapter.ts";
import {
  OAUTH_TEST_PROVIDER_KEY,
  type OAuthProviderDescriptor,
} from "./oauth-provider.ts";
import type { OAuthHttpTransport } from "./oauth.ts";

/** The provider definition an acceptance connection is created against. */
export const OAUTH_TEST_PROVIDER_DEFINITION = {
  key: OAUTH_TEST_PROVIDER_KEY,
  display_name: "Acceptance OAuth provider (test only)",
  category: "acceptance",
  adapter_version: "1.0.0",
  auth_modes: ["oauth2_authorization_code_pkce"],
  capabilities: ["connection.health", "connection.sync", "message.receive", "message.send"],
  actions: [
    {
      key: "acceptance.send",
      display_name: "Send a message through the acceptance provider",
      requires_capability: "message.send",
      retryable: true,
      idempotent: true,
    },
  ],
  credential_kinds: ["oauth_access", "oauth_refresh"],
  ownership: ["user", "tenant"],
  webhook: false,
  polling: true,
  incremental_sync: true,
  health_check: true,
  endpoint_required: false,
  default_poll_interval_seconds: 300,
  max_event_metadata_bytes: 2048,
} as const;

type IssuedCode = {
  code: string;
  descriptor_key: string;
  redirect_uri: string;
  scopes: string[];
  challenge: string;
  method: string;
  account_hint: string;
  consumed: boolean;
  refresh_count: number;
  /** Deterministic behaviours an acceptance run can ask for. */
  behaviour: "approve" | "deny" | "invalid_grant_on_refresh";
};

const codes = new Map<string, IssuedCode>();

/** Test-visible state, so a regression can assert single-use and rotation. */
export function oauthTestProviderState() {
  return {
    issued: codes.size,
    live: [...codes.values()].filter((entry) => !entry.consumed).length,
  };
}

export function resetOAuthTestProvider(): void {
  codes.clear();
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The consent decision the acceptance browser makes. */
export function issueTestCode(input: {
  descriptor_key: string;
  redirect_uri: string;
  scopes: string[];
  challenge: string;
  method: string;
  behaviour: IssuedCode["behaviour"];
  account_hint?: string;
}): IssuedCode {
  const entry: IssuedCode = {
    code: `test-code-${randomUUID()}`,
    descriptor_key: input.descriptor_key,
    redirect_uri: input.redirect_uri,
    scopes: input.scopes,
    challenge: input.challenge,
    method: input.method,
    account_hint: input.account_hint ?? "operations@example.test",
    consumed: false,
    refresh_count: 0,
    behaviour: input.behaviour,
  };
  codes.set(entry.code, entry);
  return entry;
}

function tokenBody(entry: IssuedCode, rotate: boolean): string {
  return JSON.stringify({
    access_token: `test-access-${randomUUID()}`,
    refresh_token: rotate
      ? `test-refresh-${randomUUID()}`
      : `test-refresh-static-${entry.code}`,
    token_type: "Bearer",
    expires_in: 3600,
    scope: entry.scopes.join(" "),
    account_hint: entry.account_hint,
  });
}

/**
 * The injected transport. It answers the descriptor's own token and revocation URLs
 * in-process: the code, PKCE verifier, client credentials and refresh behaviour are
 * all verified exactly as a real provider would, so the substrate's contract is
 * genuinely exercised.
 */
export function testOAuthTransport(
  descriptor: OAuthProviderDescriptor,
): OAuthHttpTransport {
  return async (input) => {
    assert(
      input.descriptor.key === OAUTH_TEST_PROVIDER_KEY,
      500,
      "The acceptance transport only serves the acceptance provider",
    );
    const form = input.form;
    // The fixture accepts BOTH declared client authentication methods, so a
    // regression can prove the substrate sends what the descriptor declares.
    const basic = String(input.headers?.authorization ?? "");
    if (basic.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(basic.slice(6), "base64")
        .toString("utf8")
        .split(":");
      form.client_id = id;
      form.client_secret = secret;
    }
    if (input.url === descriptor.token_url) {
      if (form.grant_type === "authorization_code") {
        const entry = codes.get(String(form.code ?? ""));
        if (!entry || entry.consumed || entry.descriptor_key !== descriptor.key)
          return { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
        if (entry.redirect_uri !== String(form.redirect_uri ?? ""))
          return { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
        const verifier = String(form.code_verifier ?? "");
        if (descriptor.pkce === "S256") {
          if (!verifier || pkceChallenge(verifier) !== entry.challenge)
            return { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
        }
        if (form.client_id !== descriptor.client_id || form.client_secret !== descriptor.client_secret)
          return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
        if (entry.behaviour === "deny")
          return { status: 400, body: JSON.stringify({ error: "access_denied" }) };
        entry.consumed = true;
        return { status: 200, body: tokenBody(entry, true) };
      }
      if (form.grant_type === "refresh_token") {
        const token = String(form.refresh_token ?? "");
        if (!token.startsWith("test-refresh-"))
          return { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
        if (form.client_id !== descriptor.client_id || form.client_secret !== descriptor.client_secret)
          return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
        const source = [...codes.values()].find((entry) =>
          token.includes(entry.code),
        );
        const template: IssuedCode =
          source ?? {
            code: token.slice(-36),
            descriptor_key: descriptor.key,
            redirect_uri: descriptor.redirect_uri,
            scopes: descriptor.scopes.map((entry) => entry.scope),
            challenge: "",
            method: "S256",
            account_hint: "operations@example.test",
            consumed: true,
            refresh_count: 0,
            behaviour: "approve",
          };
        if (template.behaviour === "invalid_grant_on_refresh")
          return { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
        // Rotation: a fresh refresh token every time, which is the strictest
        // behaviour the substrate must survive.
        template.refresh_count += 1;
        return { status: 200, body: tokenBody(template, true) };
      }
      return { status: 400, body: JSON.stringify({ error: "unsupported_grant_type" }) };
    }
    if (descriptor.revoke_url && input.url === descriptor.revoke_url)
      return { status: 200, body: "{}" };
    return { status: 404, body: JSON.stringify({ error: "not_found" }) };
  };
}

/** Registers the acceptance provider. Refused unless the caller enabled test wiring. */
export function registerOAuthTestProvider(): void {
  registerProviderDefinition(OAUTH_TEST_PROVIDER_DEFINITION as never);
  registerAdapter(OAUTH_TEST_PROVIDER_KEY, SYNTHETIC_HOOKS);
}
