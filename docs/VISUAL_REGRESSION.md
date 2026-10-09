# Visual regression (Wave X)

**Status: X2 implemented.** Thirty committed baselines cover the surface set below. CI runs the visual config in comparison mode on every run and proves drift detection with the canary; it never updates baselines.

## Why

Deterministic screenshots catch real layout drift on the surfaces customers see
without becoming screenshot-noise machinery. They are a signal, not a compliance
claim, and never a substitute for the engine-compatibility lane (X1).

## Harness

- `playwright.visual.config.ts` runs only `e2e/visual.spec.ts`.
- Chromium only. Firefox and WebKit rasterise differently, so cross-engine pixel
  baselines are noise; engine behaviour is covered by `playwright.harness.config.ts`
  and the accessibility lane instead.
- Light and dark, desktop `1440x1000` and phone `390x844`, `deviceScaleFactor: 1`,
  pinned `locale` and `timezoneId`, `animations: "disabled"`.
- `maxDiffPixelRatio` starts at `0.002`, tight enough to catch layout drift and
  tolerant of anti-aliasing. X2 tunes it once from real runs rather than guessing.

## Fixtures

`e2e/fixtures/catalog.ts` defines fixed titles and values with no timestamps and
no randomness in visible content. Resource IDs are generated, so snapshots and
fingerprints must never depend on raw ID text. Fixtures contain synthetic content
only.

## Snapshot scope (X2)

Eight surfaces, from the deterministic fixture only:

1. sign-in screen;
2. workspace shell with the sidebar (the navigation is opened first at phone width);
3. a page with the core block set;
4. the database table view;
5. the board view;
6. the calendar view;
7. the settings/branding surface;
8. the manage-access dialog.

Viewport scope: light and dark at desktop `1440x1000` and phone `390x844`. The
settings surface is a modal reached from the navigation; it is captured at
desktop only, because the phone off-canvas navigation does not expose it
deterministically to Playwright. Phone coverage is provided by the other seven
surfaces. Inbox is not included because the fixture cannot make it deterministic.

## Baseline update process

Baselines live in `e2e/visual.spec.ts-snapshots/` and are committed.

- **CI never updates them.** A normal run only compares.
- To regenerate, trigger the `Workspace verification` workflow with
  `update_visual_baselines: true` (Actions → Run workflow). The deployment job
  runs `--update-snapshots` (excluding the canary, which must never write a
  baseline) and uploads `e2e/visual.spec.ts-snapshots` as the `visual-baselines`
  artifact for review and commit. Locally the same command is
  `npx playwright test --config=playwright.visual.config.ts --grep-invert "@canary" --update-snapshots`
  against a running stack.
- A failing snapshot is investigated, never refreshed to green.

## Step ordering (load-bearing)

The visual comparison runs **first among browser steps** in the deployment job,
immediately after the stack is healthy and the EICAR check, and before the
deployed browser workflow, the Wave R harness and the capacity runs.

Reason: the shell and page surfaces render workspace-wide state (sidebar
resource tree, recently viewed, page chrome). Those baselines are only
reproducible against a pristine, freshly-seeded workspace. Running the visual
step last produced 0.02-0.05 content differences on `workspace-shell` and
`page-blocks` regardless of how exactly the baselines were generated. Do not
move it later, and do not mask those regions instead.

The step is also the first authenticated step, so its single setup-project
sign-in does not compete with the reused sign-in budget that the later steps
consume.

## Drift-detection proof

The spec contains a `@canary` case that deliberately inverts the database table
and compares it against the committed baseline with `maxDiffPixelRatio: 0`. CI
runs it with `--grep @canary` and asserts a **non-zero exit**; a canary that
passes means the comparison is not actually running.
