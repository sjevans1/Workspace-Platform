import { z } from "zod";
import { accentContrastIssues } from "./contrast.ts";
const link = z
  .string()
  .max(2048)
  .refine((v) => !v || /^https?:\/\//.test(v) || /^\/(?!\/)/.test(v));
export const brandingSchema = z
  .object({
    productName: z.string().min(1).max(80),
    primaryAccent: z.string().regex(/^#[a-f0-9]{6}$/i),
    logoLight: link,
    logoDark: link,
    favicon: link,
    loginBackground: link,
    supportName: z.string().max(100),
    supportUrl: link,
    legalName: z.string().max(120),
    privacyUrl: link,
    termsUrl: link,
  })
  .strict()
  // Wave X / X3 (W26): an accent that cannot carry the required UI states is
  // rejected here, so both the deployment environment and the organisation
  // branding PATCH are held to the same deterministic requirement.
  .superRefine((value, ctx) => {
    for (const problem of accentContrastIssues(value.primaryAccent))
      ctx.addIssue({ code: "custom", path: ["primaryAccent"], message: problem });
  });
export function defaultBranding(env: NodeJS.ProcessEnv = process.env) {
  return brandingSchema.parse({
    productName: env.PRODUCT_NAME || "OpenJM Workspace",
    primaryAccent: env.PRIMARY_ACCENT || "#177a64",
    logoLight: env.LOGO_LIGHT || "",
    logoDark: env.LOGO_DARK || "",
    favicon: env.FAVICON || "",
    loginBackground: env.LOGIN_BACKGROUND || "",
    supportName: env.SUPPORT_NAME || "Workspace support",
    supportUrl: env.SUPPORT_URL || "",
    legalName: env.LEGAL_NAME || "",
    privacyUrl: env.PRIVACY_URL || "",
    termsUrl: env.TERMS_URL || "",
  });
}

/**
 * Wave X / X3 (W26): build a complete, validated branding object for an
 * ORGANISATION row from partial organisation-level overrides.
 *
 * Authority: this produces only the value stored on an organisation, which
 * applies after sign-in to that organisation. Deployment branding is read from
 * the deployment environment and is never written or overridden here, so no
 * caller of this function can change the sign-in surface or another tenant.
 *
 * Unspecified keys fall back to the deployment defaults, so a stored row is
 * always a complete object valid against the one branding schema. Malformed
 * values (including an accent that cannot carry the required UI states) are
 * rejected by that schema.
 */
export function organisationBranding(
  overrides: Partial<z.infer<typeof brandingSchema>> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return brandingSchema.parse({ ...defaultBranding(env), ...defined });
}
