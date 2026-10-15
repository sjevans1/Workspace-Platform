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
      scopes: ["mail.read", "mail.send"],
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
  assert.match(error, /mailbox \(not stored by this deployment\)/);
  assert.match(error, /endpoint_host \(not stored by this deployment\)/);
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
  for (const value of [{ nested: true }, 42, true, null]) {
    const built = buildConnectionConfig({
      advanced_json: JSON.stringify({ label: value }),
      allowed_keys: ALLOWED,
    });
    assert.equal(built.ok, false, JSON.stringify(value));
    assert.match(built.ok === false ? built.error : "", /label/);
  }
});

test("A2 config: an oversized or malformed value is refused, never trimmed", () => {
  // A quietly truncated label or a silently dropped scope would tell the
  // administrator something was stored that was not.
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ label: "x".repeat(513) }, /label \(longer than 512 characters\)/],
    [
      { scopes: Array.from({ length: 33 }, (_value, index) => `scope-${index}`) },
      /scopes \(more than 32 entries\)/,
    ],
    [{ scopes: ["mail.read", 7, "mail.send"] }, /scopes \(entry 2 is not a string\)/],
    [{ label: { nested: true } }, /label \(must be a string or a list of strings\)/],
    [{ scopes: [{ a: 1 }] }, /scopes \(entry 1 is not a string\)/],
  ];
  for (const [config, pattern] of cases) {
    const built = buildConnectionConfig({
      advanced_json: JSON.stringify(config),
      allowed_keys: ALLOWED,
    });
    assert.equal(built.ok, false, JSON.stringify(config));
    assert.match(built.ok === false ? built.error : "", pattern);
  }

  // Exactly at the bounds is accepted, unchanged.
  const atBounds = buildConnectionConfig({
    advanced_json: JSON.stringify({
      label: "x".repeat(512),
      scopes: Array.from({ length: 32 }, (_value, index) => `scope-${index}`),
    }),
    allowed_keys: ALLOWED,
  });
  assert.equal(atBounds.ok, true);
  const stored = (atBounds.ok && atBounds.config) as Record<string, unknown>;
  assert.equal(String(stored.label).length, 512);
  assert.equal((stored.scopes as string[]).length, 32);
  assert.equal((stored.scopes as string[])[31], "scope-31");
});
