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

## Browser engines

The existing full production workflow continues to run in Chromium. A focused compatibility suite now runs against both:

- Chromium;
- Firefox.

It verifies authenticated startup, keyboard opening of a dialog, focus containment, Tab/Shift+Tab wrapping, Escape close + focus restoration, search-dialog focus, and the semantic regression checks.

The focused compatibility suite runs against the same deployed Docker/Caddy application used by the main acceptance job.

## Remaining accessibility/browser work

This slice does not yet close:

- WebKit/Safari engine coverage;
- complete screen-by-screen WCAG audit;
- screen-reader testing;
- full keyboard traversal of every application control;
- color-contrast verification across every branding combination;
- deterministic visual-regression baselines;
- reduced-motion/high-contrast platform testing.

Those remain separate follow-on work.
