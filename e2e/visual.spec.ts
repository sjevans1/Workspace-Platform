import { test } from "@playwright/test";

// Wave X X2 will populate the committed, non-sensitive snapshot set here.
//
// X0 ships only the configuration skeleton and the baseline policy
// (docs/VISUAL_REGRESSION.md); no baselines are committed and CI does not run
// this spec yet. The placeholder keeps `playwright.visual.config.ts` valid
// until X2 adds real surfaces, and is explicitly skipped so a stray run cannot
// be mistaken for passing visual coverage.
test.skip("X2 visual baselines are not yet committed", () => {});
