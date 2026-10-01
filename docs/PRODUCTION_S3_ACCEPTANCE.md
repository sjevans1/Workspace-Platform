# Production S3/object-store acceptance

Use this procedure to validate the OpenJM Workspace storage contract against the **actual S3-compatible provider selected for a deployment**. It is intentionally different from the CI SeaweedFS test: the acceptance harness does not create or delete buckets and does not need bucket-administration privileges.

## Safety boundary

Use two dedicated, pre-created acceptance buckets:

- one source bucket;
- one separate recovery bucket.

Do not point this harness at a production application database or at a bucket containing customer data unless the operator has explicitly authorized the write test. The harness writes only randomized Workspace-format keys, deletes only those generated keys during cleanup, never deletes buckets, and uses disposable PostgreSQL databases created from `TEST_DATABASE_URL`.

The command refuses to write until this exact confirmation is present:

```bash
export S3_ACCEPT_WRITE_CONFIRMATION=I_UNDERSTAND_THIS_WRITES_TEST_OBJECTS
```

Do not paste provider secrets into chat, tickets, screenshots or CI logs.

## Required provider configuration

The harness requires:

```bash
export TEST_DATABASE_URL='postgres://.../workspace'
export S3_ACCEPT_ENDPOINT='https://object.example.com'
export S3_ACCEPT_ACCESS_KEY='...'
export S3_ACCEPT_SECRET_KEY='...'
export S3_ACCEPT_SOURCE_BUCKET='openjm-workspace-acceptance-source'
export S3_ACCEPT_RECOVERY_BUCKET='openjm-workspace-acceptance-recovery'
export S3_ACCEPT_WRITE_CONFIRMATION=I_UNDERSTAND_THIS_WRITES_TEST_OBJECTS
```

Optional settings:

```bash
export S3_ACCEPT_PROVIDER_LABEL='Provider name'
export S3_ACCEPT_REGION='us-east-1'
export S3_ACCEPT_FORCE_PATH_STYLE='true'
```

If source and recovery use different endpoints or credentials, override them independently with:

- `S3_ACCEPT_SOURCE_ENDPOINT`
- `S3_ACCEPT_SOURCE_REGION`
- `S3_ACCEPT_SOURCE_ACCESS_KEY`
- `S3_ACCEPT_SOURCE_SECRET_KEY`
- `S3_ACCEPT_SOURCE_FORCE_PATH_STYLE`
- the corresponding `S3_ACCEPT_RECOVERY_*` variables.

Real-provider acceptance requires HTTPS. `S3_ACCEPT_ALLOW_INSECURE=true` exists only for isolated test infrastructure such as the disposable SeaweedFS CI service.

## Execute

From the exact Workspace commit being accepted:

```bash
npm ci
npm run accept:s3
```

The harness uses temporary PostgreSQL databases and the two pre-created buckets. A successful run prints a small non-secret JSON result with `"result": "PASS"`.

## What the harness proves

A PASS requires all of the following:

1. source and recovery bucket health checks succeed;
2. the provider endpoint satisfies the HTTPS policy;
3. Workspace conditional object writes enforce `If-None-Match: *` immutability;
4. a logical Workspace backup can read the source objects;
5. restore refuses a colliding destination object instead of overwriting it;
6. recovery occurs into a separate temporary database and separate bucket;
7. canonical Yjs bytes and plain text survive restore;
8. both active and retained-deleted attachment objects survive restore;
9. the source objects remain byte-identical throughout recovery;
10. cleanup is bounded to the randomized object keys created by the run.

The harness deliberately does **not** create or delete buckets. Bucket provisioning, encryption policy, lifecycle rules, object-lock policy, replication, provider-side backups and account IAM remain deployment/provider responsibilities.

## Provider acceptance evidence

Record:

- exact Workspace Git SHA;
- provider product and service tier;
- region/data-residency location;
- whether source/recovery use separate buckets;
- command exit status;
- PASS/FAIL result;
- any provider error name and HTTP status for a failure;
- whether server-side encryption, versioning and lifecycle policies are enabled;
- confirmation that no production/customer objects were modified.

Do not record access keys, secrets, bucket credentials, private endpoints or object contents.

## Stop conditions

Stop and report rather than weakening the test if:

- the provider requires disabling TLS verification;
- conditional `If-None-Match: *` writes are unsupported;
- the source and recovery bucket names are the same;
- the recovery target already contains a generated acceptance key;
- restore would overwrite an existing object;
- cleanup would need to enumerate or delete objects not created by the harness;
- the PostgreSQL target is not disposable.

## CI relationship

GitHub Actions runs this same harness against two pre-created disposable SeaweedFS buckets. That validates the harness and storage contract continuously, but **does not count as acceptance of the selected production provider**. The production-provider item closes only after this procedure passes against that provider.

## Hermes handoff prompt

> Execute `docs/PRODUCTION_S3_ACCEPTANCE.md` against the selected OpenJM Workspace S3-compatible provider using two dedicated pre-created acceptance buckets and a disposable PostgreSQL server. Do not create or delete buckets, do not use production/customer data, do not print secrets, and do not weaken TLS or immutable-write checks. Record the exact Workspace SHA and return PASS / FAIL with only non-secret evidence. If any safety stop condition is reached, stop the affected step and report it instead of bypassing the check.
