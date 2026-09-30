import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { oidcFromEnv } from "../packages/auth/oidc.ts";

test("real OIDC client performs discovery, PKCE, nonce validation and verified-email enforcement", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256"),
    jwk: any = await exportJWK(publicKey);
  jwk.kid = "workspace-test-key";
  jwk.use = "sig";
  jwk.alg = "RS256";

  let issuer = "",
    expectedNonce = "",
    expectedChallenge = "",
    emailVerified = true,
    tokenRequests = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", issuer || "http://127.0.0.1");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      tokenRequests++;
      assert.match(String(req.headers.authorization || ""), /^Basic /);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw),
        verifier = form.get("code_verifier") || "",
        actualChallenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "test-code");
      assert.equal(actualChallenge, expectedChallenge);

      const now = Math.floor(Date.now() / 1000),
        idToken = await new SignJWT({
          email: "oidc-user@example.test",
          email_verified: emailVerified,
          name: "OIDC User",
          nonce: expectedNonce,
          sid: "oidc-session-123",
        })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
          .setIssuer(issuer)
          .setAudience("workspace-test-client")
          .setSubject("oidc-user-subject")
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
      return json({
        access_token: "test-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      });
    }
    json({ error: "not_found" }, 404);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  issuer = `http://127.0.0.1:${address.port}/`;

  const saved = {
    issuer: process.env.OIDC_ISSUER,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    label: process.env.OIDC_LABEL,
    insecure: process.env.OIDC_ALLOW_INSECURE,
    verified: process.env.OIDC_REQUIRE_VERIFIED_EMAIL,
  };
  Object.assign(process.env, {
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "workspace-test-client",
    OIDC_CLIENT_SECRET: "workspace-test-secret",
    OIDC_LABEL: "Enterprise SSO",
    OIDC_ALLOW_INSECURE: "true",
    OIDC_REQUIRE_VERIFIED_EMAIL: "true",
  });

  try {
    const provider = oidcFromEnv();
    assert.ok(provider);
    assert.equal(provider.label, "Enterprise SSO");

    const redirectUri = "http://workspace.example.test/api/v1/auth/oidc/callback",
      start = await provider.start(redirectUri),
      auth = new URL(start.url);
    expectedNonce = start.nonce;
    expectedChallenge = auth.searchParams.get("code_challenge") || "";

    assert.equal(auth.origin + "/", issuer);
    assert.equal(auth.searchParams.get("response_type"), "code");
    assert.equal(auth.searchParams.get("redirect_uri"), redirectUri);
    assert.equal(auth.searchParams.get("state"), start.state);
    assert.equal(auth.searchParams.get("nonce"), start.nonce);
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.match(expectedChallenge, /^[A-Za-z0-9_-]{43}$/);

    const profile = await provider.finish(
      new URL(
        `${redirectUri}?code=test-code&state=${encodeURIComponent(start.state)}`,
      ),
      {
        state: start.state,
        codeVerifier: start.codeVerifier,
        nonce: start.nonce,
      },
    );
    assert.deepEqual(profile, {
      issuer,
      subject: "oidc-user-subject",
      email: "oidc-user@example.test",
      name: "OIDC User",
      sid: "oidc-session-123",
    });
    assert.equal(tokenRequests, 1);

    const now = Math.floor(Date.now() / 1000),
      logoutToken = await new SignJWT({
        sid: "oidc-session-123",
        events: {
          "http://schemas.openid.net/event/backchannel-logout": {},
        },
      })
        .setProtectedHeader({
          alg: "RS256",
          kid: jwk.kid,
          typ: "logout+jwt",
        })
        .setIssuer(issuer)
        .setAudience("workspace-test-client")
        .setSubject("oidc-user-subject")
        .setJti("logout-event-123")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey),
      logout = await provider.validateBackchannelLogout(logoutToken);
    assert.equal(logout.issuer, issuer);
    assert.equal(logout.subject, "oidc-user-subject");
    assert.equal(logout.sid, "oidc-session-123");
    assert.equal(logout.jti, "logout-event-123");

    const invalidLogout = await new SignJWT({
      sid: "oidc-session-123",
      nonce: "prohibited",
      events: {
        "http://schemas.openid.net/event/backchannel-logout": {},
      },
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience("workspace-test-client")
      .setSubject("oidc-user-subject")
      .setJti("logout-event-invalid")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    await assert.rejects(
      provider.validateBackchannelLogout(invalidLogout),
      /must not contain nonce/i,
    );

    emailVerified = false;
    const second = await provider.start(redirectUri),
      secondAuth = new URL(second.url);
    expectedNonce = second.nonce;
    expectedChallenge = secondAuth.searchParams.get("code_challenge") || "";
    await assert.rejects(
      provider.finish(
        new URL(
          `${redirectUri}?code=test-code&state=${encodeURIComponent(second.state)}`,
        ),
        {
          state: second.state,
          codeVerifier: second.codeVerifier,
          nonce: second.nonce,
        },
      ),
      /email address is not verified/i,
    );
    assert.equal(tokenRequests, 2);
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("OIDC_ISSUER", saved.issuer);
    restore("OIDC_CLIENT_ID", saved.clientId);
    restore("OIDC_CLIENT_SECRET", saved.clientSecret);
    restore("OIDC_LABEL", saved.label);
    restore("OIDC_ALLOW_INSECURE", saved.insecure);
    restore("OIDC_REQUIRE_VERIFIED_EMAIL", saved.verified);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
