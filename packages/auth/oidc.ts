import * as client from "openid-client";
import { assert } from "../contracts/index.ts";

export type OidcProfile = {
  issuer: string;
  subject: string;
  email: string;
  name: string;
};

export type OidcStart = {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
};

export interface OidcProvider {
  label: string;
  issuer: string;
  start(redirectUri: string): Promise<OidcStart>;
  finish(
    currentUrl: URL,
    expected: { state: string; codeVerifier: string; nonce: string },
  ): Promise<OidcProfile>;
}

export function oidcFromEnv(): OidcProvider | null {
  const rawIssuer = process.env.OIDC_ISSUER?.trim(),
    clientId = process.env.OIDC_CLIENT_ID?.trim(),
    clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();

  if (!rawIssuer && !clientId && !clientSecret) return null;
  assert(rawIssuer && clientId, 500, "OIDC_ISSUER and OIDC_CLIENT_ID are required");

  const issuer = new URL(rawIssuer).href,
    label = process.env.OIDC_LABEL?.trim() || "Single sign-on",
    scopes = (process.env.OIDC_SCOPES || "openid profile email")
      .split(/\s+/)
      .filter(Boolean),
    allowInsecure = process.env.OIDC_ALLOW_INSECURE === "true",
    requireVerifiedEmail = process.env.OIDC_REQUIRE_VERIFIED_EMAIL !== "false";

  assert(scopes.includes("openid"), 500, "OIDC_SCOPES must include openid");
  assert(
    new URL(issuer).protocol === "https:" || allowInsecure,
    500,
    "OIDC issuer must use HTTPS unless OIDC_ALLOW_INSECURE=true",
  );

  let configuration: Promise<client.Configuration> | undefined;
  const getConfiguration = () =>
    (configuration ||= client.discovery(
      new URL(issuer),
      clientId,
      clientSecret || undefined,
      clientSecret
        ? client.ClientSecretBasic(clientSecret)
        : client.None(),
      {
        timeout: 10,
        ...(allowInsecure ? { execute: [client.allowInsecureRequests] } : {}),
      },
    ));

  return {
    label,
    issuer,
    async start(redirectUri) {
      const config = await getConfiguration(),
        state = client.randomState(),
        nonce = client.randomNonce(),
        codeVerifier = client.randomPKCECodeVerifier(),
        codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier),
        url = client.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          scope: scopes.join(" "),
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
      return { url: url.href, state, codeVerifier, nonce };
    },
    async finish(currentUrl, expected) {
      const config = await getConfiguration(),
        tokens = await client.authorizationCodeGrant(config, currentUrl, {
          pkceCodeVerifier: expected.codeVerifier,
          expectedState: expected.state,
          expectedNonce: expected.nonce,
          idTokenExpected: true,
        }),
        claims = tokens.claims();

      assert(claims?.sub, 401, "OIDC response did not include a subject");

      let details: Record<string, unknown> = { ...claims };
      if (tokens.access_token && config.serverMetadata().userinfo_endpoint) {
        const userInfo = await client.fetchUserInfo(
          config,
          tokens.access_token,
          claims.sub,
        );
        details = { ...details, ...userInfo };
      }

      const email =
          typeof details.email === "string"
            ? details.email.trim().toLowerCase()
            : "",
        verified = details.email_verified === true,
        name =
          (typeof details.name === "string" && details.name.trim()) ||
          (typeof details.preferred_username === "string" &&
            details.preferred_username.trim()) ||
          email;

      assert(email, 403, "OIDC account did not provide an email address");
      assert(
        !requireVerifiedEmail || verified,
        403,
        "OIDC email address is not verified",
      );

      return {
        issuer,
        subject: claims.sub,
        email,
        name,
      };
    },
  };
}
