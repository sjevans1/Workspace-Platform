# Encryption at rest

OpenJM Workspace uses layered controls for data at rest. No single application key can replace host/storage encryption for every subsystem.

## Application-managed encryption

### Attachment and object bytes

New Docker deployments set:

```dotenv
STORAGE_ENCRYPTION_MODE=required
```

Workspace encrypts attachment/object bytes before they reach either the local filesystem adapter or an S3-compatible provider.

The envelope uses:

- AES-256-GCM;
- a random 96-bit nonce per object write;
- a storage-specific key derived from `ENCRYPTION_KEY` with HKDF-SHA-256;
- the immutable Workspace object key as authenticated additional data.

The object provider therefore stores ciphertext. MIME type and original size remain in PostgreSQL metadata so downloads can be served correctly after decryption.

`required` mode refuses to read a plaintext object.

### Upgrade mode for existing deployments

Older deployments may contain plaintext objects. Compose therefore defaults to:

```dotenv
STORAGE_ENCRYPTION_MODE=legacy-read
```

only when the setting is absent from an existing `.env`.

In `legacy-read`:

- new writes are encrypted;
- encrypted objects are decrypted normally;
- existing plaintext objects may still be read temporarily.

This is an upgrade state, not the desired final production state.

Stop writers and run the maintenance migration:

```bash
docker compose stop api collab worker

docker compose --profile ops run --rm \
  -e WORKSPACE_MAINTENANCE=true \
  ops node --import tsx scripts/migrate-storage-encryption.ts
```

The migration does not overwrite immutable objects. For each plaintext file it:

1. reads the old object;
2. writes an encrypted replacement under a new immutable object key;
3. atomically repoints the file metadata;
4. records the old plaintext key in the durable object-deletion queue;
5. attempts immediate deletion and leaves retryable cleanup state if deletion fails.

The command is resumable. Already encrypted objects are skipped.

After it reports success, set:

```dotenv
STORAGE_ENCRYPTION_MODE=required
```

and restart Workspace. Do not leave a production deployment in `legacy-read` indefinitely.

### Backup archives

The maintenance backup command writes an encrypted envelope instead of plaintext JSON. The envelope uses AES-256-GCM with a backup-specific key derived from `ENCRYPTION_KEY`.

Restore decrypts the envelope before applying the existing checksum/schema/recovery validation.

Legacy plaintext `openjm-backup-v1` archives remain readable for recovery compatibility, but new CLI backups are encrypted.

Protect backup files with normal filesystem permissions even though the payload is encrypted.

## Existing persisted secret protections

Workspace already avoids reversible plaintext storage where it is unnecessary:

- passwords use scrypt hashes;
- session, invitation, SCIM and service credentials are stored as hashes;
- webhook signing secrets are AES-256-GCM encrypted;
- OIDC client secrets remain deployment environment secrets rather than database values.

The application `ENCRYPTION_KEY` must remain protected and backed up separately from data.

## PostgreSQL encryption

Workspace does **not** encrypt all PostgreSQL columns individually. Doing so would interfere with tenant RLS, search, filtering, relational queries and operational tooling.

Production PostgreSQL data, WAL, temporary files and database backups must therefore reside on encrypted storage provided by the host/platform, for example:

- LUKS/dm-crypt on Linux;
- BitLocker or equivalent encrypted storage on Windows hosts;
- encrypted SAN/NAS volumes;
- an approved cloud/database service with encryption at rest enabled.

This is a deployment acceptance item because an application container cannot reliably prove whether the underlying block device is encrypted.

Record the customer/platform evidence during host acceptance.

## S3-compatible providers

Workspace encrypts object content before upload when storage encryption is enabled. Provider-side server-side encryption may also be enabled as an additional control.

The production S3 acceptance harness runs with `STORAGE_ENCRYPTION_MODE=required` and proves that:

- Workspace reads the original plaintext through its storage adapter;
- the raw provider object is an encrypted envelope;
- restored objects remain encrypted at the recovery provider;
- source objects remain unchanged.

## Key rotation

Automatic online rotation of `ENCRYPTION_KEY` is not implemented yet.

Do not replace the key on an existing deployment without a planned re-encryption procedure. The key protects or derives protection for webhook secrets, collaboration tickets, encrypted object content and backup archives.

Keep a protected recovery copy of the original key for the lifetime of backups encrypted under it.

## Threat boundary

Application-managed encryption protects against disclosure from copied object-store bytes, attachment volumes and backup files without the key.

It does not protect data from a fully compromised running Workspace process or host that can read the live key from memory/environment. Host hardening, least privilege, patching, secret management and monitoring remain required.
