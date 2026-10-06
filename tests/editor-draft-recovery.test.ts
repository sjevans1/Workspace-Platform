import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  clearDraft,
  draftUpdate,
  MAX_DRAFTS,
  MAX_DRAFT_BYTES,
  saveDraft,
  loadDraft,
  hasDraft,
  type DraftStorage,
} from "../apps/web/lib/drafts.ts";

class MemoryStorage implements DraftStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

function edit(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment("document");
  const block = new Y.XmlElement("paragraph");
  const content = new Y.XmlText();
  content.insert(0, text);
  block.insert(0, [content]);
  fragment.insert(fragment.length, [block]);
}

test("drafts: save and load round-trip device-local updates", () => {
  const store = new MemoryStorage();
  const doc = new Y.Doc();
  edit(doc, "offline note");
  const update = Y.encodeStateAsUpdate(doc);
  const saved = saveDraft("page-1", "user-1", update, store);
  assert.ok(saved);
  assert.equal(saved?.pageId, "page-1");
  assert.equal(saved?.userId, "user-1");
  const loaded = loadDraft("page-1", store);
  assert.ok(loaded);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, draftUpdate(loaded!));
  assert.equal(
    restored.getXmlFragment("document").toJSON(),
    doc.getXmlFragment("document").toJSON(),
  );
  assert.ok(hasDraft("page-1", store));
  clearDraft("page-1", store);
  assert.equal(loadDraft("page-1", store), undefined);
});

test("drafts: recovery never duplicates content the server already had", () => {
  const local = new Y.Doc();
  edit(local, "only on device");
  const update = Y.encodeStateAsUpdate(local);
  // A server that already persisted these updates converges to the same
  // document when the identical bytes are reapplied after sync.
  const server = new Y.Doc();
  Y.applyUpdate(server, update);
  Y.applyUpdate(server, update);
  assert.equal(
    server.getXmlFragment("document").toJSON(),
    local.getXmlFragment("document").toJSON(),
  );
});

test("drafts: empty updates are not stored and malformed drafts are dropped", () => {
  const store = new MemoryStorage();
  assert.equal(
    saveDraft("page-1", "user-1", new Uint8Array(), store),
    undefined,
  );
  store.setItem("workspace-draft-page-2", "{not json");
  assert.equal(loadDraft("page-2", store), undefined);
  assert.equal(store.getItem("workspace-draft-page-2"), null);
});

test("drafts: oversized updates are refused", () => {
  const store = new MemoryStorage();
  const big = new Uint8Array(MAX_DRAFT_BYTES + 1);
  assert.equal(saveDraft("page-1", "user-1", big, store), undefined);
  assert.equal(store.length, 0);
});

test("drafts: eviction keeps at most MAX_DRAFTS and drops the oldest", () => {
  const store = new MemoryStorage();
  for (let i = 0; i < MAX_DRAFTS + 3; i += 1) {
    saveDraft(`page-${i}`, "user-1", Y.encodeStateAsUpdate(new Y.Doc()), store);
  }
  const kept = new Set<string>();
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith("workspace-draft-")) kept.add(key);
  }
  assert.equal(kept.size, MAX_DRAFTS);
  // page-0 through page-2 are the three oldest and must be gone.
  for (const i of [0, 1, 2]) {
    assert.equal(loadDraft(`page-${i}`, store), undefined);
  }
  assert.ok(loadDraft(`page-${MAX_DRAFTS + 2}`, store));
});

test("drafts: a foreign-user draft is preserved but distinguishable", () => {
  const store = new MemoryStorage();
  const doc = new Y.Doc();
  edit(doc, "someone else");
  saveDraft("page-1", "user-other", Y.encodeStateAsUpdate(doc), store);
  const loaded = loadDraft("page-1", store);
  assert.ok(loaded);
  assert.notEqual(loaded!.userId, "user-1");
  // The editor must not auto-apply this draft; it stays until the user
  // discards it, and the device never uploads it anywhere.
  assert.ok(hasDraft("page-1", store));
});
