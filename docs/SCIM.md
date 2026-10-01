# SCIM 2.0 directory lifecycle

OpenJM Workspace implements tenant-scoped SCIM 2.0 **Users and Groups** for enterprise directory provisioning, offboarding and conservative role synchronization.

Authentication and authorization remain separate. A SCIM connector manages directory-owned user/group state inside exactly one Workspace organisation. It cannot create `owner` or `admin` access, and it cannot silently adopt an existing manually managed membership.

## Provisioning model

Each SCIM connector belongs to exactly one Workspace organisation and has a default provisioned role of `member` or `guest`.

A connector can:

- discover the Workspace SCIM service and User/Group schemas;
- create, list, retrieve, update and delete SCIM-managed Users;
- activate/deactivate SCIM-managed tenant memberships;
- create, list, retrieve, update and delete SCIM Groups;
- synchronize Group membership using SCIM User resource IDs;
- immediately revoke that tenant's Workspace sessions when a User is deactivated or deleted.

Workspace administrators separately decide whether a synchronized SCIM Group should influence Workspace role. Directory-provided group names do not grant roles automatically.

## Create a connector

An organisation owner/admin creates a connector in:

**Settings → Integrations → Directory provisioning (SCIM 2.0)**

Choose:

- connector label;
- default provisioned role: `member` or `guest`.

Workspace returns:

- SCIM base URL: `${APP_URL}/scim/v2`;
- a bearer token beginning with `scim_`.

The raw token is shown once. Workspace stores only its hash. Connector metadata, last-used time and revocation state are visible in Settings. Revoking a connector immediately makes its bearer token unusable.

For rotation, create a replacement connector, configure and verify it at the identity provider, then revoke the old connector.

## Authentication and tenant isolation

SCIM requests use HTTP Bearer authentication:

```http
Authorization: Bearer scim_<secret>
```

The connector lookup establishes one Workspace tenant before any resource operation. SCIM connector, User, Group, Group-member and Group-role-mapping tables use tenant isolation / FORCE RLS under the production runtime role.

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
- `GET /ResourceTypes/Group`
- `GET /Schemas`
- `GET /Schemas/{User-schema-URI}`
- `GET /Schemas/{Group-schema-URI}`

Users:

- `GET /Users`
- `GET /Users/{id}`
- `POST /Users`
- `PUT /Users/{id}`
- `PATCH /Users/{id}`
- `DELETE /Users/{id}`

Groups:

- `GET /Groups`
- `GET /Groups/{id}`
- `POST /Groups`
- `PUT /Groups/{id}`
- `PATCH /Groups/{id}`
- `DELETE /Groups/{id}`

Supported list filters:

- Users: `userName eq "user@example.com"`
- Users: `externalId eq "directory-id"`
- Groups: `displayName eq "Finance"`
- Groups: `externalId eq "directory-group-id"`

The implementation intentionally does not claim the complete SCIM filter grammar, sorting, Bulk, password changes or ETag conditional updates.

## User lifecycle

### Create

A new SCIM User requires an email address through the primary/first `emails` entry or an email-form `userName`.

If `active` is omitted, Workspace provisions the membership **inactive by default**. The directory must explicitly send `active: true` to enable access.

A newly created Workspace user is passwordless unless another supported authentication path later establishes credentials.

The connector's configured default role becomes the SCIM User's **base role**. This base role is retained so Workspace can safely restore it when no administrator-approved Group role mapping applies.

### Existing Workspace identities

Workspace users are global identities; organisation memberships are tenant-specific.

If the same email already exists globally but has no membership in the connector tenant, SCIM may create that tenant membership and mapping.

If a membership already exists in the tenant and has never been SCIM-managed, SCIM returns a conflict rather than silently taking ownership. This also prevents manual users from being inserted into SCIM Groups: Group members must reference live SCIM User resource IDs from the same tenant.

SCIM never manages `owner` or `admin` memberships.

### Attributes

For Users:

- `userName` is immutable after provisioning;
- primary email is immutable after provisioning;
- `displayName`, `externalId` and `active` are mutable.

SCIM display metadata is tenant-scoped and does not overwrite the global Workspace user profile for other organisations.

### Deactivate / reactivate / delete

Sending `active: false`:

1. marks the membership inactive in the connector organisation;
2. deletes active Workspace sessions for that user in that organisation;
3. emits `scim.user.deactivated`.

Other organisations remain untouched.

Sending `active: true` reactivates the tenant membership, but previously revoked sessions remain invalid; the user must authenticate again.

`DELETE /Users/{id}` deactivates the membership, revokes tenant sessions and tombstones the SCIM mapping. It does not delete the global Workspace identity or other-tenant memberships.

## Group lifecycle

SCIM Groups are directory synchronization objects. A Group contains references to live SCIM User resource IDs.

Supported operations include full replacement with PUT and PATCH operations for:

- `displayName`;
- `externalId`;
- `members` add/replace/remove;
- removal of an individual member with a path such as `members[value eq "<scim-user-id>"]`.

Group synchronization **does not activate or deactivate users**. User access lifecycle remains controlled by the SCIM User `active` state.

Deleting a Group removes its role mapping and membership links, tombstones the Group, and recomputes affected users' roles.

## Explicit Group → Workspace role mapping

Synchronized Groups do not change Workspace roles merely because they exist.

An organisation owner/admin chooses mappings in:

**Settings → Integrations → Directory group role mapping**

Each Group may be mapped to:

- no Workspace role;
- `guest`;
- `member`.

`owner` and `admin` are deliberately unavailable.

Role resolution for a SCIM-managed User is deterministic:

1. if any current mapped Group grants `member`, effective role is `member`;
2. otherwise, if any current mapped Group grants `guest`, effective role is `guest`;
3. otherwise, effective role returns to the User's original SCIM base role.

This means explicit `member` mapping wins when multiple mapped Groups conflict, while clearing/removing mappings restores the provisioned baseline. Role recomputation does not change the membership's active/inactive state.

Group mappings affect only SCIM-managed memberships. They are not page/ACL grants.

## PATCH schema

PATCH uses:

```
urn:ietf:params:scim:api:messages:2.0:PatchOp
```

User PATCH supports `active`, `displayName` and `externalId`; `userName` may only repeat its existing value.

Group PATCH supports the Group attributes and membership operations described above.

Operation names are accepted case-insensitively.

## Backup and restore

Logical backups include:

- SCIM connector records and token hashes;
- SCIM User mappings and base roles;
- SCIM Groups;
- Group membership links;
- administrator-approved Group role mappings.

The raw bearer token is never stored in plaintext. Because its hash is restored, an existing raw token held by the identity provider continues to authenticate after a successful restore of the same deployment data.

Protect backup archives because connector hashes and directory mappings are security-sensitive metadata.

## Operational behavior

SCIM responses are returned only after the tenant database transaction commits. For offboarding, a successful response therefore represents committed membership/session state.

The reverse proxy routes `/scim/*` to the API service. Keep SCIM behind the same trusted HTTPS origin as Workspace in production.

Directory audit actions include:

- `scim.user.provisioned`
- `scim.user.activated`
- `scim.user.deactivated`
- `scim.user.updated`
- `scim.user.deleted`
- `scim.group.created`
- `scim.group.updated`
- `scim.group.deleted`

Connector and Group-role-mapping administration also flows through the normal Workspace event/audit path.

## Current boundaries

Not yet implemented:

- automatic IdP group/realm-role claim mapping outside SCIM;
- group-to-page/ACL mapping;
- per-tenant IdP configuration in one shared deployment;
- full SCIM filter grammar;
- sorting;
- Bulk;
- password change;
- ETag conditional updates;
- provider-specific setup automation or compatibility certification for Entra ID, Okta and other directory products.

The role boundary is intentional: external directory data may synchronize membership structure, but privileged Workspace roles and resource ACLs require separate Workspace-admin control.
