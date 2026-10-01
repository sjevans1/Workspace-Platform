import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { oidcFromConfig, oidcFromEnv } from "../packages/auth/oidc.ts";

test("real OIDC client performs discovery, PKCE, nonce validation and verified-email enforcement", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256"),
    { privateKey: untrustedPrivateKey } = await generateKeyPair("RS256"),
    jwk: any = await exportJWK(publicKey);
  jwk.kid = "workspace-test-key";
  jwk.use = "sig";
  jwk.alg = "RS256";

  let issuer = "",
    expectedNonce = "",
    expectedChallenge = "",
    emailVerified = true,
    tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none" =
      "client_secret_basic",
    signWithUntrustedKey = false,
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
        token_endpoint_auth_methods_supported: [tokenAuthMethod],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      tokenRequests++;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      if (tokenAuthMethod === "client_secret_basic") {
        assert.match(String(req.headers.authorization || ""), /^Basic /);
        assert.equal(form.has("client_secret"), false);
      } else {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(form.get("client_id"), "workspace-test-client");
        assert.equal(
          form.get("client_secret"),
          tokenAuthMethod === "client_secret_post"
            ? "workspace-test-secret"
            : null,
        );
      }
      const verifier = form.get("code_verifier") || "",
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
          .sign(signWithUntrustedKey ? untrustedPrivateKey : privateKey);
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
    tokenAuthMethod: process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD,
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

    // Alternate standards-compliant confidential IdPs may require a POST
    // body client secret rather than the Keycloak-tested Basic header.
    tokenAuthMethod = "client_secret_post";
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "client_secret_post";
    emailVerified = true;
    const postProvider = oidcFromEnv();
    assert.ok(postProvider);
    const post = await postProvider.start(redirectUri);
    const postAuth = new URL(post.url);
    expectedNonce = post.nonce;
    expectedChallenge = postAuth.searchParams.get("code_challenge") || "";
    const postProfile = await postProvider.finish(
      new URL(
        `${redirectUri}?code=test-code&state=${encodeURIComponent(post.state)}`,
      ),
      { state: post.state, codeVerifier: post.codeVerifier, nonce: post.nonce },
    );
    assert.equal(postProfile.subject, "oidc-user-subject");
    assert.equal(postProfile.email, "oidc-user@example.test");
    assert.equal(tokenRequests, 3);

    // Discovery must reject a configured method the provider does not
    // advertise, rather than attempting an incompatible token exchange.
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "client_secret_basic";
    const incompatible = oidcFromEnv();
    assert.ok(incompatible);
    await assert.rejects(
      incompatible.start(redirectUri),
      /does not advertise the configured token authentication method/,
    );
    assert.equal(tokenRequests, 3);

    // A public OIDC client can still prove PKCE+nonce without transmitting
    // a client secret. The selected discovery metadata must permit "none".
    tokenAuthMethod = "none";
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "none";
    process.env.OIDC_CLIENT_SECRET = "";
    const publicProvider = oidcFromEnv();
    assert.ok(publicProvider);
    const publicStart = await publicProvider.start(redirectUri);
    expectedNonce = publicStart.nonce;
    expectedChallenge =
      new URL(publicStart.url).searchParams.get("code_challenge") || "";
    const publicProfile = await publicProvider.finish(
      new URL(
        `${redirectUri}?code=test-code&state=${encodeURIComponent(publicStart.state)}`,
      ),
      {
        state: publicStart.state,
        codeVerifier: publicStart.codeVerifier,
        nonce: publicStart.nonce,
      },
    );
    assert.equal(publicProfile.email, "oidc-user@example.test");
    assert.equal(tokenRequests, 4);

    // An otherwise well-formed ID Token with the correct issuer, audience,
    // nonce and advertised kid must not authenticate when signed by a key
    // that does not match the issuer's JWKS. This guards against accepting
    // decoded claims without verifying their cryptographic signature.
    signWithUntrustedKey = true;
    const forgedStart = await publicProvider.start(redirectUri);
    expectedNonce = forgedStart.nonce;
    expectedChallenge = new URL(forgedStart.url).searchParams.get("code_challenge") || "";
    await assert.rejects(
      publicProvider.finish(
        new URL(
          `${redirectUri}?code=test-code&state=${encodeURIComponent(forgedStart.state)}`,
        ),
        {
          state: forgedStart.state,
          codeVerifier: forgedStart.codeVerifier,
          nonce: forgedStart.nonce,
        },
      ),
      /signature|verification|key|JWS|JWT/i,
    );
    assert.equal(tokenRequests, 5);
    signWithUntrustedKey = false;

    // A subsequent correctly signed token still succeeds on this provider.
    const recoveryStart = await publicProvider.start(redirectUri);
    expectedNonce = recoveryStart.nonce;
    expectedChallenge = new URL(recoveryStart.url).searchParams.get("code_challenge") || "";
    const recoveryProfile = await publicProvider.finish(
      new URL(
        `${redirectUri}?code=test-code&state=${encodeURIComponent(recoveryStart.state)}`,
      ),
      {
        state: recoveryStart.state,
        codeVerifier: recoveryStart.codeVerifier,
        nonce: recoveryStart.nonce,
      },
    );
    assert.equal(recoveryProfile.subject, "oidc-user-subject");
    assert.equal(tokenRequests, 6);

    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "client_secret_post";
    process.env.OIDC_CLIENT_SECRET = "";
    assert.throws(
      () => oidcFromEnv(),
      /token endpoint authentication method and client secret must agree/,
    );
    process.env.OIDC_CLIENT_SECRET = "workspace-test-secret";
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "none";
    assert.throws(
      () => oidcFromEnv(),
      /token endpoint authentication method and client secret must agree/,
    );
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "unsupported";
    assert.throws(
      () => oidcFromEnv(),
      /OIDC_TOKEN_ENDPOINT_AUTH_METHOD must be/,
    );
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
    restore("OIDC_TOKEN_ENDPOINT_AUTH_METHOD", saved.tokenAuthMethod);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});


test("explicit OIDC provider configurations are isolated from environment and each other", () => {
  const savedIssuer = process.env.OIDC_ISSUER;
  const savedId = process.env.OIDC_CLIENT_ID;
  const first = oidcFromConfig({
    issuer: "https://id-one.example.test/realms/one",
    clientId: "app-one",
    clientSecret: "secret-one",
    label: "One SSO",
    scopes: ["openid", "email"],
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  const second = oidcFromConfig({
    issuer: "https://id-two.example.test/realms/two",
    clientId: "app-two",
    label: "Two SSO",
    tokenEndpointAuthMethod: "none",
  });
  assert.equal(first.issuer, "https://id-one.example.test/realms/one");
  assert.equal(first.label, "One SSO");
  assert.equal(second.issuer, "https://id-two.example.test/realms/two");
  assert.equal(second.label, "Two SSO");

  try {
    process.env.OIDC_ISSUER = "https://changed-env.example.test";
    process.env.OIDC_CLIENT_ID = "changed-env-client";
    assert.equal(first.issuer, "https://id-one.example.test/realms/one");
    assert.equal(second.issuer, "https://id-two.example.test/realms/two");
  } finally {
    if (savedIssuer === undefined) delete process.env.OIDC_ISSUER;
    else process.env.OIDC_ISSUER = savedIssuer;
    if (savedId === undefined) delete process.env.OIDC_CLIENT_ID;
    else process.env.OIDC_CLIENT_ID = savedId;
  }
  assert.throws(
    () =>
      oidcFromConfig({
        issuer: "https://id-three.example.test",
        clientId: "third",
        clientSecret: "must-not-go-with-none",
        tokenEndpointAuthMethod: "none",
      }),
    /token endpoint authentication method and client secret must agree/,
  );
  assert.throws(
    () =>
      oidcFromConfig({
        issuer: "http://insecure.example.test",
        clientId: "third",
        tokenEndpointAuthMethod: "none",
      }),
    /OIDC issuer must use HTTPS/,
  );
  assert.throws(
    () =>
      oidcFromConfig({
        issuer: "https://id-three.example.test",
        clientId: "third",
        scopes: ["email"],
        tokenEndpointAuthMethod: "none",
      }),
    /OIDC_SCOPES must include openid/,
  );
});
