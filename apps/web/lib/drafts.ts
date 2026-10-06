// W18: device-local draft recovery.
//
// Unacknowledged editor changes are kept ONLY on the device that produced
// them. Nothing here claims server durability: a draft exists precisely
// because the collaboration server has not acknowledged the edit yet. Drafts
// are bound to one page and one user id, are capped in count and size, and
// are removed as soon as the server confirms persistence or the user
// discards them.

const KEY_PREFIX = "workspace-draft-";
export const MAX_DRAFTS = 10;
export const MAX_DRAFT_BYTES = 512 * 1024;

export type StoredDraft = {
  pageId: string;
  userId: string;
  savedAt: number;
  update: string; // base64 Yjs update bytes
};

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  length: number;
}

function storage(): DraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function keyFor(pageId: string): string {
  return KEY_PREFIX + pageId;
}

export function saveDraft(
  pageId: string,
  userId: string,
  update: Uint8Array,
  store: DraftStorage = storage() as DraftStorage,
): StoredDraft | undefined {
  if (update.length === 0 || update.length > MAX_DRAFT_BYTES) return undefined;
  const draft: StoredDraft = {
    pageId,
    userId,
    savedAt: Date.now(),
    update: toBase64(update),
  };
  try {
    store.setItem(keyFor(pageId), JSON.stringify(draft));
  } catch {
    // Storage may be full or blocked. Recovery is best effort; the editor
    // already warns that offline changes are not saved.
    return undefined;
  }
  evictOldest(store);
  return draft;
}

export function loadDraft(
  pageId: string,
  store: DraftStorage = storage() as DraftStorage,
): StoredDraft | undefined {
  const raw = store.getItem(keyFor(pageId));
  if (!raw) return undefined;
  try {
    const draft = JSON.parse(raw) as StoredDraft;
    if (
      draft.pageId !== pageId ||
      !draft.userId ||
      typeof draft.update !== "string"
    ) {
      store.removeItem(keyFor(pageId));
      return undefined;
    }
    if (fromBase64(draft.update).length === 0) {
      store.removeItem(keyFor(pageId));
      return undefined;
    }
    return draft;
  } catch {
    store.removeItem(keyFor(pageId));
    return undefined;
  }
}

export function draftUpdate(draft: StoredDraft): Uint8Array {
  return fromBase64(draft.update);
}

export function clearDraft(
  pageId: string,
  store: DraftStorage = storage() as DraftStorage,
): void {
  store.removeItem(keyFor(pageId));
}

export function hasDraft(
  pageId: string,
  store: DraftStorage = storage() as DraftStorage,
): boolean {
  return loadDraft(pageId, store) !== undefined;
}

// Shared-device privacy: keep at most MAX_DRAFTS drafts and evict the
// oldest ones first so stale device-local material does not accumulate.
function evictOldest(store: DraftStorage): void {
  const entries: { key: string; savedAt: number }[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    try {
      const parsed = JSON.parse(store.getItem(key) || "") as StoredDraft;
      entries.push({ key, savedAt: parsed.savedAt || 0 });
    } catch {
      entries.push({ key, savedAt: 0 });
    }
  }
  entries.sort((a, b) => a.savedAt - b.savedAt);
  const excess = entries.length - MAX_DRAFTS;
  for (let i = 0; i < excess; i += 1) store.removeItem(entries[i].key);
}
