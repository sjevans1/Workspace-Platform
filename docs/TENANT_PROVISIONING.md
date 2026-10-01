# Operational tenant provisioning

Production customer onboarding should use the operator provisioning command rather than direct database edits.

By default, signed-in Workspace administrators **cannot** create new organisations. The deployment setting `ALLOW_SELF_SERVICE_ORGANISATIONS=false` is the default. Set it to `true` only for deployments that intentionally want SaaS-style self-service tenant creation.

## What the operator command creates

A successful provisioning run atomically creates:

- one organisation;
- one owner membership;
- one root workspace;
- an append-only `tenant.provisioned` audit event.

The command uses the owner database credential through `MIGRATION_DATABASE_URL`. It does not print passwords or database credentials.

## New owner with a local password

Pass the password only through the process environment:

```bash
docker compose --profile ops run --rm \
  -e WORKSPACE_PROVISION_OWNER_PASSWORD='use-a-secret-source-here' \
  ops npm run provision:tenant -- \
  --organisation "Acme Jamaica" \
  --workspace "Acme HQ" \
  --owner-name "Jane Owner" \
  --owner-email "jane@example.com"
```

Do not place the password in the command arguments, shell history, tickets or chat.

The password must satisfy the normal Workspace password policy. The command stores only the scrypt password hash.

## New passwordless SSO owner

Use this mode only when deployment-level OIDC is already configured and the identity provider returns a verified email matching the owner account:

```bash
docker compose --profile ops run --rm ops npm run provision:tenant -- \
  --organisation "Acme Jamaica" \
  --workspace "Acme HQ" \
  --owner-name "Jane Owner" \
  --owner-email "jane@example.com" \
  --passwordless-owner
```

This creates no local password. The existing OIDC account-linking flow can then link the verified IdP identity by email.

## Reusing an existing global Workspace user

Workspace users are global identities and memberships are tenant-scoped. Reusing an existing user as the owner of another organisation is blocked by default so an operator cannot accidentally attach the wrong person to a customer tenant.

After independently verifying the account, rerun with:

```bash
docker compose --profile ops run --rm ops npm run provision:tenant -- \
  --organisation "Second Organisation" \
  --workspace "Second HQ" \
  --owner-name "Jane Owner" \
  --owner-email "jane@example.com" \
  --allow-existing-user
```

The command preserves the existing user's password/SSO credentials and creates only the new tenant membership and workspace.

## Optional starter content

Add `--demo` to seed the same starter workspace content used by first-run setup. Customer production provisioning should normally omit this unless the starter content is explicitly wanted.

## Safety and failure behaviour

The provisioning transaction is serialized with an advisory lock and rolls back if any required step fails. The command refuses:

- a duplicate organisation name;
- a service principal as owner;
- an existing user unless `--allow-existing-user` is explicit;
- a new owner without either a password or `--passwordless-owner`;
- simultaneous password and passwordless-owner modes.

The successful command prints only non-secret identifiers and the owner mode. Record the exact Workspace Git SHA and returned tenant/workspace IDs in the deployment record.

## Self-service organisation creation

For deployments that deliberately want signed-in owners/admins to create additional organisations from Settings, set:

```dotenv
ALLOW_SELF_SERVICE_ORGANISATIONS=true
```

Restart the API/web deployment after changing the value. When disabled, the API returns HTTP 403 for `POST /api/v1/organisations` and the **New organisation** button is not shown.

Self-service creation is not a substitute for the operator customer-onboarding path: it creates a tenant membership for the current user but does not represent a controlled external customer provisioning record.
