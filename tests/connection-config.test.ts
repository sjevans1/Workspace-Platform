// W29-P0/A2: the guided connection-configuration contract.
//
// The guided form must never discard what an administrator typed: a configuration
// key this deployment does not store is refused, with the offending key named,
// rather than accepted and dropped by persistence. The same builder runs in the web
// application and, authoritatively, in the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectionConfig,
  CREDENTIAL_METADATA_KEYS,
} from "../packages/connectors/index.ts";

const ALLOWED = [...CREDENTIAL_METADATA_KEYS];

test("A2 config: an empty guided form sends no configuration at all", () => {
  for (const advanced_json of ["", "   ", undefined, null]) {
    const built = buildConnectionConfig({ advanced_json, allowed_keys: ALLOWED });
    assert.equal(built.ok, true, String(advanced_json));
    assert.deepEqual(built.ok && built.config, {});
  }
});

test("A2 config: supported keys are bound, and shaped exactly as persistence stores them", () => {
  const built = buildConnectionConfig({
    advanced_json: JSON.stringify({
      label: "inbox",
      scopes: ["mail.read", "mail.send", 7],
    }),
    allowed_keys: ALLOWED,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.ok && built.config, {
    label: "inbox",
    scopes: ["mail.read", "mail.send"],
  });
});

test("A2 config: an unsupported key is refused and named, never silently dropped", () => {
  const built = buildConnectionConfig({
    advanced_json: JSON.stringify({ mailbox: "inbox", endpoint_host: "mail.example.com" }),
    allowed_keys: ALLOWED,
  });
  assert.equal(built.ok, false);
  const error = built.ok === false ? built.error : "";
  assert.match(error, /mailbox/);
  assert.match(error, /endpoint_host/);
  assert.match(error, /Supported keys:/);
});

test("A2 config: malformed or non-object JSON is refused with a clear message", () => {
  for (const [json, pattern] of [
    ["{not json", /not valid JSON/],
    ["[1,2,3]", /JSON object/],
    ['"a string"', /JSON object/],
    ["42", /JSON object/],
    ["null", /JSON object/],
  ] as const) {
    const built = buildConnectionConfig({ advanced_json: json, allowed_keys: ALLOWED });
    assert.equal(built.ok, false, json);
    assert.match(built.ok === false ? built.error : "", pattern);
  }
});

test("A2 config: a non-string, non-list value for a supported key is refused", () => {
  const built = buildConnectionConfig({
    advanced_json: JSON.stringify({ label: { nested: true } }),
    allowed_keys: ALLOWED,
  });
  assert.equal(built.ok, false);
  assert.match(built.ok === false ? built.error : "", /label/);
});

test("A2 config: values are bounded exactly as the persistence layer bounds them", () => {
  const built = buildConnectionConfig({
    advanced_json: JSON.stringify({
      label: "x".repeat(900),
      scopes: Array.from({ length: 40 }, (_value, index) => `scope-${index}`),
    }),
    allowed_keys: ALLOWED,
  });
  assert.equal(built.ok, true);
  const config = (built.ok && built.config) as Record<string, unknown>;
  assert.equal(String(config.label).length, 512);
  assert.equal((config.scopes as string[]).length, 32);
});
