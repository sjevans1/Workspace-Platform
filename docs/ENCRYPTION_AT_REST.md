# Encryption-at-rest acceptance

OpenJM Workspace uses multiple layers of at-rest protection. Do not use the phrase "encrypted at rest" as a blanket claim unless the deployment evidence covers every durable data location used by that customer.

## Application-enforced encryption

### Logical backup files

New logical backup files are encrypted and authenticated by Workspace before they are written to the backup directory.

- envelope format: `openjm-backup-envelope-v1`;
- cipher: AES-256-GCM;
- key: dedicated 256-bit `BACKUP_ENCRYPTION_KEY`;
- IV: random 96-bit value for each archive;
- authenticated associated data binds the Workspace backup-envelope format;
- wrong key, modified authentication tag or modified ciphertext fails before restore;
- the key is not embedded in the backup file.

The backup key is separate from `ENCRYPTION_KEY`. This prevents backup confidentiality from sharing the same key lifecycle as application-secret encryption.

### Application secrets

`ENCRYPTION_KEY` currently protects stored webhook subscription secrets. It does **not** encrypt arbitrary PostgreSQL rows, page content or attachment files.

Never cite the presence of `ENCRYPTION_KEY` as evidence that the Workspace database or file volume is encrypted.

## Deployment-enforced encryption

The following live data locations must use encryption supplied by the host, storage system or approved cloud provider:

- PostgreSQL data volume;
- local Workspace attachment/file volume;
- Docker/container persistent storage that contains those volumes;
- Caddy persistent data containing private keys;
- host swap/hibernation storage where applicable;
- operator backup directories in addition to application-level backup encryption;
- S3-compatible object storage when selected;
- PostgreSQL physical backups/WAL or object-store snapshots used at larger scale.

Acceptable mechanisms depend on the customer platform, for example full-disk/block-volume encryption, encrypted ZFS datasets, LUKS-class Linux volume encryption, BitLocker-class Windows volume encryption, or provider-managed encrypted block/object storage.

Workspace does not automatically configure the host operating system's disk encryption from inside an application container.

## S3-compatible storage

When an S3-compatible backend is selected, record the provider-specific at-rest encryption control as part of deployment acceptance. The generic S3 API alone does not prove a provider's physical storage encryption policy.

The existing [production S3 acceptance](PRODUCTION_S3_ACCEPTANCE.md) proves Workspace object semantics, isolation and recovery. Provider encryption evidence is an additional deployment record.

## Key custody

`.env` contains encryption material and must not be stored in source control, tickets, chat transcripts or unencrypted shared folders.

For production:

- restrict local file permissions;
- keep a protected recovery copy outside the Workspace host;
- prefer an approved secret manager when the deployment platform supports one;
- separate operational access to backup files from access to `BACKUP_ENCRYPTION_KEY` where practical;
- record key rotation/recovery ownership;
- test recovery before destroying an old key.

Rotating `BACKUP_ENCRYPTION_KEY` does not re-encrypt previously created archives. Retained archives require custody of the key generation that encrypted them.

## Legacy plaintext archives

The restore CLI refuses an old plaintext `openjm-backup-v1` file by default.

A controlled migration may temporarily set:

```dotenv
ALLOW_LEGACY_PLAINTEXT_BACKUP=true
```

Use the flag only for the single restore/migration process. Immediately create a new encrypted backup after recovery and remove the override. Never make this a standing deployment setting.

## Deployment evidence checklist

Before calling a customer deployment encrypted at rest, record non-secret evidence for:

1. the exact Workspace release SHA;
2. the host/storage locations backing PostgreSQL, files, Caddy data and backups;
3. the host/block/filesystem encryption mechanism and its enabled state;
4. the selected S3/object-store encryption control, if applicable;
5. successful creation of an `openjm-backup-envelope-v1` archive;
6. a disposable recovery proving the correct backup key restores and a wrong key fails;
7. backup-key custody/recovery ownership;
8. physical/volume backup and snapshot encryption for any backup path outside the Workspace logical-backup tool.

Do not include encryption keys, passwords, raw backup contents or private infrastructure identifiers in acceptance evidence.

## Current boundary

This slice encrypts Workspace logical backup files and defines the required deployment evidence for live data. It does not perform transparent application-level encryption of every database field or attachment object, and it does not replace full-volume encryption for the live deployment.
