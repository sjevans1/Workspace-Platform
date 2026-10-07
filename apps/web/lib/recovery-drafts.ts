export const WORKSPACE_DRAFT_PREFIX = "workspace-recovery:v1:";
export const WORKSPACE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKSPACE_DRAFT_MAX_BYTES = 512 * 1024;
export const WORKSPACE_DRAFT_MAX_COUNT = 8;

export type WorkspaceDraftIdentity = {
  principal: string;
  room: string;
};

export type WorkspaceDraft = {
  updatedAt: number;
  update: Uint8Array;
};

type StoredDraft = {
  version: 1;
  principal: string;
  room: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  update: string;
};

type DraftStore = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export type DraftSaveResult =
  | { ok: true }
  | { ok: false; reason: "too-large" | "storage-unavailable" };

function storeOrDefault(store?: DraftStore): DraftStore | null {
  if (store) return store;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function identityKey(identity: WorkspaceDraftIdentity) {
  // encodeURIComponent avoids delimiter ambiguity. The identifiers are not
  // treated as secrets; draft content remains protected by the browser/OS
  // profile, not by reversible obfuscation presented as encryption.
  return (
    WORKSPACE_DRAFT_PREFIX +
    encodeURIComponent(identity.principal) +
    ":" +
    encodeURIComponent(identity.room)
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}

function parse(value: string | null): StoredDraft | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredDraft>;
    if (
      parsed.version !== 1 ||
      typeof parsed.principal !== "string" ||
      typeof parsed.room !== "string" ||
      !Number.isFinite(parsed.createdAt) ||
      !Number.isFinite(parsed.updatedAt) ||
      !Number.isFinite(parsed.expiresAt) ||
      typeof parsed.update !== "string"
    )
      return null;
    return parsed as StoredDraft;
  } catch {
    return null;
  }
}

function entries(store: DraftStore) {
  const values: { key: string; value: StoredDraft }[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(WORKSPACE_DRAFT_PREFIX)) continue;
    const value = parse(store.getItem(key));
    if (value) values.push({ key, value });
  }
  return values;
}

export function cleanupWorkspaceDrafts(
  now = Date.now(),
  store?: DraftStore,
) {
  const storage = storeOrDefault(store);
  if (!storage) return;
  // Snapshot keys before deletion: Storage.key() indices shift after removeItem.
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(WORKSPACE_DRAFT_PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    const value = parse(storage.getItem(key));
    if (!value || value.expiresAt <= now) storage.removeItem(key);
  }
}

export function loadWorkspaceDraft(
  identity: WorkspaceDraftIdentity,
  now = Date.now(),
  store?: DraftStore,
): WorkspaceDraft | null {
  const storage = storeOrDefault(store);
  if (!storage) return null;
  const key = identityKey(identity);
  const value = parse(storage.getItem(key));
  if (!value) {
    storage.removeItem(key);
    return null;
  }
  if (
    value.principal !== identity.principal ||
    value.room !== identity.room ||
    value.expiresAt <= now
  ) {
    storage.removeItem(key);
    return null;
  }
  try {
    const update = base64ToBytes(value.update);
    if (update.byteLength > WORKSPACE_DRAFT_MAX_BYTES) {
      storage.removeItem(key);
      return null;
    }
    return { updatedAt: value.updatedAt, update };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function saveWorkspaceDraft(
  identity: WorkspaceDraftIdentity,
  update: Uint8Array,
  now = Date.now(),
  store?: DraftStore,
): DraftSaveResult {
  if (update.byteLength > WORKSPACE_DRAFT_MAX_BYTES)
    return { ok: false, reason: "too-large" };
  const storage = storeOrDefault(store);
  if (!storage) return { ok: false, reason: "storage-unavailable" };

  try {
    cleanupWorkspaceDrafts(now, storage);
    const key = identityKey(identity);
    const existing = parse(storage.getItem(key));
    const others = entries(storage)
      .filter((entry) => entry.key !== key)
      .sort((a, b) => a.value.updatedAt - b.value.updatedAt);
    while (others.length >= WORKSPACE_DRAFT_MAX_COUNT) {
      const oldest = others.shift();
      if (oldest) storage.removeItem(oldest.key);
    }
    const record: StoredDraft = {
      version: 1,
      principal: identity.principal,
      room: identity.room,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + WORKSPACE_DRAFT_TTL_MS,
      update: bytesToBase64(update),
    };
    storage.setItem(key, JSON.stringify(record));
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage-unavailable" };
  }
}

export function clearWorkspaceDraft(
  identity: WorkspaceDraftIdentity,
  store?: DraftStore,
) {
  const storage = storeOrDefault(store);
  if (!storage) return;
  try {
    storage.removeItem(identityKey(identity));
  } catch {
    // Best effort. Callers must still enforce server-side authorization.
  }
}

export function clearPrincipalWorkspaceDrafts(
  principal: string,
  store?: DraftStore,
) {
  const storage = storeOrDefault(store);
  if (!storage) return;
  try {
    // Match the encoded principal in the storage key, not untrusted JSON.
    // This also removes malformed records for the signing-out principal only.
    const prefix = WORKSPACE_DRAFT_PREFIX + encodeURIComponent(principal) + ":";
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Logout must continue even if browser storage is unavailable.
  }
}
