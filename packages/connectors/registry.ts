/**
 * W29-A: the provider-neutral Connected Work registry.
 *
 * A connector PROVIDER is a versioned adapter definition; a CONNECTION is a
 * tenant-scoped instance of one provider. Nothing in generic Workspace domain code
 * may hard-code provider behaviour: it reads these definitions, the capability
 * vocabulary and the registered adapter hooks, and provider-specific logic lives
 * only inside the adapter.
 *
 * This tranche registers exactly one deterministic SYNTHETIC provider so the whole
 * architecture is accepted end to end with no external credential, plus a
 * declared-but-unimplemented list of the provider keys the later tranche will
 * implement. A declared provider is metadata only: it exposes no adapter, no
 * credential handling and no action, and the catalog reports it as not implemented.
 */
import { assert } from "../contracts/index.ts";
import type { AdapterHooks } from "./adapter.ts";

/** Bumped whenever the capability vocabulary changes meaning. */
export const CAPABILITY_VOCABULARY_VERSION = "1.0.0";

export const CONNECTOR_CAPABILITIES = [
  "mail.read",
  "mail.search",
  "mail.send",
  "mail.reply",
  "calendar.read",
  "calendar.create",
  "calendar.update",
  "calendar.cancel",
  "calendar.freebusy",
  "message.receive",
  "message.send",
  "message.reply",
  "connection.health",
  "connection.sync",
] as const;
export type Capability = (typeof CONNECTOR_CAPABILITIES)[number];

export const CAPABILITY_CATEGORY: Record<Capability, string> = {
  "mail.read": "email",
  "mail.search": "email",
  "mail.send": "email",
  "mail.reply": "email",
  "calendar.read": "calendar",
  "calendar.create": "calendar",
  "calendar.update": "calendar",
  "calendar.cancel": "calendar",
  "calendar.freebusy": "calendar",
  "message.receive": "messaging",
  "message.send": "messaging",
  "message.reply": "messaging",
  "connection.health": "connector_management",
  "connection.sync": "connector_management",
};

export type CredentialKind =
  | "oauth_access"
  | "oauth_refresh"
  | "api_key"
  | "bot_token"
  | "client_secret"
  | "webhook_secret"
  | "basic";
export const CREDENTIAL_KINDS: CredentialKind[] = [
  "oauth_access",
  "oauth_refresh",
  "api_key",
  "bot_token",
  "client_secret",
  "webhook_secret",
  "basic",
];

export type AuthMode =
  | "oauth2_authorization_code_pkce"
  | "oauth2_authorization_code"
  | "api_key"
  | "bot_token"
  | "basic"
  | "none";
export const AUTH_MODES: AuthMode[] = [
  "oauth2_authorization_code_pkce",
  "oauth2_authorization_code",
  "api_key",
  "bot_token",
  "basic",
  "none",
];

export type ProviderCategory = "mail" | "calendar" | "messaging" | "synthetic";

export type ConnectorActionDefinition = {
  /** Stable action key, for example `synthetic.record`. */
  key: string;
  display_name: string;
  /** The capability a connection must hold before this action may run. */
  requires_capability: Capability;
  retryable: boolean;
  /**
   * W29-P0/A1: true when the provider offers an idempotency primitive for this
   * action, so a re-send carrying the same effect idempotency key cannot duplicate
   * the external operation. It is the ONLY thing that makes a re-send after a
   * reclaimed lease safe; an action that does not declare it is treated as
   * at-most-once with an unknown outcome.
   */
  idempotent?: boolean;
};

export type ProviderDefinition = {
  key: string;
  display_name: string;
  category: ProviderCategory;
  /** Adapter contract version. Bumped when the adapter's observable behaviour changes. */
  adapter_version: string;
  auth_modes: AuthMode[];
  capabilities: Capability[];
  actions: ConnectorActionDefinition[];
  credential_kinds: CredentialKind[];
  ownership: ("user" | "tenant")[];
  webhook: boolean;
  polling: boolean;
  incremental_sync: boolean;
  health_check: boolean;
  default_poll_interval_seconds: number;
  /** Adapter-declared ceiling for the bounded event metadata it will accept. */
  max_event_metadata_bytes: number;
};

/** Future provider keys. Registered metadata only; no adapter is implemented. */
export const DECLARED_PROVIDER_KEYS = [
  "google-mail",
  "microsoft-mail",
  "imap-smtp",
  "google-calendar",
  "microsoft-calendar",
  "caldav",
  "telegram",
  "discord",
  "whatsapp",
] as const;

export const SYNTHETIC_PROVIDER_KEY = "synthetic-test";

const SYNTHETIC_PROVIDER: ProviderDefinition = {
  key: SYNTHETIC_PROVIDER_KEY,
  display_name: "Synthetic test provider",
  category: "synthetic",
  adapter_version: "1.0.0",
  auth_modes: ["none"],
  capabilities: [
    "connection.health",
    "connection.sync",
    "message.receive",
    "message.send",
  ],
  actions: [
    {
      key: "synthetic.record",
      display_name: "Record a synthetic connector action",
      requires_capability: "message.send",
      retryable: true,
      // The fixture has no external side effect, and it derives a stable provider
      // reference from the effect idempotency key, so a re-send with the same key
      // is provably one logical operation.
      idempotent: true,
    },
  ],
  credential_kinds: ["webhook_secret"],
  ownership: ["user", "tenant"],
  webhook: true,
  polling: true,
  incremental_sync: true,
  health_check: true,
  default_poll_interval_seconds: 300,
  max_event_metadata_bytes: 2048,
};

/**
 * Provider registration validates the definition rather than trusting it: a
 * malformed adapter (unknown capability, an action requiring a capability it does
 * not declare, a missing credential kind for its auth mode, a zero poll interval)
 * must fail at MODULE LOAD, because an unvalidated provider would otherwise be
 * reachable at runtime.
 */
export function validateProviderRegistration(
  definition: ProviderDefinition,
): ProviderDefinition {
  assert(
    /^[a-z][a-z0-9-]{1,63}$/.test(definition.key),
    500,
    `Connector provider key is invalid: ${definition.key}`,
  );
  assert(definition.display_name.trim().length > 0, 500, "Provider display name is required");
  assert(
    /^\d+\.\d+\.\d+$/.test(definition.adapter_version),
    500,
    `Provider ${definition.key} adapter version must be semantic`,
  );
  assert(definition.auth_modes.length > 0, 500, `Provider ${definition.key} declares no auth mode`);
  for (const mode of definition.auth_modes)
    assert(AUTH_MODES.includes(mode), 500, `Provider ${definition.key} declares unknown auth mode ${mode}`);
  assert(definition.ownership.length > 0, 500, `Provider ${definition.key} supports no ownership kind`);
  for (const kind of definition.ownership)
    assert(["user", "tenant"].includes(kind), 500, `Provider ${definition.key} declares invalid ownership ${kind}`);
  assert(definition.capabilities.length > 0, 500, `Provider ${definition.key} declares no capability`);
  for (const capability of definition.capabilities)
    assert(
      (CONNECTOR_CAPABILITIES as readonly string[]).includes(capability),
      500,
      `Provider ${definition.key} declares unregistered capability ${capability}`,
    );
  const actionKeys = new Set<string>();
  for (const action of definition.actions) {
    assert(
      /^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,3}$/.test(action.key),
      500,
      `Provider ${definition.key} action key is invalid: ${action.key}`,
    );
    assert(!actionKeys.has(action.key), 500, `Provider ${definition.key} registers duplicate action ${action.key}`);
    actionKeys.add(action.key);
    // A provider adapter may not invent an arbitrary runtime capability string:
    // every action is bound to a declared capability of its own provider.
    assert(
      definition.capabilities.includes(action.requires_capability),
      500,
      `Provider ${definition.key} action ${action.key} requires an undeclared capability`,
    );
  }
  assert(definition.credential_kinds.length > 0, 500, `Provider ${definition.key} declares no credential kind`);
  for (const kind of definition.credential_kinds)
    assert(CREDENTIAL_KINDS.includes(kind), 500, `Provider ${definition.key} declares unknown credential kind ${kind}`);
  if (definition.webhook)
    assert(
      definition.credential_kinds.includes("webhook_secret"),
      500,
      `Provider ${definition.key} accepts webhooks without a webhook secret credential kind`,
    );
  if (definition.polling)
    assert(
      Number.isInteger(definition.default_poll_interval_seconds) &&
        definition.default_poll_interval_seconds >= 60 &&
        definition.default_poll_interval_seconds <= 86400,
      500,
      `Provider ${definition.key} poll interval is outside the bounded range`,
    );
  assert(
    Number.isInteger(definition.max_event_metadata_bytes) &&
      definition.max_event_metadata_bytes >= 256 &&
      definition.max_event_metadata_bytes <= 8192,
    500,
    `Provider ${definition.key} event metadata bound is outside the bounded range`,
  );
  return definition;
}

const DEFINITIONS = [SYNTHETIC_PROVIDER].map(validateProviderRegistration);
const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

/** Registered adapters, keyed by provider. Only validated definitions appear here. */
export const PROVIDER_REGISTRY: ReadonlyMap<string, ProviderDefinition> = BY_KEY;

export function providerDefinition(key: string): ProviderDefinition {
  const definition = BY_KEY.get(key);
  assert(definition, 400, `Unknown connector provider: ${key}`);
  return definition!;
}

export function providerKeys(): string[] {
  return [...BY_KEY.keys()].sort();
}

/** The catalog an administrator may request a connection against. */
export function providerCatalog(): ProviderDefinition[] {
  return providerKeys().map((key) => BY_KEY.get(key)!);
}

/**
 * The declared provider keys with no adapter in this tranche. Reported honestly as
 * `implemented: false` so the Connections surface never implies an unimplemented
 * provider can be connected.
 */
export function declaredProviders(): { key: string; implemented: false }[] {
  return [...DECLARED_PROVIDER_KEYS].sort().map((key) => ({ key, implemented: false as const }));
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Normalizes and validates a requested capability list. Unknown strings are
 * REJECTED rather than dropped, so a caller can never believe it was granted a
 * capability that does not exist.
 */
export function normalizeCapabilities(value: unknown): Capability[] {
  assert(Array.isArray(value), 400, "Capabilities must be an array");
  const unique = [...new Set(value)];
  assert(unique.length <= CONNECTOR_CAPABILITIES.length, 400, "Too many capabilities requested");
  for (const capability of unique)
    assert(isCapability(capability), 400, `Unknown connector capability: ${String(capability)}`);
  return (unique as Capability[]).sort();
}

/** Default requested capabilities for a new connection: every declared capability. */
export function defaultCapabilities(definition: ProviderDefinition): Capability[] {
  return [...definition.capabilities].sort();
}

/** Adapter hooks are attached per provider; a declared provider has none. */
export const ADAPTER_HOOKS = new Map<string, AdapterHooks>();
export function registerAdapter(key: string, hooks: AdapterHooks): void {
  const definition = providerDefinition(key);
  assert(
    definition.capabilities.every((capability) => hooks.capabilities.includes(capability)),
    500,
    `Adapter ${key} must implement every declared capability`,
  );
  ADAPTER_HOOKS.set(key, hooks);
}
export function adapterFor(key: string): AdapterHooks {
  providerDefinition(key);
  const hooks = ADAPTER_HOOKS.get(key);
  assert(hooks, 500, `Connector provider ${key} has no registered adapter`);
  return hooks!;
}
export function adapterImplemented(key: string): boolean {
  return BY_KEY.has(key) && ADAPTER_HOOKS.has(key);
}
