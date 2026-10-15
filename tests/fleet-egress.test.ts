// W29-P0/A2: the operator egress plane.
//
// The fleet console answers "why can this customer not reach their mail server?"
// without touching tenant data. This covers the posture read, the diagnostic that
// shares its evaluator with the customer endpoint check, the audit record, and the
// read-only boundary: there is no route on this plane that could change policy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  buildFleetService,
  ensureFleetSchema,
  fleetConfig,
} from "../apps/fleet/src/fleet.ts";
import { setEgressResolverForTesting } from "../packages/connectors/egress-runtime.ts";

const TOKEN = "fleet-operator-token-0123456789";
const PUBLIC_IP = "93.184.216.34";

const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 4,
});
let app: any;

const config = fleetConfig({
  FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
  FLEET_OPERATOR_TOKEN: TOKEN,
  FLEET_ENCRYPTION_KEY: "fleet-encryption-key-0123456789abcdef",
});

before(async () => {
  await ensureFleetSchema(pool);
  await pool.query("DELETE FROM fleet_audit");
  app = buildFleetService(pool, config);
  await app.ready();
});

after(async () => {
  setEgressResolverForTesting(null);
  await app?.close();
  await pool.end();
});

const operator = (path: string) =>
  app.inject({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${TOKEN}` },
  });

const diagnostic = async (
  host: string,
  port: number,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) =>
  app.inject({
    method: "GET",
    url: `/egress/diagnostic?host=${encodeURIComponent(host)}&port=${port}`,
    headers,
  });

test("A2 operator egress: the posture and diagnostic require the operator credential", async () => {
  for (const path of [
    "/egress",
    "/egress/diagnostic?host=mail.example.test&port=443",
  ]) {
    const denied = await app.inject({ method: "GET", url: path });
    assert.equal(denied.statusCode, 401, path);
    assert.match(denied.body, /Fleet operator credential required/);
  }
});

test("A2 operator egress: the posture reports identity and classes, never the policy body", async () => {
  const response = await operator("/egress");
  assert.equal(response.statusCode, 200, response.body);
  const posture = response.json().posture;
  assert.match(posture.policy.fingerprint, /^[0-9a-f]{24}$/);
  assert.equal(posture.policy.version, "1.0.0");
  assert.equal(typeof posture.policy.public_pinned, "boolean");
  assert.equal(typeof posture.policy.internal_rules, "number");
  assert.equal(typeof posture.policy.internal_trust_chain, "boolean");
  assert.ok(posture.never_reachable.includes("metadata"));
  assert.ok(posture.never_reachable.includes("loopback"));
  assert.ok(posture.never_reachable.includes("carrier_grade"));
  assert.deepEqual(posture.overridable, ["private", "unique_local"]);
  assert.equal(posture.preflight.contacts_endpoint, false);
  assert.equal(posture.preflight.dns_only, true);
  // No policy body, no rule contents, no CA material, no tenant or deployment data.
  assert.ok(
    !/"cidr"|ca_pem|CONNECTOR_EGRESS|BEGIN CERTIFICATE/.test(response.body),
  );
  assert.ok(!/deployment|tenant/i.test(response.body));
});

test("A2 operator egress: the diagnostic answers with the shared vocabulary", async () => {
  setEgressResolverForTesting(async () => [{ address: PUBLIC_IP, family: 4 }]);
  const ready = await diagnostic("mail.example.test", 443);
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().readiness.state, "ready");
  assert.equal(ready.json().readiness.contacted, false);
  assert.ok(!ready.body.includes(PUBLIC_IP), "no raw address is returned");

  setEgressResolverForTesting(async () => [{ address: "10.4.5.6", family: 4 }]);
  const internal = await diagnostic("mail.internal.example", 993);
  assert.equal(internal.json().readiness.state, "private_requires_approval");
  assert.match(internal.json().readiness.next_action, /operator/i);

  setEgressResolverForTesting(async () => [
    { address: "169.254.169.254", family: 4 },
  ]);
  const metadata = await diagnostic("metadata.example.test", 443);
  assert.equal(metadata.json().readiness.state, "blocked_by_operator_policy");
  assert.ok(!metadata.body.includes("169.254.169.254"));

  setEgressResolverForTesting(async () => [{ address: PUBLIC_IP, family: 4 }]);
  const badPort = await diagnostic("mail.example.test", 22);
  assert.equal(badPort.json().readiness.state, "unsupported_port");
  const badHost = await diagnostic("localhost", 443);
  assert.equal(badHost.json().readiness.state, "invalid_destination");
  const emptyPort = await diagnostic("mail.example.test", 0);
  assert.equal(emptyPort.json().readiness.state, "unsupported_port");
});

test("A2 operator egress: every diagnostic is audited with a bounded, non-secret detail", async () => {
  setEgressResolverForTesting(async () => [{ address: "10.4.5.6", family: 4 }]);
  await diagnostic("mail.internal.example", 993);
  const rows = await pool.query(
    "SELECT action,deployment_id,detail FROM fleet_audit WHERE action='egress.diagnostic' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].deployment_id, null);
  const detail = String(rows.rows[0].detail);
  assert.match(
    detail,
    /^private_requires_approval mail\.internal\.example:993$/,
  );
  assert.ok(
    !/10\.4\.5\.6/.test(detail),
    "the audit detail carries no raw address",
  );
  assert.ok(detail.length <= 64);
});

test("A2 operator egress: the plane is read-only", async () => {
  // No mutation surface exists on the egress plane: policy is deployment
  // configuration, and the console is read-only by construction.
  for (const url of ["/egress", "/egress/diagnostic", "/egress/policy"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.inject({
        method: method as any,
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
  }
});
