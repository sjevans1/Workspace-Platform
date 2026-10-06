import test from "node:test";
import assert from "node:assert/strict";
import { parseQuickTunnelUrl } from "../bin/run-quick-tunnel.mjs";

test("quick tunnel runner extracts only HTTPS trycloudflare URLs", () => {
  assert.equal(
    parseQuickTunnelUrl("INF | https://safe-bridge.trycloudflare.com |"),
    "https://safe-bridge.trycloudflare.com",
  );
  assert.equal(parseQuickTunnelUrl("https://example.com"), null);
  assert.equal(parseQuickTunnelUrl("http://unsafe.trycloudflare.com"), null);
});
