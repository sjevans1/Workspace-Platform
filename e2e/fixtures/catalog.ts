// Wave X (X0) deterministic synthetic fixtures.
//
// Rules (see docs/VISUAL_REGRESSION.md and docs/WAVE_X_IMPLEMENTATION_PLAN.md):
// - fixed titles and values, no timestamps and no randomness in visible content;
// - resource IDs are generated at run time, so any fingerprint or snapshot must
//   never depend on raw ID text;
// - synthetic content only, never customer data.
export const FIXTURE = {
  space: "Wave X fixture space",
  page: "Wave X fixture page",
  database: "Wave X fixture database",
  properties: [
    { id: "name", name: "Name", type: "title" },
    { id: "qty", name: "Qty", type: "number" },
    { id: "note", name: "Note", type: "text" },
  ],
  records: [
    { name: "Fixture row one", qty: 1, note: "alpha" },
    { name: "Fixture row two", qty: 2, note: "beta" },
    { name: "Fixture row three", qty: 3, note: "gamma" },
  ],
  pageBody: "Deterministic fixture page body.",
  // Spaces the workspace seeds at setup. Asserted present before the shell
  // snapshot so the navigation list is provably complete.
  defaultSpaces: ["Company Wiki", "Projects", "Meetings"],
} as const;

export type FixtureCatalog = typeof FIXTURE;
