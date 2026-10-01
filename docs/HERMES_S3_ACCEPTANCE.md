# Hermes / real-provider S3 acceptance

Use this bounded procedure to validate a selected production S3-compatible object-store provider before a customer rollout. It supplements CI's authenticated SeaweedFS coverage; it does not convert SeaweedFS interoperability into a claim about another provider.

## Safety boundaries

- Use provider credentials explicitly authorized for this validation.
- Prefer dedicated **source-validation** and **recovery-validation** buckets. Never point this procedure at a bucket containing production/customer objects.
- The provider probe creates and deletes one uniquely named temporary object. It does not create or delete buckets and it does not list bucket contents.
- The recovery exercise must use a separate empty recovery database and separate empty recovery bucket. Never restore over the source deployment.
- Do not delete the source deployment, source bucket or source database as part of the recovery proof.
- Workspace logical backup files contain attachment bytes and are not encrypted. Store and dispose of them according to the customer's data-handling policy.

## Record before starting

Record the exact Workspace commit, provider/product and version or service tier, endpoint/region, path-style setting, source-validation bucket, recovery-validation bucket, host OS/Docker versions, and test date. Do not record access keys or secrets in the report.

## 1. Provider capability probe

Configure the selected source-validation bucket:

```dotenv
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://s3.example.internal
S3_BUCKET=workspace-validation-source
S3_REGION=us-east-1
S3_ACCESS_KEY=<validation-service-access-key>
S3_SECRET_KEY=<validation-service-secret>
S3_FORCE_PATH_STYLE=true
```

Then run:

```bash
npm ci
npm run verify:s3-provider -- --write-test
```

Required result:

- bucket health/authentication passes;
- a unique object can be written and read byte-for-byte;
- a second PUT to the same key is rejected and the original object is unchanged;
- the probe object can be deleted;
- a read after delete returns object-not-found.

The command deliberately requires `--write-test` so an operator cannot accidentally treat it as read-only.

## 2. Source deployment on the selected provider

Use a disposable Workspace deployment with the selected source-validation bucket. Generate a fresh deployment environment and then set the S3 values above before startup.

```bash
node scripts/init-env.mjs
docker compose up --build -d
docker compose ps
curl --fail http://localhost:8080/ready
node scripts/test-deployment.mjs
```

The deployed Chromium workflow must pass through Caddy while the API is configured for the selected S3 provider. The workflow includes an authenticated attachment upload/read and permission checks, so this proves that the application—not only the standalone probe—can use the provider.

Restart the source deployment and repeat readiness plus a targeted browser/file check to prove object persistence across application/container restart.

## 3. Logical backup from the source provider

Keep the source bucket intact. Stop Workspace writers at a maintenance boundary and create a new backup file:

```bash
mkdir -p backups
docker compose stop api collab worker
docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts backup /backups/s3-provider-acceptance.json
docker compose start api collab worker
```

The backup must complete without missing-object, authentication or checksum errors.

## 4. Isolated recovery deployment

Create a separate recovery deployment using:

- fresh PostgreSQL and application volumes;
- unused host ports;
- the **same application/schema version** and original `ENCRYPTION_KEY`;
- the separate empty recovery-validation bucket;
- no reference to the source database or source bucket.

Start only the recovery database/cache and migration service, restore the archive, then start the application:

```bash
docker compose up -d postgres valkey
docker compose run --rm migrate
docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts restore /backups/s3-provider-acceptance.json
docker compose up -d
```

Required result:

- restore completes into the empty recovery database/bucket;
- sign-in and canonical page content are recovered;
- the restored attachment downloads with the original bytes;
- table/board data and history remain available;
- two-browser collaboration still works;
- the source deployment remains healthy and its objects remain readable.

## 5. Negative checks

Against disposable validation resources only, confirm:

- wrong object-store credentials fail readiness/provider acceptance;
- an existing recovery object key is not overwritten;
- restoring into a nonempty application database is refused;
- a backup with a corrupted attachment checksum is refused.

Do not weaken bucket privacy, TLS verification, database RLS or Workspace authentication to make the checks pass.

## Acceptance result

Record **PASS** only when both the application-backed source exercise and separate-bucket recovery exercise succeed on the selected provider. A successful `verify:s3-provider` probe alone establishes API compatibility for the required object operations; it is not the complete recovery acceptance gate.

If the provider does not implement conditional `If-None-Match: *` PUT semantics, treat it as incompatible with the current Workspace immutable-object contract rather than silently disabling overwrite protection.
