#!/usr/bin/env node
// W27 (#112): one authoritative source for the release-image inventory.
//
// The release gate must scan cryptographically the same images the supported release
// consumes. Rather than duplicating digests into the workflow, this script reads the
// accepted CI-H1 inventory (ci/ghcr-mirror-manifest.json) and the supported runtime
// definition (compose.yaml), asserts they correspond, and emits the exact scan references
// for the workflow to consume. Any drift fails the step instead of silently scanning a
// different image than the one that ships.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "ci/ghcr-mirror-manifest.json");
const composePath = path.join(root, "compose.yaml");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const compose = readFileSync(composePath, "utf8");
const byName = new Map(manifest.images.map((image) => [image.name, image]));

const failures = [];
const manifestReference = (name) => {
  const image = byName.get(name);
  if (!image) {
    failures.push(`inventory has no entry for ${name}`);
    return "";
  }
  return `${image.mirror}@${image.mirrorDigest}`;
};

// Images deliberately consumed outside the Docker Hub CI-H1 mirror set. They must still be
// digest-pinned, but their identity is owned by the runtime definition rather than the
// inventory, and they are never described as mirror-provenanced.
const NON_MIRROR_NAMESPACES = ["ghcr.io/valkey-io/valkey"];

// Every digest-pinned reference the Compose stack consumes is checked against the
// authoritative inventory, so a runtime bump that skips the inventory is caught here, and a
// non-mirror image is checked for immutability rather than for provenance.
const composePinned = [...compose.matchAll(/^\s*image:\s*(\S+@sha256:[a-f0-9]{64})\s*$/gm)].map((match) => match[1]);
for (const reference of composePinned) {
  const digest = reference.slice(reference.indexOf("@") + 1);
  const base = reference.slice(0, reference.indexOf("@"));
  const owned = manifest.images.find((image) => image.mirrorDigest === digest);
  if (owned) {
    if (reference !== `${owned.mirror}@${owned.mirrorDigest}`) {
      failures.push(`compose reference for ${owned.name} does not match the inventory mirror`);
    }
    continue;
  }
  if (NON_MIRROR_NAMESPACES.includes(base)) continue; // immutable, intentionally not mirror-provenanced
  failures.push(`compose consumes ${reference.slice(0, 60)}… which is neither in the inventory nor a known non-mirror image`);
}

// Valkey is deliberately not part of the Docker Hub CI-H1 mirror set, so its immutable
// identity comes from the supported runtime definition itself and must be digest-pinned
// there. A tag-only reference is refused: tag names are not immutable identity.
const valkeyMatch = compose.match(/^\s*image:\s*(\S+)\s*$/gm)?.map((line) => line.replace(/^\s*image:\s*/, "")) ?? [];
const valkeyReference = valkeyMatch.find((reference) => /valkey/i.test(reference)) ?? "";
if (!/^ghcr\.io\/valkey-io\/valkey@sha256:[a-f0-9]{64}$/.test(valkeyReference)) {
  failures.push("compose must pin Valkey to an immutable digest, not a tag");
}

if (failures.length) {
  console.error("W27 image inventory is not single-source or not immutable:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

// A digest fragment in the artifact name gives each artifact immutable identity; tag or
// version names alone would not.
const slug = (name, reference) => `${name}-${reference.slice(reference.indexOf("@sha256:") + 8, reference.indexOf("@sha256:") + 20)}`;

const resolved = {
  W27_WORKSPACE_REF: "openjm-workspace:local",
  W27_CLAMAV_REF: "openjm-workspace-clamav:local",
  W27_POSTGRES_REF: manifestReference("postgres"),
  W27_CADDY_REF: manifestReference("caddy"),
  W27_SEAWEEDFS_REF: manifestReference("seaweedfs"),
  W27_VALKEY_REF: valkeyReference,
};
resolved.W27_POSTGRES_SLUG = slug("postgres", resolved.W27_POSTGRES_REF);
resolved.W27_CADDY_SLUG = slug("caddy", resolved.W27_CADDY_REF);
resolved.W27_SEAWEEDFS_SLUG = slug("seaweedfs", resolved.W27_SEAWEEDFS_REF);
resolved.W27_VALKEY_SLUG = slug("valkey", resolved.W27_VALKEY_REF);

for (const [key, value] of Object.entries(resolved)) {
  if (!value) {
    console.error(`could not resolve ${key}`);
    process.exit(1);
  }
  console.log(`${key}=${value}`);
}
