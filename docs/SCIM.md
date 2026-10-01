# SCIM 2.0 directory lifecycle

OpenJM Workspace implements a tenant-scoped SCIM 2.0 **Users** lifecycle for enterprise directory provisioning and offboarding.

This slice intentionally focuses on the security-critical user lifecycle. SCIM Groups and group-to-Workspace-role mapping are not implemented yet.

## Provisioning model

Each SCIM connector belongs to exactly one Workspace organisation.

A connector can:

- discover the Workspace SCIM service;
- create SCIM-managed Workspace users;
- list and retrieve its tenant's SCIM-managed users;
- filter users by `userName eq` or `externalId eq`;
- update supported user attributes;
- activate or deactivate a SCIM-managed membership;
- delete a SCIM-managed resource;
- immediately revoke that tenant's Workspace sessions when the directory deactivates or deletes the user.

A connector cannot provision owner or administrator roles. Its configured default role is either `member` or `guest`.

Workspace does not silently convert an existing manually managed membership into a SCIM-managed membership. This prevents a newly connected directory from unexpectedly taking ownership of an existing privileged/manual account.

## Create a connector

An organisation owner/admin can create a connector in:

**Settings → Integrations → Directory provisioning (SCIM 2.0)**

Choose:

- a connector label;
- default provisioned role: `member` or `guest`.

Workspace returns:

- SCIM base URL: `${APP_URL}/scim/v2`;
- a bearer token beginning with `scim_`.

The raw token is shown once. Store it in the identity provider's secret store. Workspace stores only its hash.

Connector metadata, last-used time and revocation state are visible in Settings. Revoking the connector immediately makes the bearer token unusable.

For token rotation, create a replacement connector, update the identity provider, verify it can authenticate, then revoke the old connector.

## Authentication

SCIM requests use HTTP Bearer authentication:

```http
Authorization: Bearer scim_<secret>
```

The connector lookup establishes exactly one Workspace tenant before any SCIM resource access. The SCIM tables themselves use FORCE RLS under the same tenant isolation model as the rest of Workspace.

Do not send SCIM credentials in query parameters or logs.

## Supported endpoints

Base path:

```
${APP_URL}/scim/v2
```

Discovery:

- `GET /ServiceProviderConfig`
- `GET /ResourceTypes`
- `GET /ResourceTypes/User`
- `GET /Schemas`
- `GET /Schemas/{User-schema-URI}`

Users:

- `GET /Users`
- `GET /Users/{id}`
- `POST /Users`
- `PUT /Users/{id}`
- `PATCH /Users/{id}`
- `DELETE /Users/{id}`

Supported list filters:

- `userName eq "user@example.com"`
- `externalId eq "directory-id"`

The current slice does not implement the full SCIM filter grammar, sorting, Bulk, password changes or ETag concurrency.

## User lifecycle behavior

### Create

A new SCIM user requires an email address supplied through the primary/first `emails` entry or a `userName` that is itself a valid email address.

If `active` is omitted, Workspace provisions the membership **inactive by default**. The directory must explicitly send `active: true` to activate access.

A newly created Workspace user is passwordless unless another supported authentication path later establishes credentials.

The connector's configured default role is applied only on initial membership creation.

### Existing Workspace identities

Workspace users are global identities, while organisation memberships are tenant-specific.

If the same email already exists globally but has no membership in the connector's tenant, SCIM may create the tenant membership and its SCIM mapping.

If a membership already exists in that tenant and has never been SCIM-managed, SCIM returns a conflict rather than silently taking ownership.

Once a membership is SCIM-managed, its active/inactive lifecycle remains under SCIM control even if an administrator later changes the Workspace role. This ensures directory offboarding cannot be blocked merely because the employee was later promoted inside Workspace.

### Attribute boundaries

In this first slice:

- `userName` is immutable after provisioning;
- primary email is immutable after provisioning;
- `displayName` and `externalId` are mutable;
- `active` is mutable.

SCIM display metadata is tenant-scoped and does not overwrite the global Workspace user's display profile for other organisations.

### Deactivate

Sending `active: false` immediately:

1. marks the membership inactive in the connector's organisation;
2. deletes active Workspace sessions for that user **in that organisation**;
3. emits a `scim.user.deactivated` audit event.

A global user may belong to multiple organisations. Deactivation through one tenant's SCIM connector does **not** deactivate memberships or sessions in another tenant.

### Reactivate

Sending `active: true` reactivates the tenant membership. The user must then authenticate normally to obtain a new Workspace session.

Previously revoked sessions do not become valid again.

### Delete

`DELETE /Users/{id}` is a SCIM lifecycle deletion, not deletion of the global Workspace identity.

It:

- deactivates the membership;
- revokes that tenant's active Workspace sessions;
- tombstones the SCIM mapping;
- returns the resource as no longer available through SCIM.

Other-tenant memberships remain untouched.

## PATCH

PATCH uses:

```
urn:ietf:params:scim:api:messages:2.0:PatchOp
```

Supported attributes in this slice:

- `active`
- `displayName`
- `externalId`

`userName` may be repeated only with the same value; changing it is rejected as immutable.

PATCH operation names are accepted case-insensitively.

## Backup and restore

Logical backups include:

- SCIM connector records, including token hashes;
- SCIM user mappings.

The raw bearer token is never stored in plaintext. Because the connector hash is restored, an existing raw token held by the identity provider continues to authenticate after a successful restore of the same deployment data.

Protect backup archives as credentials and directory mappings are security-sensitive metadata.

## Operational behavior

SCIM responses are not released until the tenant database transaction has committed. This is important for offboarding: once the identity provider receives a successful deactivation response, subsequent Workspace requests observe the committed inactive membership/session revocation state.

The reverse proxy routes `/scim/*` to the API service. Keep SCIM behind the same trusted HTTPS origin as Workspace in production.

Audit actions include:

- `scim.user.provisioned`
- `scim.user.activated`
- `scim.user.deactivated`
- `scim.user.updated`
- `scim.user.deleted`
- connector creation/revocation events through the normal Workspace event/audit path.

## Current boundaries

Not yet implemented:

- SCIM Groups;
- group membership synchronization;
- group-to-Workspace-role mapping;
- group-to-page/ACL mapping;
- full SCIM filter grammar;
- sorting;
- Bulk;
- password change;
- ETag conditional updates;
- automatic provider-specific configuration for Entra ID, Okta or other directory products.

The next enterprise identity slice should build Groups and an explicit, conservative mapping policy rather than allowing arbitrary directory groups to create owner/admin access.
