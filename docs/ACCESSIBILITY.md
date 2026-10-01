# Browser accessibility acceptance

This document records the first explicit browser-accessibility hardening slice for OpenJM Workspace.

## Scope of this slice

The current acceptance work focuses on keyboard navigation and basic semantic accessibility across the shared application shell and common dialogs.

### Dialog focus management

The shared `Modal` component now:

- moves focus into the dialog when it opens unless a child already owns focus;
- traps Tab and Shift+Tab within visible, enabled dialog controls;
- closes on Escape;
- restores focus to the element that opened the dialog when it closes;
- remains an `aria-modal="true"` dialog with an accessible name.

Because the behavior is implemented in the shared component, it applies to search, create/import, settings, discussions, version history, permissions and integration dialogs rather than one isolated screen.

Deployed Chromium regression coverage explicitly verifies:

1. the create-dialog name field receives focus;
2. Shift+Tab from the first focusable control wraps to the last;
3. Tab from the last control wraps to the first;
4. Escape closes the dialog;
5. focus returns to the original **New page** button.

## Semantic browser audit

The deployed browser workflow now audits the core home shell, search dialog and Settings surface for deterministic semantic defects:

- visible buttons, links and button-role controls must have an accessible name;
- visible inputs, selects and textareas must have an associated label or ARIA name;
- visible images must carry an `alt` attribute;
- duplicate DOM IDs are rejected.

During implementation this audit exposed the workspace search input as placeholder-only. It now has an explicit `aria-label="Search workspace"`.

The audit deliberately does **not** count placeholder text as a valid form-control label.

## Existing supporting behavior

The interface already includes visible focus outlines for buttons, links and form controls. The main application uses a `<main>` landmark, dialogs carry ARIA dialog semantics, and icon-only controls generally use explicit ARIA labels.

## Boundary and remaining work

This slice is not a claim of WCAG conformance or a complete accessibility certification. Remaining work includes:

- formal rule-engine coverage such as axe-core;
- manual screen-reader testing;
- complete keyboard coverage for every editor/database interaction;
- heading/landmark review across every route and state;
- color contrast verification for all runtime branding combinations;
- reduced-motion and zoom/reflow acceptance;
- Firefox and WebKit accessibility/browser acceptance;
- customer-specific accessibility requirements and external audit where required.

The current goal is to make common keyboard/dialog failures and basic semantic regressions impossible to merge unnoticed, then expand coverage deliberately rather than treating one automated scan as certification.
