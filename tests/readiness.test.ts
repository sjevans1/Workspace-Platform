import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { recoverOnce } from "../e2e/support/readiness";

// CI-H2 follow-up: focused proof for the shared readiness primitive's contract
// (no browser required) and for the readiness-before-content ordering that the
// W24-R and accessibility logins must obey.

function captureLogs() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

test("CI-H2 readiness: a satisfied state takes no recovery", async () => {
  let recoveries = 0;
  const { lines, restore } = captureLogs();
  try {
    await recoverOnce(
      "t-ok",
      async () => {},
      async () => {
        recoveries += 1;
      },
    );
  } finally {
    restore();
  }
  assert.equal(recoveries, 0, "no recovery when readiness holds");
  assert.ok(lines.includes("READINESS_OK t-ok"));
  assert.ok(!lines.some((line) => line.includes("READINESS_RECOVERY")));
});

test("CI-H2 readiness: at most one bounded recovery, then success", async () => {
  let attempts = 0;
  let recoveries = 0;
  const { lines, restore } = captureLogs();
  try {
    await recoverOnce(
      "t-recovered",
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("expected state absent");
      },
      async () => {
        recoveries += 1;
      },
    );
  } finally {
    restore();
  }
  assert.equal(attempts, 2, "assert exactly twice: initial plus one reassert");
  assert.equal(recoveries, 1, "exactly one bounded recovery");
  assert.ok(lines.includes("READINESS_RECOVERY t-recovered"));
  assert.ok(lines.includes("READINESS_RECOVERED t-recovered"));
});

test("CI-H2 readiness: persistent absence fails hard after one recovery", async () => {
  let recoveries = 0;
  const { lines, restore } = captureLogs();
  let error: unknown;
  try {
    await recoverOnce(
      "t-failed",
      async () => {
        throw new Error("still absent");
      },
      async () => {
        recoveries += 1;
      },
    );
  } catch (caught) {
    error = caught;
  } finally {
    restore();
  }
  assert.ok(error instanceof Error, "must throw when the state never appears");
  assert.equal(recoveries, 1, "recovery stays bounded to one attempt");
  assert.ok(lines.includes("READINESS_FAILED t-failed"));
});

test("CI-H2 ordering: entry readiness precedes the legacy content assertion", async () => {
  const specs = [
    "../e2e/wave-r-capacity.spec.ts",
    "../e2e/accessibility.spec.ts",
  ];
  for (const spec of specs) {
    const source = await readFile(fileURLToPath(new URL(spec, import.meta.url)), "utf8");
    const readiness = source.indexOf("recoverOnce(");
    const legacyHeading = source.indexOf('name: "Welcome back, Shane."');
    assert.ok(readiness >= 0, `${spec} must use the shared readiness primitive`);
    assert.ok(legacyHeading >= 0, `${spec} must keep its legacy heading assertion`);
    assert.ok(
      readiness < legacyHeading,
      `${spec}: shell readiness must be established before the legacy content assertion`,
    );
  }
});

test("CI-H2 invariant: W24-R capacity criteria are untouched by this change", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../e2e/wave-r-capacity.spec.ts", import.meta.url)),
    "utf8",
  );
  // The load/capacity shape must remain: the measured ladder and its
  // pass/fail criteria stay in the spec exactly as accepted.
  assert.match(source, /\[1, 5, 10, 25\]/, "the 1/5/10/25 ladder must remain");
  assert.ok(
    source.includes("MAX_READY_MS") || source.includes("await waitForCollabHealth"),
    "capacity measurement and its thresholds must remain in the spec",
  );
});
