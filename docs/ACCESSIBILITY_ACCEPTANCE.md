# Browser and accessibility acceptance

This slice strengthens keyboard and semantic accessibility without claiming a complete WCAG certification.

## Shared modal behaviour

All Workspace dialogs use the shared `Modal` component. The component now:

- moves focus into the modal when it opens;
- traps Tab and Shift+Tab inside the dialog;
- closes on Escape;
- restores focus to the element that opened the dialog;
- retains `role="dialog"`, `aria-modal="true"` and an accessible dialog name.

Because this behavior lives in the shared primitive, create/import, search, discussion, history, settings and credential dialogs inherit the same focus boundary.

## Semantic browser checks

The focused browser acceptance checks visible interactive controls for a usable accessible name, images for an `alt` attribute, duplicate element IDs, and visible dialogs for modal/name semantics.

This is a regression screen for common accessibility failures, not a replacement for a full automated WCAG rules engine or manual assistive-technology review.

## Browser engines and viewports

The existing full production workflow continues to run in Chromium. The focused accessibility and keyboard compatibility suite now runs against a named engine × viewport matrix:

- engines: Chromium, Firefox, WebKit;
- viewports: desktop `1440x1000`, tablet `820x1180`, phone `390x844`, with a pinned locale, timezone and `deviceScaleFactor: 1`.

It verifies authenticated startup, keyboard opening of a dialog, focus containment, Tab/Shift+Tab wrapping, Escape close + focus restoration, search-dialog focus and arrow navigation, and the semantic regression checks, on every engine at every viewport.

The focused compatibility suite runs against the same deployed Docker/Caddy application used by the main acceptance job.

**Linux WebKit is an engine-compatibility proxy. It is NOT Safari on macOS or iOS, and no real-device Safari coverage is claimed.**

## WCAG-oriented closure matrix (X1)

Automated tooling cannot establish WCAG compliance. This matrix separates three lanes so the claim matches what actually ran.

| Surface | Automatable in CI (this lane) | Browser engines | Manual assistive-technology review |
| --- | --- | --- | --- |
| Keyboard-only use of core journeys | Yes, `accessibility.spec.ts` | Chromium, Firefox, WebKit | No |
| Modal focus trapping, Escape and focus restoration | Yes | Chromium, Firefox, WebKit | No |
| Accessible names for controls | Yes (semantic check) | Chromium, Firefox, WebKit | No |
| Duplicate element IDs and image alt text | Yes (semantic check) | Chromium, Firefox, WebKit | No |
| Search dialog focus and arrow navigation | Yes | Chromium, Firefox, WebKit | No |
| Named viewport matrix | Yes | 3 engines × 3 viewports | Partly |
| Focus order on real assistive technology | No | n/a | Yes, not performed here |
| Editor toolbar and table announcement quality | Partly | n/a | Yes, not performed here |
| Colour contrast across branding combinations | No (not in this lane) | n/a | No |

Honest boundaries:

- Linux WebKit is an engine-compatibility proxy. It is NOT Safari on macOS or iOS, and no real-device Safari coverage is claimed.
- No screen-reader (NVDA/JAWS/VoiceOver) run was performed for this tranche. The manual lane is declared out of scope here rather than implied.
- Colour-contrast token tests and reduced-motion checks are not part of this lane; they remain follow-on work.
- The phone-width finding: the "Search anything" trigger lives in the collapsible navigation at `390x844`, so the journey opens the navigation first. That is documented viewport behaviour, not an engine defect, and it was confirmed to fail identically on Chromium, Firefox and WebKit before the viewport-aware adjustment.

## Remaining accessibility/browser work

This slice does not yet close:

- complete screen-by-screen WCAG audit;
- screen-reader testing (the manual assistive-technology lane below is explicitly not performed here);
- full keyboard traversal of every application control;
- colour-contrast verification across every branding combination;
- deterministic visual-regression baselines (X2);
- reduced-motion/high-contrast platform testing.

Those remain separate follow-on work.
