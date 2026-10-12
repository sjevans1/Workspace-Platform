#!/usr/bin/env node
// W27 six-image aggregate security evaluator (fail-closed, blocking).
//
// This is phase 2 of the W27 aggregate security gate. Phase 1
// (scripts/ci/w27-collect-evidence.sh) collects evidence for all six qualification images and
// never decides or aborts. This evaluator is the ONLY component that decides, and it decides
// after collection has finished, so a single failing image cannot hide the state of the others.
//
// PASS requires, for exactly the six expected images:
//   - every required SBOM
//   - valid immutable identities that match the authoritative provenance sources
//   - resolver / provenance validation
//   - zero unadjudicated fixable HIGH/CRITICAL
//   - zero reachable blocking HIGH/CRITICAL
//   - exact PostgreSQL/gosu VEX validation
//   - every required reachability record
//
// Missing, unreadable or malformed evidence is a FAIL.
//
// Usage: node scripts/w27-security-aggregate.mjs [--root <dir>] [--evidence <dir>] [--json]

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveReleaseImages } from "./w27-image-inventory.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { root: SCRIPT_ROOT, evidence: null, jsonPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--root") args.root = path.resolve(argv[(i += 1)]);
    else if (token === "--evidence") args.evidence = argv[(i += 1)];
    else if (token === "--json") args.jsonPath = path.resolve(argv[(i += 1)]);
  }
  return args;
}

export class AggregateEvaluator {
  constructor({ root, evidenceDirectory }) {
    this.root = root;
    this.failures = [];
    this.notes = [];
    this.images = [];
    this.evidenceDirectory = evidenceDirectory;
  }

  fail(message) {
    this.failures.push(message);
  }

  note(message) {
    this.notes.push(message);
  }

  relative(file) {
    return path.relative(this.root, file) || file;
  }

  readText(file, label) {
    const from = this.evidenceDirectory && file.startsWith(this.evidenceDirectory) ? path.relative(this.evidenceDirectory, file) : this.relative(file);
    if (!existsSync(file)) {
      this.fail(`${label}: missing evidence file (${from})`);
      return null;
    }
    let stats;
    try {
      stats = statSync(file);
    } catch (error) {
      this.fail(`${label}: unreadable evidence file (${from}): ${error.code ?? error.message}`);
      return null;
    }
    if (!stats.isFile()) {
      this.fail(`${label}: evidence entry is not a file (${from})`);
      return null;
    }
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      this.fail(`${label}: unreadable evidence file (${from}): ${error.code ?? error.message}`);
      return null;
    }
  }

  readJson(file, label) {
    const text = this.readText(file, label);
    if (text === null) return null;
    if (text.trim() === "") {
      this.fail(`${label}: malformed evidence (empty file)`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      this.fail(`${label}: malformed evidence (not valid JSON)`);
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------------------------
  evaluate() {
    const policy = this.readJson(path.join(this.root, "ci/w27-security-policy.json"), "policy (ci/w27-security-policy.json)");
    if (!policy) return this.report();
    this.policy = policy;

    if (policy.schemaVersion !== "1.0.0") this.fail(`policy: unsupported schemaVersion ${policy.schemaVersion}`);
    if (policy.policy?.weakened !== false) {
      this.fail("policy: the blocking policy is marked as weakened");
    }
    const blockingSeverities = policy.policy?.blockingSeverities ?? [];
    if (JSON.stringify([...blockingSeverities].sort()) !== JSON.stringify(["CRITICAL", "HIGH"])) {
      this.fail(`policy: blocking severities are not exactly HIGH and CRITICAL (${JSON.stringify(blockingSeverities)})`);
    }

    this.checkProvenance();
    this.checkExpectedImages();
    this.checkResolverRecord();

    for (const spec of this.policy.images ?? []) this.evaluateImage(spec);
    return this.report();
  }

  checkProvenance() {
    const { resolved, identities, failures } = resolveReleaseImages(this.root);
    this.resolved = resolved;
    this.identities = identities;
    for (const failure of failures) this.fail(`provenance: ${failure}`);
    this.note(`provenance resolved for ${Object.keys(identities).length} images`);
  }

  checkExpectedImages() {
    const policyImages = this.policy.images ?? [];
    const expected = policyImages.map((image) => image.logicalName);
    if (policyImages.length !== 6 || new Set(expected).size !== 6) {
      this.fail(`policy: expected exactly six image records, found ${policyImages.length}`);
    }
    if (!this.evidenceDirectory) this.fail("evidence: no evidence directory configured");
    if (!existsSync(this.evidenceDirectory)) {
      this.fail(`evidence: the collection directory ${this.evidenceDirectory} does not exist`);
      return;
    }
    const present = readdirSync(this.evidenceDirectory).filter((entry) => {
      try {
        return statSync(path.join(this.evidenceDirectory, entry)).isDirectory();
      } catch {
        return false;
      }
    });
    for (const name of expected) {
      if (!present.includes(name)) this.fail(`evidence: no collected evidence record for ${name}`);
    }
    for (const name of present) {
      if (!expected.includes(name)) this.fail(`evidence: unexpected image evidence record ${name}`);
    }
  }

  checkResolverRecord() {
    const recordPath = path.join(this.evidenceDirectory, this.policy.evidence?.resolverRecord ?? "resolver.json");
    const record = this.readJson(recordPath, "resolver record (resolver.json)");
    if (!record) return;
    if (record.exitCode !== 0) {
      this.fail(`resolver record: the inventory resolver reported exit ${record.exitCode}: ${String(record.stderr ?? "").trim().slice(0, 300)}`);
    }
    const recorded = new Map(
      String(record.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    for (const [key, value] of Object.entries(this.resolved ?? {})) {
      if (!value) continue;
      if (recorded.get(key) !== value) {
        this.fail(`resolver record: ${key} was recorded as ${recorded.get(key) ?? "absent"} but the authoritative resolver now yields ${value}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Per-image evidence
  // -------------------------------------------------------------------------------------------
  evaluateImage(spec) {
    const name = spec.logicalName;
    const dir = path.join(this.evidenceDirectory, name);
    const summary = { logicalName: name, failures: [] };
    const before = this.failures.length;
    if (!existsSync(dir)) {
      this.fail(`${name}: no collected evidence record`);
      summary.failures = this.failures.slice(before);
      this.images.push(summary);
      return;
    }

    this.checkIdentity(spec, dir);
    this.checkCollectionErrors(spec, dir);
    const sbom = this.checkSbom(spec, dir);
    const raw = this.checkTrivy(spec, dir, "trivy-raw.json", "raw scanner JSON");
    this.checkAllFindingsReport(spec, dir);
    const fixable = this.checkTrivy(spec, dir, "trivy-fixable.json", "blocking-policy scanner JSON");

    const fixableFindings = fixable ? this.fixableFindings(fixable) : [];
    summary.fixableHighCritical = fixableFindings.map((finding) => finding.id);

    let adjudicated = new Set();
    if (spec.vexRequired) {
      adjudicated = this.checkVexDisposition(spec, dir, fixableFindings);
    } else {
      this.checkVexAbsence(spec, dir);
    }

    const unadjudicated = fixableFindings.filter((finding) => !adjudicated.has(finding.id));
    if (unadjudicated.length) {
      this.fail(
        `${name}: ${unadjudicated.length} unadjudicated fixable HIGH/CRITICAL finding(s): ${unadjudicated
          .map((finding) => `${finding.id} (${finding.severity})`)
          .join(", ")}`,
      );
    }

    if (spec.reachabilityRequired) this.checkReachability(spec, dir, raw);
    else this.checkReachabilityAbsence(spec, dir);

    summary.sbomComponents = sbom?.components?.length ?? null;
    summary.failures = this.failures.slice(before);
    this.images.push(summary);
  }

  // Phase 1 records every collection, scanner and tooling failure per image. The gate fails
  // closed on that record itself: an image whose evidence otherwise parses is still a FAIL when the
  // collector recorded a failure for it, so a scanner that failed silently cannot pass on a stale
  // or partial artifact set.
  checkCollectionErrors(spec, dir) {
    const name = spec.logicalName;
    const fileName = this.policy.evidence?.collectionErrorRecord ?? "collection-errors.txt";
    const text = this.readText(path.join(dir, fileName), `${name}/${fileName} (collection error record)`);
    if (text === null) return;
    const recorded = text.trim();
    if (recorded === "") return;
    const lines = recorded.split("\n");
    this.fail(
      `${name}: phase 1 recorded ${lines.length} collection error(s) in ${fileName}; the gate fails closed on any recorded collection, scanner or tooling failure: ${lines[0]}`,
    );
  }

  checkIdentity(spec, dir) {
    const name = spec.logicalName;
    const identity = this.readJson(path.join(dir, "identity.json"), `${name}/identity.json`);
    if (!identity) return;
    const authoritative = this.identities?.[name];
    if (!authoritative) {
      this.fail(`${name}: no authoritative identity for this image`);
      return;
    }
    if (identity.logicalName !== name) this.fail(`${name}: identity record names ${identity.logicalName}`);
    if (identity.reference !== authoritative.reference) {
      this.fail(`${name}: recorded image identity ${identity.reference} is not the authoritative reference ${authoritative.reference}`);
    }
    if (identity.provenanceClass !== spec.provenanceClass) {
      this.fail(`${name}: recorded provenance class ${identity.provenanceClass} is not ${spec.provenanceClass}`);
    }
    // Docker's local image id is a local, storage-backend-dependent value. It is allowed to differ
    // from the registry manifest or index digest, so it is required to be a valid local image
    // identity and is deliberately NOT compared to authoritative.digest. Registry identity is
    // proven by the immutable reference itself and by the local image's RepoDigests.
    const resolved = identity.resolvedImageId ?? "";
    if (!/^sha256:[a-f0-9]{64}$/.test(resolved)) {
      this.fail(`${name}: recorded local image id is not a valid sha256 image identity (${resolved || "absent"})`);
      return;
    }
    if (authoritative.kind === "registry-digest") {
      const reference = String(identity.reference ?? "");
      if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(reference)) {
        this.fail(`${name}: recorded registry identity is not an immutable digest reference (${reference || "absent"})`);
      }
      const digests = Array.isArray(identity.repoDigests) ? identity.repoDigests : null;
      if (!digests || digests.length === 0) {
        this.fail(`${name}: no RepoDigests were recorded, so the pulled image cannot be shown to be the authoritative immutable reference`);
      } else if (!digests.includes(authoritative.reference)) {
        this.fail(
          `${name}: RepoDigests does not contain the authoritative immutable reference ${authoritative.reference} (recorded ${digests.join(", ")})`,
        );
      }
    }
    if (identity.architecture !== "amd64") this.fail(`${name}: recorded architecture ${identity.architecture} is not amd64`);
  }

  checkSbom(spec, dir) {
    const name = spec.logicalName;
    if (!spec.sbomRequired) return null;
    const sbom = this.readJson(path.join(dir, "sbom.cdx.json"), `${name}/sbom.cdx.json`);
    if (!sbom) return null;
    if (sbom.bomFormat !== "CycloneDX") this.fail(`${name}: SBOM is not a CycloneDX document (${sbom.bomFormat ?? "absent"})`);
    if (!Array.isArray(sbom.components) || sbom.components.length === 0) this.fail(`${name}: SBOM declares no components`);
    return sbom;
  }

  checkTrivy(spec, dir, file, label) {
    const name = spec.logicalName;
    const document = this.readJson(path.join(dir, file), `${name}/${file} (${label})`);
    if (!document) return null;
    if (!Array.isArray(document.Results)) {
      this.fail(`${name}: ${file} is not a scanner result document (no Results array)`);
      return null;
    }
    return document;
  }

  checkAllFindingsReport(spec, dir) {
    const name = spec.logicalName;
    const text = this.readText(path.join(dir, "trivy-all-findings.txt"), `${name}/trivy-all-findings.txt`);
    if (text === null) return;
    if (text.trim() === "") this.fail(`${name}: the all-findings report is empty`);
  }

  fixableFindings(document) {
    const severities = this.policy.policy?.blockingSeverities ?? [];
    const ignoreUnfixed = this.policy.policy?.ignoreUnfixedForBlocking !== false;
    const findings = [];
    for (const result of document.Results ?? []) {
      for (const vulnerability of result.Vulnerabilities ?? []) {
        const severity = String(vulnerability.Severity ?? "UNKNOWN").toUpperCase();
        if (!severities.includes(severity)) continue;
        if (ignoreUnfixed && !vulnerability.FixedVersion) continue;
        findings.push({
          id: vulnerability.VulnerabilityID,
          package: vulnerability.PkgName ?? null,
          severity,
          fixedVersion: vulnerability.FixedVersion ?? null,
        });
      }
    }
    return findings;
  }

  // -------------------------------------------------------------------------------------------
  // VEX
  // -------------------------------------------------------------------------------------------
  checkVexDisposition(spec, dir, fixableFindings) {
    const name = spec.logicalName;
    const expected = this.policy.vex?.[name];
    if (!expected) {
      this.fail(`${name}: the policy requires a VEX disposition but declares none`);
      return new Set();
    }
    const committed = this.readJson(path.join(this.root, expected.path), `policy VEX (${expected.path})`);
    const collected = this.readJson(path.join(dir, "vex.json"), `${name}/vex.json`);
    if (!collected) return new Set();
    if (committed && JSON.stringify(committed) !== JSON.stringify(collected)) {
      this.fail(`${name}: the collected VEX evidence is not the committed VEX at ${expected.path}`);
    }

    const statements = collected.statements ?? [];
    if (collected.openvex !== "0.2.0") this.fail(`${name}: VEX is not an OpenVEX 0.2.0 document`);
    if (statements.length !== 1) this.fail(`${name}: the VEX must carry exactly one statement (found ${statements.length})`);
    const statement = statements[0] ?? {};
    if (statement.vulnerability?.name !== expected.vulnerability) this.fail(`${name}: VEX vulnerability is not ${expected.vulnerability}`);
    if (statement.status !== expected.status) this.fail(`${name}: VEX status is not ${expected.status}`);
    if (statement.justification !== expected.justification) this.fail(`${name}: VEX justification is not ${expected.justification}`);

    const products = statement.products ?? [];
    if (products.length !== 1) this.fail(`${name}: the VEX must name exactly one product (found ${products.length})`);
    const product = products[0] ?? {};
    const component = product.component ?? {};
    if (component["@id"] !== expected.componentId) this.fail(`${name}: VEX component id is not ${expected.componentId}`);
    if (component.name !== expected.componentName) this.fail(`${name}: VEX component name is not ${expected.componentName}`);
    if (component.version !== expected.componentVersion) this.fail(`${name}: VEX component version is not ${expected.componentVersion}`);
    if (component.hashes?.["sha-256"] !== expected.componentSha256) {
      this.fail(`${name}: VEX component binary identity is not the qualified sha256`);
    }
    if ((product.subcomponents ?? [])[0]?.["@id"] !== expected.subcomponentId) {
      this.fail(`${name}: VEX subcomponent path is not ${expected.subcomponentId}`);
    }
    if (product.parent_image_digest !== expected.parentImageDigest) {
      this.fail(`${name}: VEX parent image digest is not the qualified PostgreSQL digest`);
    } else if (this.identities?.[name]?.digest && product.parent_image_digest !== this.identities[name].digest) {
      this.fail(`${name}: VEX parent image digest does not match the image this gate qualified`);
    }
    if (product.platform !== expected.platform) this.fail(`${name}: VEX platform is not ${expected.platform}`);

    const declared = [...(product.trivy_finding_ids ?? [])].sort();
    const policyIds = [...(expected.findingIds ?? [])].sort();
    if (JSON.stringify(declared) !== JSON.stringify(policyIds)) {
      this.fail(`${name}: the VEX adjudicates a different finding set than the policy declares`);
    }
    const scanned = fixableFindings.map((finding) => finding.id).sort();
    if (JSON.stringify(declared) !== JSON.stringify(scanned)) {
      this.fail(
        `${name}: the VEX adjudication is not exact for this image (VEX ${declared.length} finding(s), blocking scan ${scanned.length}); ` +
          "a VEX that does not cover exactly the fixable HIGH/CRITICAL set is a scope change, not an adjudication",
      );
    }

    const reachability = (statement.evidence ?? []).find((entry) => entry.type === "reachability");
    if (!reachability) this.fail(`${name}: the VEX carries no reachability evidence`);
    else {
      if (reachability.tool !== "govulncheck" || reachability.mode !== "binary") {
        this.fail(`${name}: the VEX reachability evidence is not a binary govulncheck run`);
      }
      if (!/0\s+reachable/i.test(String(reachability.result ?? ""))) {
        this.fail(`${name}: the VEX reachability evidence does not report zero reachable vulnerabilities`);
      }
    }
    if (!statement.review?.expiry_basis || !statement.review?.review_by) {
      this.fail(`${name}: the VEX has no bounded review window`);
    }
    return new Set(declared);
  }

  checkVexAbsence(spec, dir) {
    const name = spec.logicalName;
    if (spec.vexAllowed) return;
    const vexPath = path.join(dir, "vex.json");
    if (!existsSync(vexPath)) return;
    this.fail(`${name}: a VEX disposition was supplied for an image whose policy forbids one (${name} must not inherit another image's VEX)`);
    const collected = this.readJson(vexPath, `${name}/vex.json`);
    const referenced = JSON.stringify(collected ?? {});
    for (const other of Object.keys(this.policy.vex ?? {})) {
      if (other === name) continue;
      const expected = this.policy.vex[other];
      if (referenced.includes(expected.vulnerability) || referenced.includes(expected.componentSha256)) {
        this.fail(`${name}: the supplied VEX inherits the ${other} disposition (${expected.vulnerability})`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reachability
  // -------------------------------------------------------------------------------------------
  expectedBinarySha256(spec) {
    const name = spec.logicalName;
    if (name === "postgres") return this.policy.vex?.postgres?.componentSha256 ?? null;
    if (spec.provenanceClass === "patched-upstream") {
      const patched = this.readJson(path.join(this.root, "ci/w27-patched-images.json"), "patched provenance (ci/w27-patched-images.json)");
      const record = patched?.images?.find((image) => image.logicalName === name);
      return record?.binarySha256 ?? null;
    }
    return null;
  }

  checkReachabilityAbsence(spec, dir) {
    const name = spec.logicalName;
    if (spec.reachabilityRequired) return;
    if (existsSync(path.join(dir, "reachability.json"))) {
      this.fail(`${name}: a reachability record was supplied for an image whose policy does not require one`);
    }
  }

  checkReachability(spec, dir, raw) {
    const name = spec.logicalName;
    const record = this.readJson(path.join(dir, "reachability.json"), `${name}/reachability.json (reachability evidence)`);
    if (!record) return;

    if (record.tool !== "govulncheck") this.fail(`${name}: reachability evidence was not produced by govulncheck`);
    if (record.scanMode !== "binary") this.fail(`${name}: reachability evidence is not a binary-mode analysis`);
    // An image may never inherit another image's VEX disposition, in any evidence file.
    if (record.adjudicatedBy) {
      this.fail(`${name}: the reachability record claims an inherited VEX disposition (${record.adjudicatedBy})`);
      this.fail(`${name}: the reachability record inherits the ${record.adjudicatedBy} VEX disposition`);
    }
    const serialized = JSON.stringify(record);
    for (const [other, expected] of Object.entries(this.policy.vex ?? {})) {
      if (other === name) continue;
      if (serialized.includes(expected.vulnerability) || serialized.includes(expected.componentSha256)) {
        this.fail(`${name}: the reachability record inherits the ${other} VEX disposition`);
      }
    }
    if (record.imageReference !== this.identities?.[name]?.reference) {
      this.fail(`${name}: reachability evidence names a different image (${record.imageReference ?? "absent"})`);
    }
    if (spec.reachabilityBinaryPath && record.binaryPath !== spec.reachabilityBinaryPath) {
      this.fail(`${name}: reachability evidence analysed ${record.binaryPath ?? "no binary"} instead of ${spec.reachabilityBinaryPath}`);
    }

    const expectedSha = this.expectedBinarySha256(spec);
    if (expectedSha && record.binarySha256 !== expectedSha) {
      this.fail(`${name}: reachability evidence analysed binary ${record.binarySha256 ?? "absent"} instead of the qualified ${expectedSha}`);
    }

    const findings = Array.isArray(record.findings) ? record.findings : null;
    if (!findings) {
      this.fail(`${name}: reachability record has no findings array`);
      return;
    }

    for (const expected of spec.mustBeAbsentReachable ?? []) {
      if (findings.some((finding) => finding.id === expected)) {
        this.fail(`${name}: ${expected} is still present in the analysed binary; it must stay absent`);
      }
    }

    const severities = this.policy.policy?.blockingSeverities ?? [];
    const called = findings.filter((finding) => finding.called);

    if (spec.vexRequired) {
      // The VEX claims the vulnerable code is not in an execute path in this binary. That claim is
      // falsifiable here: any finding this analysis reports as called contradicts it outright, so a
      // VEX-adjudicated image may carry no called finding at any severity. Findings that only
      // affect the build information stay visible; they are the subject of the VEX, and the exact
      // VEX validation above is what binds them to the blocking scan.
      for (const finding of called) {
        this.fail(`${name}: the VEX disposition claims the vulnerable code is not in an execute path, but ${finding.id} is called by the analysed binary`);
      }
    } else {
      const allowedCalled = new Set(spec.allowedVisibleReachable ?? []);
      const allowedAffected = new Set(spec.allowedVisibleReachable ?? []);
      for (const finding of called) {
        const severity = String(finding.severity ?? "UNKNOWN").toUpperCase();
        if (severities.includes(severity)) {
          this.fail(`${name}: reachable ${severity} finding ${finding.id} is called by the analysed binary`);
        } else if (!allowedCalled.has(finding.id)) {
          this.fail(`${name}: reachable finding ${finding.id} is not an approved visible residual for this image`);
        }
      }
      for (const finding of findings.filter((entry) => !entry.called)) {
        const severity = String(finding.severity ?? "UNKNOWN").toUpperCase();
        if (severities.includes(severity)) {
          this.fail(`${name}: ${severity} finding ${finding.id} affects the analysed binary and is not adjudicated`);
        } else if (!allowedAffected.has(finding.id)) {
          this.fail(`${name}: affected finding ${finding.id} is not an approved visible residual for this image`);
        }
      }
      // On an image with no VEX, a residual may never be licensed on a blocking severity, whatever
      // the allowlist says. (On the VEX image the blocking scanner set is licensed by the VEX
      // itself, whose scope is validated exactly.)
      for (const id of [...allowedCalled, ...allowedAffected]) {
        const finding = findings.find((entry) => entry.id === id);
        if (finding && severities.includes(String(finding.severity ?? "UNKNOWN").toUpperCase())) {
          this.fail(`${name}: ${id} is listed as a visible residual but the blocking policy reports it ${finding.severity}`);
        }
      }
    }

    if (raw) {
      // Cross-check: a finding the reachability record calls blocking must appear in the
      // blocking-policy scan too, so the two evidence sources cannot disagree silently.
      const scanned = new Set(this.fixableFindings(raw).map((finding) => finding.id));
      for (const finding of called) {
        const aliases = Array.isArray(finding.aliases) ? finding.aliases : [];
        if (severities.includes(String(finding.severity ?? "UNKNOWN").toUpperCase()) && !aliases.some((alias) => scanned.has(alias))) {
          this.fail(`${name}: reachable ${finding.severity} finding ${finding.id} is not present in the blocking-policy scanner result`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------------------------
  report() {
    const passed = this.failures.length === 0;
    const report = {
      schemaVersion: "1.0.0",
      gate: "W27 six-image aggregate security evaluator",
      status: passed ? "PASS" : "FAIL",
      expectedImages: (this.policy?.images ?? []).map((image) => image.logicalName),
      evaluatedImages: this.images.map((image) => image.logicalName),
      perImage: this.images,
      notes: this.notes,
      failures: this.failures,
    };
    if (this.json) writeFileSync(this.json, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
}

export function evaluateAggregateGate({ root = SCRIPT_ROOT, evidenceDirectory, jsonPath = null }) {
  const evaluator = new AggregateEvaluator({ root, evidenceDirectory });
  evaluator.json = jsonPath;
  return evaluator.evaluate();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath = path.join(args.root, "ci/w27-security-policy.json");
  let evidenceDirectory = args.evidence;
  if (!evidenceDirectory) {
    let configured = "w27-evidence";
    if (existsSync(policyPath)) {
      try {
        configured = JSON.parse(readFileSync(policyPath, "utf8")).evidence?.directory ?? configured;
      } catch {
        configured = "w27-evidence";
      }
    }
    evidenceDirectory = path.resolve(args.root, configured);
  }
  const report = evaluateAggregateGate({ root: args.root, evidenceDirectory, jsonPath: args.jsonPath });

  console.log(`W27 aggregate six-image security gate: ${report.status}`);
  console.log(`  expected images: ${report.expectedImages.join(", ")}`);
  console.log(`  evaluated images: ${report.evaluatedImages.join(", ") || "none"}`);
  for (const image of report.perImage) {
    if (image.failures?.length) console.log(`  ${image.logicalName}: FAIL (${image.failures.length} finding(s))`);
    else console.log(`  ${image.logicalName}: ok`);
  }
  if (report.notes.length) for (const note of report.notes) console.log(`  note: ${note}`);
  if (report.failures.length) {
    console.error(`W27 aggregate gate FAILED with ${report.failures.length} failure(s):`);
    for (const failure of report.failures) console.error(`  - ${failure}`);
  }
  process.exit(report.status === "PASS" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
