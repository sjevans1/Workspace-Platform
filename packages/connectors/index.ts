/**
 * W29-A: Connected Work foundation.
 *
 * Importing this module registers the deterministic synthetic provider adapter, so
 * the connector architecture is complete and exercisable with no external account,
 * no credential and no network. Real providers (Gmail, Microsoft Graph, IMAP/SMTP,
 * Google/Microsoft Calendar, CalDAV, Telegram, Discord, WhatsApp) are DECLARED in
 * the registry as unimplemented and are implemented by the following tranche
 * against exactly this contract.
 */
import { SYNTHETIC_PROVIDER_KEY, ADAPTER_HOOKS, registerAdapter } from "./registry.ts";
import { SYNTHETIC_HOOKS } from "./adapter.ts";

if (!ADAPTER_HOOKS.has(SYNTHETIC_PROVIDER_KEY))
  registerAdapter(SYNTHETIC_PROVIDER_KEY, SYNTHETIC_HOOKS);

export * from "./registry.ts";
export * from "./adapter.ts";
export * from "./failure.ts";
export * from "./credentials.ts";
export * from "./runtime.ts";
export * from "./egress-policy.ts";
export * from "./egress-transport.ts";
export * from "./egress-runtime.ts";
export * from "./connection-config.ts";
export * from "./oauth-provider.ts";
export * from "./oauth.ts";
export * from "./oauth-test-provider.ts";
