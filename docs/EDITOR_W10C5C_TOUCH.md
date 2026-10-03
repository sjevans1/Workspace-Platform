# W10c5c — Touch-emulated rich editor acceptance

**Draft candidate until exact-head production CI passes.** Parent [W10c5 #102](https://github.com/sjevans1/Workspace-Platform/issues/102) and W10 #74. Builds on accepted [W10c5b PR #105](https://github.com/sjevans1/Workspace-Platform/pull/105), merge `bc621c6`.

## Real deployed device-emulation acceptance

- Use **Chromium Playwright contexts with `hasTouch:true`, `isMobile:true` and device-scale 2**, with a 390×844 phone viewport and 820×1180 tablet viewport. This is touch pointer emulation, not merely resizing desktop Chrome.
- Authenticated page with paragraph + app-owned warning callout + divider is seeded through revision-checked canonical API. A phone touch-taps the paragraph, edits it, and touch-taps the H3 format control.
- The tablet independently opens the same Yjs document, touch-edits the callout, and touch-taps the insert-divider toolbar control. Both connected clients must converge; original rich IDs, warning variant, added divider and visible text must survive server projection and reload.
- Assert no document-level horizontal overflow at each tested width.

## Limits, deliberately explicit

Playwright keyboard.insertText after `tap()` models text composition after touch focus, **not** a native Android or iOS IME. No claim of physical device accessibility, native pinch/drag-reorder or arbitrary screen readers. Native iOS Safari/WebKit and mobile OS interactions remain W25/field gates. Audio/video playback, encrypted binary backup/restore and same-block structural collaboration conflicts remain W10/W19/W23. Workspace standalone; no OpenJM Enterprise AI changes.

## Follow-up from first exact-head CI

The first run #37142245479 passed the new touch test but revealed a flaky older W10c4b concurrent-editor acceptance: one peer's text landed in the heading when its text-click raced with another editor's remote update. The correction retains **concurrent typing and exact-block assertions**, but first prepares and checks both text-node carets before releasing concurrent input. A new exact-head full run is required. No bypass, skip, or reduced expectation.
