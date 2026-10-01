import test from "node:test";
import assert from "node:assert/strict";
import { normalizedNetworkIdentity } from "../packages/security/rate-network.ts";

test("network rate identity retains IPv4 and masks IPv6 interface churn", () => {
  assert.equal(normalizedNetworkIdentity("198.51.100.20"), "198.51.100.20");
  assert.equal(normalizedNetworkIdentity("::ffff:198.51.100.20"), "198.51.100.20");
  assert.equal(normalizedNetworkIdentity("::ffff:c633:6414"), "198.51.100.20");
  assert.equal(normalizedNetworkIdentity("2001:db8:aaaa:bbbb::1"),
    normalizedNetworkIdentity("2001:0db8:aaaa:bbbb:abcd::ffff"));
  assert.notEqual(normalizedNetworkIdentity("2001:db8:aaaa:bbbb::1"),
    normalizedNetworkIdentity("2001:db8:aaaa:bbbc::1"));
  assert.equal(normalizedNetworkIdentity("::1"), "0000:0000:0000:0000/64");
});
