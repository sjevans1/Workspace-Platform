// Wave X / X3 (W26): deterministic accent contrast validation.
//
// The primary accent is used for required UI states: the primary button paints
// the accent as a background with white foreground text, and the accent is used
// as an indicator colour against the page surfaces. An accent that cannot carry
// those states makes the product unusable, so it is rejected here rather than
// left to a subjective colour list.
//
// Calculation: WCAG 2.x relative luminance and contrast ratio
//   https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
//   https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
//
// This check rejects unusable accents. It does NOT establish WCAG conformance
// for the product as a whole, and nothing here claims that it does.

/** The supported light surface the product paints on. */
export const LIGHT_SURFACE = "#ffffff";
/**
 * The supported dark surface. The application ships a light theme today; this is
 * validated as well so a dark surface cannot be broken later by an accent that
 * only passes against white.
 */
export const DARK_SURFACE = "#111827";

/** Minimum contrast for accent-as-text / white-text-on-accent (WCAG AA text). */
export const MIN_ACCENT_CONTRAST = 4.5;
/**
 * Minimum contrast for the accent as a non-text UI component against the dark
 * surface (WCAG 1.4.11 non-text contrast). The shipped default accent reaches
 * about 3.37:1 against the dark surface and about 5.21:1 against white, so a
 * flat 4.5 for both would reject the product's own default.
 */
export const MIN_ACCENT_COMPONENT_CONTRAST = 3;

export type Rgb = { r: number; g: number; b: number };

/** Parse #rrggbb (with or without a leading #). Returns undefined when invalid. */
export function parseHexColor(value: string): Rgb | undefined {
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (!rgb) throw new Error(`Not a #rrggbb colour: ${color}`);
  return (
    0.2126 * linearise(rgb.r) +
    0.7152 * linearise(rgb.g) +
    0.0722 * linearise(rgb.b)
  );
}

/** WCAG contrast ratio between two #rrggbb colours. Range 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Problems with an accent as a required UI state colour. Empty when the accent
 * is usable. Messages are actionable and name the required ratio.
 */
export function accentContrastIssues(accent: string): string[] {
  if (!parseHexColor(accent))
    return ["must be a #rrggbb colour value such as #177a64"];
  const issues: string[] = [];
  const light = contrastRatio(accent, LIGHT_SURFACE);
  if (light < MIN_ACCENT_CONTRAST)
    issues.push(
      `must reach at least ${MIN_ACCENT_CONTRAST}:1 against the light surface so the primary button's white text and accent text stay readable; this accent reaches ${light.toFixed(2)}:1`,
    );
  const dark = contrastRatio(accent, DARK_SURFACE);
  if (dark < MIN_ACCENT_COMPONENT_CONTRAST)
    issues.push(
      `must reach at least ${MIN_ACCENT_COMPONENT_CONTRAST}:1 against the dark surface so the accent stays visible as a UI component; this accent reaches ${dark.toFixed(2)}:1`,
    );
  return issues;
}

/** True when the accent can carry the required UI states. */
export function isUsableAccent(accent: string): boolean {
  return accentContrastIssues(accent).length === 0;
}
