// CI-H1: mirror and digest-pin upstream Docker Hub images into GHCR.
//
// Modes:
//   --verify  (default) resolve upstream digests, compare against the manifest
//             and report drift. Never promotes. Used by the weekly schedule.
//   --mirror  copy the approved upstream image into the GHCR mirror, then
//             record the mirror digest. Requires GHCR credentials.
//
// The upstream registry stays the source of truth. A new upstream digest is
// never promoted automatically: it requires a reviewed update to
// ci/ghcr-mirror-manifest.json plus full acceptance.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST = "ci/ghcr-mirror-manifest.json";
const args = process.argv.slice(2);
const mode = args.includes("--mirror") ? "mirror" : "verify";
const reportPath = (() => {
  const i = args.indexOf("--report");
  return i >= 0 ? args[i + 1] : null;
})();

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const owner = process.env.GHCR_OWNER || manifest.owner;

function token(repo) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  return JSON.parse(execFileSync("curl", ["-sS", url]).toString()).token;
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

function remoteDigest(reference) {
  // Works for both Docker Hub (with token) and GHCR (with docker login creds).
  if (reference.startsWith("docker.io/")) {
    const [repo, tag] = reference.replace("docker.io/", "").split(":");
    const out = execFileSync("curl", [
      "-sSI",
      "-H",
      `Accept: ${ACCEPT}`,
      "-H",
      `Authorization: Bearer ${token(repo)}`,
      `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`,
    ]).toString();
    const match = out.match(/docker-content-digest:\s*(\S+)/i);
    if (!match) throw new Error(`no digest for ${reference}`);
    return match[1].trim();
  }
  const out = execFileSync("skopeo", [
    "inspect",
    "--raw",
    `docker://${reference}`,
  ]).toString();
  return "sha256:" + createHash("sha256").update(out).digest("hex");
}

const results = [];
let drift = false;

for (const image of manifest.images) {
  const upstreamRef = `${image.upstream}:${image.sourceTag}`;
  const resolvedUpstream = remoteDigest(upstreamRef);
  const entry = {
    name: image.name,
    upstream: upstreamRef,
    upstreamDigestResolved: resolvedUpstream,
    upstreamDigestPinned: image.upstreamDigest,
    mirror: image.mirror,
    mirrorDigestPinned: image.mirrorDigest,
  };

  if (resolvedUpstream !== image.upstreamDigest) {
    entry.status = "UPSTREAM_DRIFT";
    drift = true;
  }

  if (mode === "mirror") {
    const tagged = `${image.mirror}:${image.mirrorTag}`;
    // Registry-to-registry copy; --all preserves every architecture of the
    // upstream index. Skopeo copies manifest bytes verbatim, so the mirror
    // digest equals the upstream digest.
    execFileSync(
      "skopeo",
      ["copy", "--all", `docker://${upstreamRef}`, `docker://${tagged}`],
      { stdio: "inherit" },
    );
    const mirrorDigest = remoteDigest(tagged);
    entry.mirrorDigestResolved = mirrorDigest;
    entry.mirrorMatchesUpstream = mirrorDigest === resolvedUpstream;
    image.mirrorDigest = mirrorDigest;
    if (!entry.mirrorMatchesUpstream) drift = true;
  } else if (image.mirrorDigest) {
    const mirrorDigest = remoteDigest(`${image.mirror}@${image.mirrorDigest}`);
    entry.mirrorDigestResolved = mirrorDigest;
    entry.mirrorMatchesUpstream = mirrorDigest === resolvedUpstream;
  } else {
    entry.status = "NOT_YET_MIRRORED";
  }

  results.push(entry);
}

if (mode === "mirror") {
  manifest.refreshDate = new Date().toISOString().slice(0, 10);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

const report = { mode, owner, generatedAt: new Date().toISOString(), results };
console.log(JSON.stringify(report, null, 2));
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (drift) {
  console.error(
    "\nCI-H1: upstream drift or mirror mismatch detected. This is a reviewed dependency update, not an automatic promotion.",
  );
  process.exit(1);
}
console.log(`\nCI-H1 ${mode} completed without drift.`);
