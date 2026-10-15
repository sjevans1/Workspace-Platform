import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ConnectedWorkEvidenceReporter, {
  buildManifest,
} from "../e2e-connected-work/evidence-reporter.ts";

// Repository hygiene proven, not asserted by hand.
//
// #223: a tracked ABSOLUTE `node_modules` symlink (mode 120000) reached main and
// forced a manual cleanup before `npm ci` in a fresh clone. `node_modules/`
// matches a directory only, so it never ignored the symlink.
//
// #224: a GREEN Connected Work lane published no artifact, because traces and
// screenshots are retained only on failure. The lane must emit its own tiny
// deterministic evidence for every outcome without weakening the gate.

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function git(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await run("git", args, { cwd: root });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

test("#223: .gitignore ignores node_modules as a file or a directory", async () => {
  const ignore = await readFile(join(root, ".gitignore"), "utf8");
  const patterns = ignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(
    patterns.includes("node_modules"),
    "a bare `node_modules` pattern is required: `node_modules/` matches a directory only, which is how the tracked symlink escaped it",
  );
  assert.ok(
    !patterns.includes("node_modules/"),
    "the directory-only pattern must be gone; it is exactly what let the tracked symlink reach main",
  );
  const dockerignore = await readFile(join(root, ".dockerignore"), "utf8");
  assert.match(
    dockerignore,
    /^node_modules$/m,
    "the image build context must still exclude node_modules",
  );
});

test("#223: no node_modules entry is tracked and it is ignored", async (t) => {
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    t.skip("not a git work tree");
    return;
  }
  const tracked = await git(["ls-files", "--", "node_modules"]);
  assert.equal(
    tracked.stdout.trim(),
    "",
    "no node_modules entry may be tracked; a fresh clone must not need manual cleanup",
  );
  const ignored = await git(["check-ignore", "--quiet", "node_modules"]);
  assert.ok(
    ignored.ok,
    "node_modules must be ignored, so a local symlink can never be committed again",
  );
});

test("#223: a fresh clone needs no manual cleanup before npm ci", async (t) => {
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    t.skip("not a git work tree");
    return;
  }
  // Prove it from the repository object graph, not from the working tree: the
  // tree committed for HEAD must not contain a node_modules entry at all.
  const head = await git(["rev-parse", "HEAD"]);
  if (!head.ok) {
    t.skip("no HEAD to inspect");
    return;
  }
  const tree = await git(["ls-tree", "--name-only", head.stdout.trim()]);
  assert.ok(
    !tree.stdout.split("\n").includes("node_modules"),
    "the committed tree must not carry a node_modules entry",
  );
});

test("#224: the evidence manifest is deterministic and carries no timings", () => {
  const outcomes = [
    {
      file: "e2e-connected-work/connected-work.spec.ts",
      title: "b",
      status: "passed",
    },
    {
      file: "e2e-connected-work/auth.setup.ts",
      title: "setup",
      status: "passed",
    },
    {
      file: "e2e-connected-work/connected-work.spec.ts",
      title: "a",
      status: "passed",
    },
  ];
  const base = {
    lane: "connected-work-and-automations",
    config: "playwright.connected-work.config.ts",
    retries: 0,
    expectedTests: 3,
    runStatus: "passed",
  };
  const first = JSON.stringify(buildManifest({ ...base, outcomes }), null, 2);
  const second = JSON.stringify(
    buildManifest({ ...base, outcomes: [...outcomes].reverse() }),
    null,
    2,
  );
  assert.equal(
    first,
    second,
    "the same outcome set must serialise identically regardless of order",
  );
  assert.ok(
    !/"(time|timestamp|duration|durationMs|startedAt|host|worker|pid)"/.test(
      first,
    ),
    "the manifest must not carry timings or host details",
  );
  const manifest = JSON.parse(first);
  assert.equal(manifest.total, 3);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.blocking, true);
  assert.equal(manifest.retries, 0);
  assert.deepEqual(
    Object.keys(manifest.counts),
    [...Object.keys(manifest.counts)].sort(),
    "count keys must be sorted",
  );
  assert.deepEqual(
    manifest.tests.map((entry: { file: string }) => entry.file),
    [...manifest.tests.map((entry: { file: string }) => entry.file)].sort(),
    "outcomes must be sorted by file then title",
  );
});

test("#224: a failed or short lane can never claim completeness", () => {
  const base = {
    lane: "connected-work-and-automations",
    config: "playwright.connected-work.config.ts",
    retries: 0,
    expectedTests: 2,
    runStatus: "passed",
  };
  const oneFailed = buildManifest({
    ...base,
    outcomes: [
      { file: "a.spec.ts", title: "a", status: "passed" },
      { file: "a.spec.ts", title: "b", status: "failed" },
    ],
  });
  assert.equal(oneFailed.complete, false, "a failed test is never complete");
  const short = buildManifest({
    ...base,
    expectedTests: 3,
    outcomes: [
      { file: "a.spec.ts", title: "a", status: "passed" },
      { file: "a.spec.ts", title: "b", status: "passed" },
    ],
  });
  assert.equal(short.complete, false, "a missing test is never complete");
  const skipped = buildManifest({
    ...base,
    outcomes: [{ file: "a.spec.ts", title: "a", status: "skipped" }],
  });
  assert.equal(skipped.complete, false, "a skipped test is never complete");
});

// The run status is part of the completeness contract: a runner or global
// failure can leave every individual test marked passed while the run itself
// failed, and publishing `status: "failed"` beside `complete: true` would be a
// contradictory artifact.
const allPassedOutcomes = [
  { file: "a.spec.ts", title: "a", status: "passed" },
  { file: "a.spec.ts", title: "b", status: "passed" },
];
const completeBase = {
  lane: "connected-work-and-automations",
  config: "playwright.connected-work.config.ts",
  retries: 0,
  expectedTests: 2,
};

test("#224: overall runStatus failed with every test passed is never complete", () => {
  const manifest = buildManifest({
    ...completeBase,
    runStatus: "failed",
    outcomes: allPassedOutcomes,
  });
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.counts.passed, 2, "the individual tests did pass");
  assert.equal(
    manifest.complete,
    false,
    "a failed RUN must never publish a complete manifest, even when every test passed",
  );
});

test("#224: overall runStatus interrupted with every test passed is never complete", () => {
  const manifest = buildManifest({
    ...completeBase,
    runStatus: "interrupted",
    outcomes: allPassedOutcomes,
  });
  assert.equal(manifest.status, "interrupted");
  assert.equal(manifest.counts.passed, 2, "the individual tests did pass");
  assert.equal(
    manifest.complete,
    false,
    "an interrupted RUN must never publish a complete manifest",
  );
});

test("#224: an all-passed run that passed overall remains complete", () => {
  const manifest = buildManifest({
    ...completeBase,
    runStatus: "passed",
    outcomes: allPassedOutcomes,
  });
  assert.equal(manifest.status, "passed");
  assert.equal(manifest.complete, true);
  assert.equal(manifest.total, 2);
  assert.equal(manifest.expected_tests, 2);
});

test("#224: the reporter writes the manifest into the artifact path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cw-evidence-"));
  const outputFile = join(dir, "connected-work-evidence.json");
  const reporter = new ConnectedWorkEvidenceReporter({
    outputFile,
    lane: "connected-work-and-automations",
    expectedTests: 1,
  });
  // Duck-typed TestCase/TestResult: only the stable identity fields are read.
  reporter.onTestEnd(
    {
      location: {
        file: join(root, "e2e-connected-work/connected-work.spec.ts"),
      },
      title: "lane test",
    } as never,
    { status: "passed" } as never,
  );
  reporter.onEnd({ status: "passed" } as never);
  try {
    const written = await readFile(outputFile, "utf8");
    const manifest = JSON.parse(written);
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.complete, true);
    assert.equal(manifest.total, 1);
    assert.equal(
      manifest.tests[0].file,
      "e2e-connected-work/connected-work.spec.ts",
      "the spec path is recorded relative to the repository root",
    );
    assert.ok(
      written.endsWith("\n"),
      "the manifest is a newline-terminated file",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#224: the lane keeps retries at zero, stays blocking and keeps failure evidence", async () => {
  const config = await readFile(
    join(root, "playwright.connected-work.config.ts"),
    "utf8",
  );
  assert.match(config, /retries: 0/, "retries must stay at zero");
  assert.match(
    config,
    /evidence-reporter\.ts/,
    "the evidence reporter must be registered on the lane",
  );
  assert.match(
    config,
    /test-results\/connected-work\/connected-work-evidence\.json/,
    "the manifest must land in the uploaded artifact path",
  );
  assert.match(
    config,
    /trace: "retain-on-failure"/,
    "failure traces must still be retained",
  );
  assert.match(
    config,
    /screenshot: "only-on-failure"/,
    "failure screenshots must still be retained",
  );
  assert.ok(
    !/test\.(fixme|skip|slow)\b|\.only\(/.test(config),
    "no quarantine mechanism may be introduced",
  );
});

test("#224: the workflow proves the manifest exists and still uploads the lane directory", async () => {
  const workflow = await readFile(
    join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const lane = workflow.indexOf(
    "name: Verify Connected Work and Automations browser workflow",
  );
  assert.ok(lane >= 0, "the Connected Work lane step must still exist");
  const nextStep = workflow.indexOf("\n      - ", lane + 1);
  const laneStep = workflow.slice(lane, nextStep === -1 ? undefined : nextStep);
  const command = laneStep.indexOf(
    "npx playwright test --config=playwright.connected-work.config.ts",
  );
  const proof = laneStep.indexOf(
    "test -s test-results/connected-work/connected-work-evidence.json",
  );
  assert.ok(command >= 0, "the lane must still run the connected-work config");
  assert.ok(
    proof > command,
    "the evidence manifest must be proven present after the lane runs",
  );
  assert.ok(
    !/^[ \t]*continue-on-error:/m.test(laneStep),
    "the lane must stay blocking",
  );
  assert.ok(
    !/playwright test[^\n]*--retries/.test(laneStep),
    "no retry override may be passed on the command line",
  );
  const upload = workflow.indexOf("name: connected-work-results");
  assert.ok(upload >= 0, "the dedicated artifact upload must remain");
  const uploadStep = workflow.slice(upload, upload + 400);
  assert.match(
    uploadStep,
    /test-results\/connected-work/,
    "the artifact must still publish the lane's own directory",
  );
});
