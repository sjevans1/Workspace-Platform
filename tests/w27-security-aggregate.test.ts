// W27: the agreed regression suite for the six-image aggregate security gate.
//
// Every case runs the REAL aggregate evaluator CLI (scripts/w27-security-aggregate.mjs) against a
// synthetic evidence tree placed beside the repository's real provenance inputs, so a case that
// passes here is real gate behaviour rather than a stub of it. Case 18 proves the fully valid
// six-image evidence passes; cases 1-17 each break exactly one thing and prove the gate fails and
// fails for the stated reason.
//
// The evaluator is phase 2 of the gate. Phase 1 (evidence collection) is never allowed to decide
// or to abort, so the gate's blocking power lives entirely in the component exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evaluator = join(repoRoot, "scripts/w27-security-aggregate.mjs");
const IMAGES = ["workspace", "clamav", "postgres", "caddy", "valkey", "seaweedfs"] as const;

const PROVENANCE_CLASS: Record<string, string> = {
  workspace: "built-local",
  clamav: "built-local",
  postgres: "mirror",
  caddy: "patched-upstream",
  valkey: "immutable-non-mirror",
  seaweedfs: "patched-upstream",
};

const REACHABILITY_BINARY: Record<string, string> = {
  postgres: "/usr/local/bin/gosu",
  caddy: "/usr/bin/caddy",
  seaweedfs: "/usr/bin/weed",
};

const LOCAL_IMAGE_ID = "sha256:" + "b".repeat(64);

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

interface Fixture {
  root: string;
  evidence: string;
  identity: Record<string, { reference: string; digest: string | null; kind: string }>;
  patched: any;
  vex: any;
}

let resolverModule: any;

async function resolver() {
  if (!resolverModule) resolverModule = await import(pathToFileURL(join(repoRoot, "scripts/w27-image-inventory.mjs")).href);
  return resolverModule;
}

function buildEvidence(evidence: string, identity: Record<string, any>, patched: any, vex: any) {
  const findPatched = (name: string) => patched.images.find((image: any) => image.logicalName === name);
  for (const name of IMAGES) {
    const dir = join(evidence, name);
    mkdirSync(dir, { recursive: true });
    const authoritative = identity[name];
    writeJson(join(dir, "identity.json"), {
      schemaVersion: "1.0.0",
      logicalName: name,
      reference: authoritative.reference,
      kind: authoritative.kind,
      provenanceClass: PROVENANCE_CLASS[name],
      resolvedImageId: authoritative.digest ?? LOCAL_IMAGE_ID,
      architecture: "amd64",
      os: "linux",
      repoDigests: authoritative.digest ? [authoritative.reference] : [],
    });
    writeJson(join(dir, "sbom.cdx.json"), {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      components: [{ type: "library", name: `fixture-${name}`, version: "1.0.0" }],
    });
    writeJson(join(dir, "trivy-raw.json"), { SchemaVersion: 2, Results: [] });
    writeFileSync(join(dir, "trivy-all-findings.txt"), `fixture all-findings report for ${name}\n`);
    writeJson(join(dir, "trivy-fixable.json"), { SchemaVersion: 2, Results: [] });
    writeFileSync(join(dir, "collection-errors.txt"), "");
  }

  // PostgreSQL: the blocking-policy scan reports exactly the gosu-adjudicated set, and the VEX
  // disposition is the committed one.
  writeJson(join(evidence, "postgres", "trivy-fixable.json"), {
    SchemaVersion: 2,
    Results: [
      {
        Target: "usr/local/bin/gosu",
        Class: "lang-pkgs",
        Type: "gobinary",
        Vulnerabilities: vex.statements[0].products[0].trivy_finding_ids.map((id: string, index: number) => ({
          VulnerabilityID: id,
          PkgName: "stdlib",
          InstalledVersion: "go1.24.0",
          FixedVersion: index === 0 ? "go1.25.5" : "go1.24.8",
          Severity: index === 0 ? "CRITICAL" : "HIGH",
        })),
      },
    ],
  });
  writeJson(join(evidence, "postgres", "vex.json"), vex);

  // Reachability evidence for the images whose policy requires it.
  writeJson(join(evidence, "postgres", "reachability.json"), reachability("postgres", identity.postgres.reference, vex.statements[0].products[0].component.hashes["sha-256"], []));
  writeJson(
    join(evidence, "caddy", "reachability.json"),
    reachability("caddy", identity.caddy.reference, findPatched("caddy").binarySha256, [
      { id: "GO-2026-5932", aliases: [], severity: "UNKNOWN", called: false, level: "module", fixedVersion: null },
    ]),
  );
  writeJson(
    join(evidence, "seaweedfs", "reachability.json"),
    reachability("seaweedfs", identity.seaweedfs.reference, findPatched("seaweedfs").binarySha256, [
      { id: "GO-2022-0646", aliases: [], severity: "MEDIUM", called: true, level: "symbol", fixedVersion: null },
      { id: "GO-2022-0635", aliases: [], severity: "LOW", called: true, level: "symbol", fixedVersion: null },
      { id: "GO-2026-5932", aliases: [], severity: "UNKNOWN", called: true, level: "symbol", fixedVersion: null },
    ]),
  );
}

function reachability(name: string, reference: string, binarySha256: string | null, findings: any[]) {
  return {
    schemaVersion: "1.0.0",
    tool: "govulncheck",
    toolVersion: "v1.9.0",
    scanMode: "binary",
    scanLevel: "symbol",
    binaryPath: REACHABILITY_BINARY[name],
    binarySha256,
    imageReference: reference,
    adjudicatedBy: null,
    counts: { advisories: findings.length, called: findings.filter((finding) => finding.called).length, affected: findings.filter((finding) => !finding.called).length },
    findings,
  };
}

async function fixture(): Promise<Fixture> {
  const { resolveReleaseImages } = await resolver();
  const root = mkdtempSync(join(tmpdir(), "w27-aggregate-gate-"));
  mkdirSync(join(root, "ci"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  mkdirSync(join(root, "docs/security"), { recursive: true });
  for (const file of ["ci/ghcr-mirror-manifest.json", "ci/w27-patched-images.json", "ci/w27-security-policy.json", "compose.yaml", ".github/workflows/ci.yml", "docs/security/vex-gosu-postgres-17.11-bookworm.json"]) {
    cpSync(join(repoRoot, file), join(root, file));
  }
  const patched = readJson(join(root, "ci/w27-patched-images.json"));
  const vex = readJson(join(root, "docs/security/vex-gosu-postgres-17.11-bookworm.json"));
  const { identities, failures } = resolveReleaseImages(root);
  assert.deepEqual(failures, [], "the fixture must start from valid provenance");
  const evidence = join(root, "w27-evidence");
  mkdirSync(evidence, { recursive: true });
  buildEvidence(evidence, identities, patched, vex);
  writeJson(join(evidence, "resolver.json"), {
    command: "node scripts/w27-image-inventory.mjs",
    exitCode: 0,
    stdout: `${Object.entries((await resolver()).resolveReleaseImages(root).resolved)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    stderr: "",
  });
  writeFileSync(join(evidence, "trivy-version.txt"), "Version: 0.75.0\n");
  return { root, evidence, identity: identities, patched, vex };
}

function run(root: string, evidence: string) {
  const result = spawnSync(process.execPath, [evaluator, "--root", root, "--evidence", evidence], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function withFixture(runCase: (fixture: Fixture) => void | Promise<void>) {
  const created = await fixture();
  try {
    await runCase(created);
  } finally {
    rmSync(created.root, { recursive: true, force: true });
  }
}

function fails(name: string, keyword: string, mutate: (fixture: Fixture) => void) {
  test(`${name} -> FAIL`, async () => {
    await withFixture((created) => {
      mutate(created);
      const result = run(created.root, created.evidence);
      assert.equal(result.status, 1, `expected the aggregate gate to fail: ${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `the gate must fail for the stated reason (${keyword})`);
    });
  });
}

// --- 1-2: missing evidence ----------------------------------------------------------------
fails("1. missing image evidence record", "no collected evidence record", (created) => {
  rmSync(join(created.evidence, "caddy"), { recursive: true, force: true });
});

fails("2. missing SBOM", "sbom.cdx.json", (created) => {
  rmSync(join(created.evidence, "caddy", "sbom.cdx.json"), { force: true });
});

// --- 3-8: identity and provenance ----------------------------------------------------------
fails("3. digest mismatch", "does not match the authoritative digest", (created) => {
  const file = join(created.evidence, "caddy", "identity.json");
  const identity = readJson(file);
  identity.resolvedImageId = "sha256:" + "c".repeat(64);
  writeJson(file, identity);
});

fails("4. wrong patched source tag", "upstream tag drift", (created) => {
  const file = join(created.root, "ci/w27-patched-images.json");
  const patched = readJson(file);
  patched.images.find((image: any) => image.logicalName === "caddy").upstreamTag = "v2.11.4";
  writeJson(file, patched);
});

fails("5. wrong upstream commit", "upstream commit drift", (created) => {
  const file = join(created.root, "ci/w27-patched-images.json");
  const patched = readJson(file);
  patched.images.find((image: any) => image.logicalName === "seaweedfs").upstreamCommit = "0".repeat(40);
  writeJson(file, patched);
});

fails("6. mutable/unapproved builder", "builder is not the approved digest-pinned builder", (created) => {
  const file = join(created.root, "ci/w27-patched-images.json");
  const patched = readJson(file);
  patched.images.find((image: any) => image.logicalName === "caddy").builderDigest = "golang:latest";
  writeJson(file, patched);
});

fails("7. binary SHA mismatch", "instead of the qualified", (created) => {
  const file = join(created.evidence, "seaweedfs", "reachability.json");
  const record = readJson(file);
  record.binarySha256 = "d".repeat(64);
  writeJson(file, record);
});

fails("8. unexpected module delta", "approved module delta", (created) => {
  const file = join(created.root, "ci/w27-patched-images.json");
  const patched = readJson(file);
  patched.images.find((image: any) => image.logicalName === "caddy").approvedModuleDelta["golang.org/x/text"] = ["v0.42.0", "v0.43.0"];
  writeJson(file, patched);
});

// --- 9-10: blocking policy -----------------------------------------------------------------
fails("9. fixable HIGH/CRITICAL", "unadjudicated fixable HIGH/CRITICAL", (created) => {
  const file = join(created.evidence, "caddy", "trivy-fixable.json");
  const document = readJson(file);
  document.Results = [
    {
      Target: "usr/bin/caddy",
      Class: "lang-pkgs",
      Type: "gobinary",
      Vulnerabilities: [{ VulnerabilityID: "CVE-2026-00001", PkgName: "stdlib", InstalledVersion: "go1.26.9", FixedVersion: "go1.26.10", Severity: "HIGH" }],
    },
  ];
  writeJson(file, document);
});

fails("10. reachable HIGH/CRITICAL", "is called by the analysed binary", (created) => {
  const file = join(created.evidence, "seaweedfs", "reachability.json");
  const record = readJson(file);
  record.findings.push({ id: "GO-2026-9998", aliases: [], severity: "CRITICAL", called: true, level: "symbol", fixedVersion: null });
  writeJson(file, record);
});

// --- 11-14: VEX discipline -----------------------------------------------------------------
fails("11. invalid gosu binary identity", "VEX component binary identity", (created) => {
  for (const file of [join(created.root, "docs/security/vex-gosu-postgres-17.11-bookworm.json"), join(created.evidence, "postgres", "vex.json")]) {
    const vex = readJson(file);
    vex.statements[0].products[0].component.hashes["sha-256"] = "e".repeat(64);
    writeJson(file, vex);
  }
});

fails("12. invalid PostgreSQL parent digest", "VEX parent image digest", (created) => {
  for (const file of [join(created.root, "docs/security/vex-gosu-postgres-17.11-bookworm.json"), join(created.evidence, "postgres", "vex.json")]) {
    const vex = readJson(file);
    vex.statements[0].products[0].parent_image_digest = "sha256:" + "f".repeat(64);
    writeJson(file, vex);
  }
});

fails("13. Caddy cannot inherit gosu VEX", "must not inherit another image's VEX", (created) => {
  writeJson(join(created.evidence, "caddy", "vex.json"), readJson(join(created.root, "docs/security/vex-gosu-postgres-17.11-bookworm.json")));
});

fails("14. SeaweedFS cannot inherit gosu VEX", "inherits the postgres VEX disposition", (created) => {
  const file = join(created.evidence, "seaweedfs", "reachability.json");
  const record = readJson(file);
  record.adjudicatedBy = created.vex.statements[0].vulnerability.name;
  writeJson(file, record);
});

fails("15. patched artifact marked as mirror", "marked as mirror-provenanced", (created) => {
  const file = join(created.root, "ci/w27-patched-images.json");
  const patched = readJson(file);
  patched.images.find((image: any) => image.logicalName === "seaweedfs").mirrorProvenance = true;
  writeJson(file, patched);
});

fails("16. missing reachability evidence", "reachability.json", (created) => {
  rmSync(join(created.evidence, "seaweedfs", "reachability.json"), { force: true });
});

fails("17. arbitrary finding cannot inherit GO-2026-5932 treatment", "is not an approved visible residual", (created) => {
  const file = join(created.evidence, "caddy", "reachability.json");
  const record = readJson(file);
  record.findings.push({ id: "GO-2026-9999", aliases: [], severity: "UNKNOWN", called: true, level: "symbol", fixedVersion: null });
  writeJson(file, record);
});

// --- 18: the fully valid six-image evidence -------------------------------------------------
test("18. fully valid six-image evidence -> PASS", async () => {
  await withFixture((created) => {
    const result = run(created.root, created.evidence);
    assert.equal(result.status, 0, `expected the aggregate gate to pass: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /W27 aggregate six-image security gate: PASS/);
    for (const name of IMAGES) assert.match(result.stdout, new RegExp(`${name}: ok`));
  });
});
