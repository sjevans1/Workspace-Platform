import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQuickTunnelUrl,
  supervisedExitCode,
  WRANGLER_PACKAGE,
} from "../bin/run-quick-tunnel.mjs";

test("quick tunnel runner extracts only HTTPS trycloudflare URLs", () => {
  assert.equal(
    parseQuickTunnelUrl("INF | https://safe-bridge.trycloudflare.com |"),
    "https://safe-bridge.trycloudflare.com",
  );
  assert.equal(parseQuickTunnelUrl("https://example.com"), null);
  assert.equal(parseQuickTunnelUrl("http://unsafe.trycloudflare.com"), null);
});

test("quick tunnel runner pins Wrangler and fails unrequested clean exits", () => {
  assert.equal(WRANGLER_PACKAGE, "wrangler@4.147.0");
  assert.equal(supervisedExitCode({ requested: false, code: 0 }), 1);
  assert.equal(supervisedExitCode({ requested: false, code: 7 }), 7);
  assert.equal(supervisedExitCode({ requested: true, code: 0 }), 0);
  assert.equal(supervisedExitCode({ requested: true, code: 7 }), 0);
});
