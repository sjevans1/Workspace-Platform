# Visual regression (Wave X)

**Status: X0 skeleton.** The configuration and this policy exist; no baselines
are committed and CI does not run the visual config until **X2**.

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

The smallest representative surface set, eight surfaces: the sign-in screen; the
workspace shell with sidebar and recently viewed; a page with the core block set;
the database table view; the board view; the calendar view; the settings branding
panel; the manage-access dialog. Inbox is a ninth only if the fixture can make it
deterministic.

## Baseline policy

- Baselines live in this **public** repository only because every fixture is
  synthetic and non-sensitive. No customer, private or contradictory content may
  ever be committed.
- Any baseline change requires an explicit update command, a visible diff in
  review and a stated reason.
- CI never auto-updates a baseline. A failing snapshot is investigated, never
  refreshed to green.
- The harness must first fail on an intentional canary change before its
  baselines are trusted.

## Reproducing

```bash
E2E_BASE_URL=http://localhost:8080 npx playwright test --config=playwright.visual.config.ts
```

Baseline updates are explicit (`--update-snapshots`) and must be reviewed.
