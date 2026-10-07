import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_DRAFT_MAX_BYTES,
  WORKSPACE_DRAFT_MAX_COUNT,
  WORKSPACE_DRAFT_TTL_MS,
  clearPrincipalWorkspaceDrafts,
  clearWorkspaceDraft,
  loadWorkspaceDraft,
  saveWorkspaceDraft,
  type WorkspaceDraftIdentity,
} from "../apps/web/lib/recovery-drafts.ts";

class MemoryStore {
  #values = new Map<string, string>();
  get length() { return this.#values.size; }
  key(index: number) { return [...this.#values.keys()][index] ?? null; }
  getItem(key: string) { return this.#values.get(key) ?? null; }
  setItem(key: string, value: string) { this.#values.set(key, value); }
  removeItem(key: string) { this.#values.delete(key); }
}

const identity = (principal = "user-a", room = "tenant/page/epoch"): WorkspaceDraftIdentity => ({
  principal,
  room,
});

test("W18 recovery store round-trips exact principal/room only", () => {
  const store = new MemoryStore();
  const update = Uint8Array.from([1, 2, 3, 254]);
  assert.deepEqual(saveWorkspaceDraft(identity(), update, 1000, store), { ok: true });
  assert.deepEqual(loadWorkspaceDraft(identity(), 1001, store)?.update, update);
  assert.equal(loadWorkspaceDraft(identity("user-b"), 1001, store), null);
  assert.equal(loadWorkspaceDraft(identity("user-a", "tenant/page/new-epoch"), 1001, store), null);
});

test("W18 recovery store expires and removes stale drafts", () => {
  const store = new MemoryStore();
  assert.equal(saveWorkspaceDraft(identity(), Uint8Array.of(7), 1000, store).ok, true);
  assert.equal(
    loadWorkspaceDraft(identity(), 1000 + WORKSPACE_DRAFT_TTL_MS + 1, store),
    null,
  );
  assert.equal(store.length, 0);
});

test("W18 recovery store bounds draft bytes and total retained records", () => {
  const store = new MemoryStore();
  assert.deepEqual(
    saveWorkspaceDraft(
      identity(),
      new Uint8Array(WORKSPACE_DRAFT_MAX_BYTES + 1),
      1000,
      store,
    ),
    { ok: false, reason: "too-large" },
  );
  for (let i = 0; i < WORKSPACE_DRAFT_MAX_COUNT + 3; i++) {
    assert.equal(
      saveWorkspaceDraft(
        identity("user-a", "tenant/page/epoch-" + i),
        Uint8Array.of(i),
        2000 + i,
        store,
      ).ok,
      true,
    );
  }
  assert.equal(store.length, WORKSPACE_DRAFT_MAX_COUNT);
  assert.equal(loadWorkspaceDraft(identity("user-a", "tenant/page/epoch-0"), 3000, store), null);
  assert.ok(loadWorkspaceDraft(identity("user-a", "tenant/page/epoch-10"), 3000, store));
});

test("W18 recovery store clears exact and principal-scoped drafts", () => {
  const store = new MemoryStore();
  saveWorkspaceDraft(identity("user-a", "tenant/a/epoch"), Uint8Array.of(1), 1000, store);
  saveWorkspaceDraft(identity("user-a", "tenant/b/epoch"), Uint8Array.of(2), 1001, store);
  saveWorkspaceDraft(identity("user-b", "tenant/a/epoch"), Uint8Array.of(3), 1002, store);

  clearWorkspaceDraft(identity("user-a", "tenant/a/epoch"), store);
  assert.equal(loadWorkspaceDraft(identity("user-a", "tenant/a/epoch"), 1003, store), null);
  assert.ok(loadWorkspaceDraft(identity("user-a", "tenant/b/epoch"), 1003, store));

  clearPrincipalWorkspaceDrafts("user-a", store);
  assert.equal(loadWorkspaceDraft(identity("user-a", "tenant/b/epoch"), 1004, store), null);
  assert.ok(loadWorkspaceDraft(identity("user-b", "tenant/a/epoch"), 1004, store));
});
