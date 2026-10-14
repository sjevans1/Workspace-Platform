import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

// #224: a GREEN Connected Work lane produced no artifact at all.
//
// The lane's Playwright config retains traces and screenshots only on failure,
// so on a passing FULL run `test-results/connected-work` was empty and
// `actions/upload-artifact` warned "No files were found with the provided path"
// and published nothing. The blocking step and the workflow log held the pass
// evidence instead, and the FAILED candidate still produced its failure artifact
// correctly, so the gate itself was never wrong: only the green-run evidence was
// missing.
//
// This reporter writes one tiny, deterministic manifest into the same artifact
// path for EVERY outcome, so the dedicated `connected-work-results` artifact is
// produced on a green run as well as a red one.
//
// Deliberately unchanged: retries stay 0, the lane stays blocking, every
// assertion stays as strict, and failure traces/screenshots are still captured
// (trace: "retain-on-failure", screenshot: "only-on-failure").
//
// Deterministic means: no timestamps, no durations, no worker or host details,
// outcomes sorted by file then title, and count keys sorted. Two runs over the
// same outcome set produce byte-identical JSON.

export type LaneOutcome = {
  file: string;
  title: string;
  status: string;
};

export type LaneManifest = {
  lane: string;
  config: string;
  blocking: boolean;
  retries: number;
  status: string;
  expected_tests: number;
  total: number;
  counts: Record<string, number>;
  complete: boolean;
  tests: LaneOutcome[];
};

export type ManifestInput = {
  lane: string;
  config: string;
  retries: number;
  expectedTests: number;
  runStatus: string;
  outcomes: LaneOutcome[];
};

/** Pure builder so the manifest shape and its determinism are directly testable. */
export function buildManifest(input: ManifestInput): LaneManifest {
  const tests = [...input.outcomes].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.status < b.status ? -1 : a.status === b.status ? 0 : 1;
  });
  const counts: Record<string, number> = {};
  for (const outcome of tests) {
    counts[outcome.status] = (counts[outcome.status] || 0) + 1;
  }
  const sortedCounts: Record<string, number> = {};
  for (const status of Object.keys(counts).sort()) {
    sortedCounts[status] = counts[status];
  }
  return {
    lane: input.lane,
    config: input.config,
    blocking: true,
    retries: input.retries,
    status: input.runStatus,
    expected_tests: input.expectedTests,
    total: tests.length,
    counts: sortedCounts,
    // An explicit success shape: every expected test ran, and every one passed.
    complete:
      tests.length === input.expectedTests &&
      (sortedCounts.passed || 0) === input.expectedTests,
    tests,
  };
}

export default class ConnectedWorkEvidenceReporter implements Reporter {
  private readonly outcomes: LaneOutcome[] = [];

  constructor(
    private readonly options: {
      outputFile: string;
      lane?: string;
      config?: string;
      retries?: number;
      expectedTests?: number;
    },
  ) {}

  onTestEnd(test: TestCase, result: TestResult): void {
    // Only the stable parts of a test identity, never timings.
    this.outcomes.push({
      file: test.location.file.replace(`${process.cwd()}/`, ""),
      title: test.title,
      status: result.status,
    });
  }

  onEnd(result: FullResult): void {
    const manifest = buildManifest({
      lane: this.options.lane || "connected-work-and-automations",
      config: this.options.config || "playwright.connected-work.config.ts",
      retries: this.options.retries === undefined ? 0 : this.options.retries,
      expectedTests:
        this.options.expectedTests === undefined
          ? this.outcomes.length
          : this.options.expectedTests,
      runStatus: result.status,
      outcomes: this.outcomes,
    });
    const outputFile = this.options.outputFile;
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
