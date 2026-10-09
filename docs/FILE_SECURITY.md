# File malware scanning and upload security

OpenJM Workspace performs malware inspection **before** an uploaded attachment is encrypted, written to local/S3-compatible storage, or published in the `files` table.

This is the production default.

## Upload decision path

For a private attachment upload, Workspace applies the controls in this order:

1. authenticate the caller and recheck write access to the parent resource;
2. enforce the 25 MiB multipart limit;
3. validate the filename extension, declared MIME type and supported file signatures;
4. stream the file bytes to the configured ClamAV `clamd` service with the `INSTREAM` protocol;
5. only a CLEAN result may continue to encrypted object storage and database publication.

An infected result returns HTTP 422 and records a `file.malware_blocked` audit/outbox event against the parent resource. The rejected bytes are not written to the Workspace object store and no file metadata row is created.

If the required scanner is unavailable, times out or returns an unknown/error response, the upload fails closed with HTTP 503. No object or file row is created.

Workspace deliberately does not return the malware signature name to the end user. The response is the generic message `File rejected by malware scanner`.

## Production scanner service

The default Docker deployment builds a small hardened scanner image from the official ClamAV base:

```
FROM ghcr.io/sjevans1/workspace-ci-mirror-clamav@sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578
```

`Dockerfile.clamav` applies current Debian security upgrades during the release build before the image is accepted. ClamAV itself remains on the explicit `1.5.4-debian13-slim` upstream line, while the derived `openjm-workspace-clamav:local` image is the artifact actually SBOMed, vulnerability-scanned and deployed. Signature data is intentionally mutable operational data and is refreshed into the persistent `clamav_db` volume.

The scanner:

- listens only on the private Compose network;
- has no host-published port;
- uses ClamAV's TCP port 3310 internally;
- persists signature data in the `clamav_db` volume;
- runs FreshClam through the official image defaults so signatures can refresh;
- limits streamed uploads to 30 MiB, just above Workspace's 25 MiB application limit;
- participates in API readiness and Prometheus dependency health.

ClamAV's TCP protocol is not authenticated or encrypted. Do not publish port 3310 or route it through Caddy. If the scanner is moved to another host/network, protect that network path with infrastructure controls appropriate to the deployment.

## Configuration

Generated deployments use:

```dotenv
ANTIVIRUS_MODE=required
ANTIVIRUS_HOST=clamav
ANTIVIRUS_PORT=3310
ANTIVIRUS_TIMEOUT_MS=30000
```

Supported modes:

- `required` — production/default; scanner failure blocks uploads and makes API readiness unavailable.
- `disabled` — development/testing only. Workspace refuses to start this mode when `NODE_ENV=production`.

`npm run dev` explicitly defaults to `ANTIVIRUS_MODE=disabled` so workstation development does not require Docker ClamAV.

## Health and monitoring

When antivirus is enabled, API readiness includes the scanner and Prometheus exposes:

```
workspace_dependency_ready{dependency="antivirus"} 1
```

If the scanner is unhealthy this becomes `0` and `/ready` returns unavailable.

The scanner health check uses the clamd `PING` command. File scanning uses NUL-framed `INSTREAM` commands with bounded chunk sizes and timeouts.

## Acceptance evidence

Automated acceptance covers four separate layers:

- protocol-level tests for PING, INSTREAM framing, CLEAN, infected, malformed-response and unavailable-daemon behavior;
- API integration tests proving infected and scanner-unavailable uploads create no file row/object, while infected attempts commit a `file.malware_blocked` audit event;
- deployment CI against the hardened ClamAV release container using a harmless EICAR antivirus test signature and a clean control payload;
- the existing deployed Chromium workflow uploads and downloads a normal private attachment while antivirus is required, proving the clean upload path through the live scanner.

CI also generates a CycloneDX SBOM for the hardened ClamAV runtime image and applies the same fixable HIGH/CRITICAL Trivy policy used for the Workspace application image.

PR #35 final-head Actions run 36823852010 passed 49/49 backend tests, encrypted S3 acceptance, both release-image SBOM/Trivy gates, scanner readiness, live EICAR detection, Workspace API EICAR rejection with no publication, scan counters, clean browser upload/download, raw attachment ciphertext, Chromium + Firefox accessibility and trusted HTTPS/WSS. The slice was squash-merged at `1994cc1f1f749a905bd87d07fe067996cc4b3543`.

## Signature updates and disconnected deployments

Fresh malware signatures are operational data, not application source.

Internet-connected deployments may allow the official FreshClam service to update the persistent `clamav_db` volume.

Disconnected/air-gapped deployments must provide an approved signature-update process, for example an internal mirror or controlled offline transfer. A scanner with stale signatures must not be described as equivalent to an actively updated malware-inspection service.

Monitor signature-update failures through the scanner/container logs and the organisation's normal operational monitoring.

## What this does not claim

This slice provides malware scanning and a reject-before-publish boundary. It does **not** provide:

- a retained forensic quarantine vault;
- sandbox detonation;
- content disarm and reconstruction (CDR);
- retroactive rescanning of already stored attachments when signatures change;
- ICAP or third-party enterprise scanner integration;
- automatic false-positive release workflows;
- resumable uploads.

A future retained-quarantine implementation must use a separate non-downloadable storage boundary and explicit administrative/audit workflow. Do not implement “quarantine” by placing infected content in the normal Workspace attachment store.
