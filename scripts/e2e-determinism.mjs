// Wave X X0 determinism proof.
//
// Runs the deterministic harness N times in ONE Playwright invocation
// (`--repeat-each`) on a single engine/viewport and asserts every repetition
// produced the identical ID-free fixture fingerprint. One invocation also means
// one sign-in (the harness caches its session), so the proof does not consume
// the deployed sign-in budget. A mismatch means the harness or the fixture is
// nondeterministic, which would make any later X1/X2 evidence untrustworthy.
import { spawnSync } from "node:child_process";

const runs = Number(process.env.HARNESS_DETERMINISM_RUNS || 3);
const project = process.env.HARNESS_DETERMINISM_PROJECT || "chromium-desktop";

const result = spawnSync(
  "npx",
  [
    "playwright",
    "test",
    "--config=playwright.harness.config.ts",
    `--project=${project}`,
    `--repeat-each=${runs}`,
    "--reporter=line",
  ],
  { stdio: ["ignore", "pipe", "inherit"], env: process.env },
);
const output = result.stdout?.toString() || "";
if (result.status !== 0) {
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}

const fingerprints = [...output.matchAll(/HARNESS_FINGERPRINT (\{.*\})/g)].map(
  (match) => match[1],
);
if (fingerprints.length !== runs) {
  process.stderr.write(output);
  throw new Error(
    `Expected ${runs} HARNESS_FINGERPRINT lines, saw ${fingerprints.length}`,
  );
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
