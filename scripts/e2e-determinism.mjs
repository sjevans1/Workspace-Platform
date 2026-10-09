// Wave X X0 determinism proof.
//
// Runs the deterministic harness N times on a single engine/viewport and
// asserts every run produced the identical ID-free fixture fingerprint. A
// mismatch means the harness or the fixture is nondeterministic, which would
// make any later X1/X2 evidence untrustworthy.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runs = Number(process.env.HARNESS_DETERMINISM_RUNS || 3);
const project = process.env.HARNESS_DETERMINISM_PROJECT || "chromium-desktop";
const fingerprints = [];

for (let run = 1; run <= runs; run++) {
  const reportDir = mkdtempSync(join(tmpdir(), "harness-det-"));
  const result = spawnSync(
    "npx",
    [
      "playwright",
      "test",
      "--config=playwright.harness.config.ts",
      `--project=${project}`,
      "--reporter=line",
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        PLAYWRIGHT_HTML_REPORT: reportDir,
      },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout?.toString() || "");
    process.exit(result.status ?? 1);
  }
  const output = result.stdout?.toString() || "";
  const match = output.match(/HARNESS_FINGERPRINT (\{.*\})/);
  if (!match) {
    process.stderr.write(output);
    throw new Error(`Run ${run} produced no HARNESS_FINGERPRINT line`);
  }
  fingerprints.push(match[1]);
}

const unique = new Set(fingerprints);
if (unique.size !== 1) {
  throw new Error(
    `Harness is nondeterministic across ${runs} runs: ${unique.size} distinct fingerprints\n` +
      fingerprints.join("\n"),
  );
}
console.log(
  `Harness determinism proven: ${runs}/${runs} identical fingerprints on ${project}`,
);
