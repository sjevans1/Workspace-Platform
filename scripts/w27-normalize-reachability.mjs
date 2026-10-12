#!/usr/bin/env node
// W27: normalize a pinned govulncheck JSON stream into the W27 reachability record.
//
// The aggregate evaluator does not parse govulncheck text. This tool turns the stream into one
// small, reviewable record and derives a severity for each advisory from the CVE aliases the
// blocking-policy scan actually reported, so "zero reachable HIGH/CRITICAL" is decided on real
// scanner severities rather than on a hand-written annotation.
//
// govulncheck (binary mode) distinguishes the level at which an advisory affects a binary:
//   affected  the vulnerable module is in the build information
//   called    a frame of the finding's trace reaches a function, so the vulnerable code is
//             actually executed by this binary
// Only `called` findings are blocking-relevant; `affected` findings stay visible.
//
// Usage:
//   node scripts/w27-normalize-reachability.mjs \
//     --govulncheck <govulncheck.json> --binary-sha <file> --trivy <trivy-raw.json> \
//     --binary-path /usr/bin/caddy --image <reference> --out <reachability.json>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// govulncheck -json emits a stream of pretty-printed JSON objects with no separator.
export function parseJsonStream(text) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * @param {string} govulncheckJson raw pinned govulncheck -json output
 * @param {{binarySha256?: string, binaryPath?: string, imageReference?: string, trivyRaw?: object|null}} context
 */
export function normalizeReachability(govulncheckJson, context = {}) {
  const messages = parseJsonStream(govulncheckJson);
  const config = messages.find((message) => message.config)?.config ?? {};
  const advisories = new Map();
  for (const message of messages) {
    if (message.osv?.id) advisories.set(message.osv.id, message.osv);
  }

  const severityByCve = new Map();
  for (const result of context.trivyRaw?.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (!vulnerability?.VulnerabilityID) continue;
      const severity = String(vulnerability.Severity ?? "UNKNOWN").toUpperCase();
      const current = severityByCve.get(vulnerability.VulnerabilityID) ?? "UNKNOWN";
      severityByCve.set(vulnerability.VulnerabilityID, worseSeverity(current, severity));
    }
  }

  const findings = new Map();
  for (const message of messages) {
    if (!message.finding?.osv) continue;
    const finding = message.finding;
    const trace = finding.trace ?? [];
    const called = trace.some((frame) => Boolean(frame.function));
    const existing = findings.get(finding.osv) ?? { id: finding.osv, called: false, traces: [], aliases: advisories.get(finding.osv)?.aliases ?? [] };
    existing.called = existing.called || called;
    existing.traces.push(trace);
    if (finding.fixed_version) existing.fixedVersion = finding.fixed_version;
    findings.set(finding.osv, existing);
  }

  const records = [...findings.values()]
    .map((finding) => {
      const advisory = advisories.get(finding.id) ?? {};
      const aliases = advisory.aliases ?? [];
      const severity = aliases.reduce((worst, alias) => worseSeverity(worst, severityByCve.get(alias) ?? "UNKNOWN"), "UNKNOWN");
      return {
        id: finding.id,
        aliases,
        severity,
        called: finding.called,
        level: finding.called ? "symbol" : deepestLevel(finding.traces),
        fixedVersion: finding.fixedVersion ?? null,
        summary: advisory.summary ?? null,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    schemaVersion: "1.0.0",
    tool: "govulncheck",
    toolVersion: config.scanner_version ?? null,
    scanMode: config.scan_mode ?? "binary",
    scanLevel: config.scan_level ?? null,
    database: config.db ?? null,
    databaseLastModified: config.db_last_modified ?? null,
    binaryPath: context.binaryPath ?? null,
    binarySha256: context.binarySha256 ?? null,
    imageReference: context.imageReference ?? null,
    adjudicatedBy: null,
    counts: {
      advisories: records.length,
      called: records.filter((record) => record.called).length,
      affected: records.filter((record) => !record.called).length,
    },
    findings: records,
  };
}

const SEVERITY_ORDER = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function worseSeverity(a, b) {
  const left = SEVERITY_ORDER.indexOf(String(a ?? "UNKNOWN").toUpperCase());
  const right = SEVERITY_ORDER.indexOf(String(b ?? "UNKNOWN").toUpperCase());
  return (left < 0 ? 0 : left) >= (right < 0 ? 0 : right) ? String(a ?? "UNKNOWN").toUpperCase() : String(b ?? "UNKNOWN").toUpperCase();
}

function deepestLevel(traces) {
  if (traces.some((trace) => trace.some((frame) => frame.function))) return "symbol";
  if (traces.some((trace) => trace.some((frame) => frame.package))) return "package";
  return "module";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["govulncheck", "out"]) {
    if (typeof args[required] !== "string") {
      console.error(`missing --${required}`);
      process.exit(2);
    }
  }
  if (!existsSync(args.govulncheck)) {
    console.error(`unreadable govulncheck output: ${args.govulncheck}`);
    process.exit(1);
  }
  const binarySha = typeof args["binary-sha"] === "string" && existsSync(args["binary-sha"]) ? readFileSync(args["binary-sha"], "utf8").trim().split(/\s+/)[0] : null;
  let trivyRaw = null;
  if (typeof args.trivy === "string" && existsSync(args.trivy)) {
    try {
      trivyRaw = JSON.parse(readFileSync(args.trivy, "utf8"));
    } catch {
      trivyRaw = null;
    }
  }
  const record = normalizeReachability(readFileSync(args.govulncheck, "utf8"), {
    binarySha256: binarySha,
    binaryPath: typeof args["binary-path"] === "string" ? args["binary-path"] : null,
    imageReference: typeof args.image === "string" ? args.image : null,
    trivyRaw,
  });
  writeFileSync(args.out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `reachability ${args.out}: ${record.counts.advisories} advisories (${record.counts.called} called, ${record.counts.affected} affected)`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
