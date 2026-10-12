#!/usr/bin/env node
// W27 (#112): one authoritative source for the release-image inventory.
//
// The release gate must scan cryptographically the same images the supported release
// consumes. Rather than duplicating digests into the workflow, this script resolves four
// provenance classes and asserts they correspond to the runtime definitions:
//
//   1. CI-H1 mirror-provenanced images  (ci/ghcr-mirror-manifest.json)
//   2. immutable upstream Valkey        (pinned by digest in compose.yaml, not mirror-provenanced)
//   3. patched-upstream Caddy           (ci/w27-patched-images.json, shipped-runtime)
//   4. patched-upstream SeaweedFS       (ci/w27-patched-images.json, acceptance-only)
//
// Patched artifacts are rebuilds, never mirrors. Any drift, missing evidence, tag-only reference
// or consumer mismatch fails the step instead of silently scanning a different image.
//
// The resolver is exported so the aggregate security evaluator performs the SAME provenance
// validation the workflow performs, instead of trusting a recorded copy of it.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const IMMUTABLE = /^sha256:[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------------------------
// Patched-upstream provenance (class 3 and 4). These records are the authoritative source for the
// two patched digests: the workflow does not re-declare them.
// ---------------------------------------------------------------------------------------------
const EXPECTED_PATCHED = {
  caddy: {
    classification: "patched-upstream",
    intendedUse: "shipped-runtime",
    upstreamRepository: "caddyserver/caddy",
    upstreamTag: "v2.11.7",
    upstreamCommit: "72dd0fb067f6d7826c7f79907670ba4a713bfe37",
    binarySha256: "90e5f85f9a206ea63bdc146d75c54e0ec5c8ca4d245605f0c1570706ed4a38e5",
    builderDigest: "golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c",
    deltaFrom: "v0.59.0",
    runtimeContract: (record) => typeof record.runtimeBaseReference === "string" && record.runtimeBaseReference.includes("@sha256:"),
  },
  seaweedfs: {
    classification: "patched-upstream",
    intendedUse: "acceptance-only",
    upstreamRepository: "seaweedfs/seaweedfs",
    upstreamTag: "4.48",
    upstreamCommit: "530be3e37337488ecc34d58441e0bc476e121c93",
    binarySha256: "ff8d09e4a8c921f35a7a65b988c541d74f0b01725197ddb7fdf5728f2be37cb2",
    builderDigest: "golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c",
    deltaFrom: "v0.58.0",
    runtimeContract: (record) =>
      record.runtimeBaseDigest === "sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d" &&
      record.inheritedRuntimeArtifacts?.weedVolume?.sha256 === "8b271bc326f593c1b3b7f5d90091b0ef789c89023c34dec908c919f8614384d1" &&
      record.inheritedRuntimeArtifacts?.weedWorker?.sha256 === "9f10828f88b4ca4e1b770af68bbe5c9a38ca06623b187cfe6fd08238e9677fca",
  },
};

export const PATCHED_EXPECTATIONS = EXPECTED_PATCHED;

// Images deliberately consumed outside the Docker Hub CI-H1 mirror set. They must still be
// digest-pinned, but their identity is owned by the runtime definition rather than the
// inventory, and they are never described as mirror-provenanced.
const NON_MIRROR_NAMESPACES = ["ghcr.io/valkey-io/valkey"];

/**
 * Resolve the six qualification images and validate every provenance class they belong to.
 *
 * @param {string} root repository root
 * @returns {{resolved: Record<string,string>, identities: Record<string,{reference:string,digest:string|null,kind:string,provenance:string}>, failures: string[]}}
 */
export function resolveReleaseImages(root) {
  const manifestPath = path.join(root, "ci/ghcr-mirror-manifest.json");
  const patchedPath = path.join(root, "ci/w27-patched-images.json");
  const composePath = path.join(root, "compose.yaml");
  const ciPath = path.join(root, ".github/workflows/ci.yml");

  const failures = [];
  const readText = (file, label) => {
    if (!existsSync(file)) {
      failures.push(`missing ${label} (${path.relative(root, file) || file})`);
      return "";
    }
    return readFileSync(file, "utf8");
  };

  let manifest = { images: [] };
  const manifestText = readText(manifestPath, "CI-H1 mirror manifest");
  if (manifestText) {
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      failures.push("malformed CI-H1 mirror manifest");
    }
  }
  if (!Array.isArray(manifest.images)) {
    failures.push("CI-H1 mirror manifest has no image records");
    manifest = { images: [] };
  }

  const compose = readText(composePath, "compose.yaml");
  const ci = readText(ciPath, "the verification workflow");
  const byName = new Map((manifest.images ?? []).map((image) => [image.name, image]));

  const manifestReference = (name) => {
    const image = byName.get(name);
    if (!image) {
      failures.push(`inventory has no entry for ${name}`);
      return "";
    }
    return `${image.mirror}@${image.mirrorDigest}`;
  };

  let patched = null;
  const patchedText = readText(patchedPath, "patched image provenance (ci/w27-patched-images.json)");
  if (patchedText) {
    try {
      patched = JSON.parse(patchedText);
    } catch {
      failures.push("malformed patched image provenance (ci/w27-patched-images.json)");
    }
  }
  if (patched && patched.schemaVersion !== "1.0.0") failures.push(`unsupported patched provenance schema ${patched.schemaVersion}`);

  const patchedRecord = (logicalName) => {
    if (!patched) return null;
    const record = patched.images?.find((image) => image.logicalName === logicalName);
    const expected = EXPECTED_PATCHED[logicalName];
    if (!record) {
      failures.push(`patched provenance has no record for ${logicalName}`);
      return null;
    }
    if (record.classification !== expected.classification) failures.push(`${logicalName}: classification is not ${expected.classification}`);
    if (record.intendedUse !== expected.intendedUse) failures.push(`${logicalName}: intendedUse is not ${expected.intendedUse}`);
    if (record.upstreamRepository !== expected.upstreamRepository) failures.push(`${logicalName}: upstream repository drift`);
    if (record.upstreamTag !== expected.upstreamTag) failures.push(`${logicalName}: upstream tag drift (${record.upstreamTag})`);
    if (record.upstreamCommit !== expected.upstreamCommit) failures.push(`${logicalName}: upstream commit drift (${record.upstreamCommit})`);
    if (record.binarySha256 !== expected.binarySha256) failures.push(`${logicalName}: binary SHA drift`);
    if (record.builderDigest !== expected.builderDigest) failures.push(`${logicalName}: builder is not the approved digest-pinned builder`);
    if (!expected.runtimeContract(record)) failures.push(`${logicalName}: runtime base or inherited artifact identity drift`);
    if (record.mirrorProvenance !== false) failures.push(`${logicalName}: patched artifact is marked as mirror-provenanced`);
    if (record.vex !== null) failures.push(`${logicalName}: unexpected VEX on a patched artifact`);
    const deltas = Object.entries(record.approvedModuleDelta ?? {});
    if (deltas.length !== 1) {
      failures.push(`${logicalName}: approved module delta drift (declares ${deltas.map(([module]) => module).join(", ") || "no modules"}; exactly golang.org/x/net may change)`);
    }
    const delta = record.approvedModuleDelta?.["golang.org/x/net"];
    if (!Array.isArray(delta) || delta.length !== 2 || delta[0] !== expected.deltaFrom || delta[1] !== "v0.60.0") {
      failures.push(`${logicalName}: approved module delta drift (${JSON.stringify(delta)})`);
    }
    if (!IMMUTABLE.test(record.finalImageDigest ?? "")) {
      failures.push(`${logicalName}: final reference is not an immutable digest (tag-only or missing)`);
      return null;
    }
    return record;
  };

  const patchedReference = (logicalName) => {
    const record = patchedRecord(logicalName);
    return record ? `${record.ghcrPackage}@${record.finalImageDigest}` : "";
  };

  const caddyRef = patchedReference("caddy");
  const seaweedRef = patchedReference("seaweedfs");

  // Every digest-pinned reference the Compose stack consumes is checked against the authoritative
  // sources, so a runtime bump that skips them is caught here.
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
    if (caddyRef && reference === caddyRef) continue; // patched-upstream shipped runtime
    failures.push(`compose consumes ${reference.slice(0, 60)}… which is neither in the inventory, a known non-mirror image, nor the qualified patched Caddy`);
  }

  // Compose must consume exactly the qualified patched Caddy, not a stale mirror or a tag.
  if (caddyRef && !compose.includes(caddyRef)) {
    failures.push("compose does not consume the qualified patched Caddy digest");
  }

  // Valkey is deliberately not part of the Docker Hub CI-H1 mirror set, so its immutable
  // identity comes from the supported runtime definition itself and must be digest-pinned
  // there. A tag-only reference is refused: tag names are not immutable identity.
  const allImageLines = compose.match(/^\s*image:\s*(\S+)\s*$/gm)?.map((line) => line.replace(/^\s*image:\s*/, "")) ?? [];
  const valkeyReference = allImageLines.find((reference) => /valkey/i.test(reference)) ?? "";
  if (!/^ghcr\.io\/valkey-io\/valkey@sha256:[a-f0-9]{64}$/.test(valkeyReference)) {
    failures.push("compose must pin Valkey to an immutable digest, not a tag");
  }

  // The CI SeaweedFS acceptance service must consume exactly the qualified patched artifact.
  if (seaweedRef) {
    if (!ci.includes(seaweedRef)) {
      failures.push("CI SeaweedFS acceptance service does not consume the qualified patched SeaweedFS digest");
    }
    if (/workspace-ci-mirror-seaweedfs@sha256:[a-f0-9]{64}/.test(ci)) {
      failures.push("CI still consumes the SeaweedFS mirror where the patched acceptance artifact is required");
    }
  }

  // A digest fragment in the artifact name gives each artifact immutable identity; tag or
  // version names alone would not.
  const slug = (name, reference) => `${name}-${reference.slice(reference.indexOf("@sha256:") + 8, reference.indexOf("@sha256:") + 20)}`;

  const resolved = {
    W27_WORKSPACE_REF: "openjm-workspace:local",
    W27_CLAMAV_REF: "openjm-workspace-clamav:local",
    W27_POSTGRES_REF: manifestReference("postgres"),
    W27_CADDY_REF: caddyRef,
    W27_VALKEY_REF: valkeyReference,
    W27_SEAWEEDFS_REF: seaweedRef,
  };
  resolved.W27_POSTGRES_SLUG = resolved.W27_POSTGRES_REF ? slug("postgres", resolved.W27_POSTGRES_REF) : "";
  resolved.W27_CADDY_SLUG = resolved.W27_CADDY_REF ? slug("caddy", resolved.W27_CADDY_REF) : "";
  resolved.W27_VALKEY_SLUG = resolved.W27_VALKEY_REF ? slug("valkey", resolved.W27_VALKEY_REF) : "";
  resolved.W27_SEAWEEDFS_SLUG = resolved.W27_SEAWEEDFS_REF ? slug("seaweedfs", resolved.W27_SEAWEEDFS_REF) : "";

  const digestOf = (reference) => (reference.includes("@sha256:") ? reference.slice(reference.indexOf("@sha256:") + 1) : null);
  const identities = {
    workspace: { reference: resolved.W27_WORKSPACE_REF, digest: null, kind: "local-build", provenance: "built-local" },
    clamav: { reference: resolved.W27_CLAMAV_REF, digest: null, kind: "local-build", provenance: "built-local" },
    postgres: { reference: resolved.W27_POSTGRES_REF, digest: digestOf(resolved.W27_POSTGRES_REF), kind: "registry-digest", provenance: "mirror" },
    caddy: { reference: resolved.W27_CADDY_REF, digest: digestOf(resolved.W27_CADDY_REF), kind: "registry-digest", provenance: "patched-upstream" },
    valkey: { reference: resolved.W27_VALKEY_REF, digest: digestOf(resolved.W27_VALKEY_REF), kind: "registry-digest", provenance: "immutable-non-mirror" },
    seaweedfs: { reference: resolved.W27_SEAWEEDFS_REF, digest: digestOf(resolved.W27_SEAWEEDFS_REF), kind: "registry-digest", provenance: "patched-upstream" },
  };

  return { resolved, identities, failures };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { resolved, failures } = resolveReleaseImages(root);

  if (failures.length) {
    console.error("W27 image inventory is not single-source, immutable, or free of drift:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  for (const [key, value] of Object.entries(resolved)) {
    if (!value) {
      console.error(`could not resolve ${key}`);
      process.exit(1);
    }
    console.log(`${key}=${value}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
