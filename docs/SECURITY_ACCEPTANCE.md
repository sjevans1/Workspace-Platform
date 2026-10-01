# Adversarial security acceptance

This document records the adversarial checks added after the core tenant/RLS, SSO/SCIM, TLS, storage and monitoring hardening slices.

## Current focus

The active slice targets attack paths that cross trust boundaries:

- invitation-token exposure in browser URLs/referrers;
- unsafe browser embedding/opener behaviour;
- attachment type/signature confusion;
- private-file response hardening;
- webhook redirect/SSRF behaviour;
- existing tenant/session isolation regressions.

## Invitation token handling

Invitation tokens are still carried in the one-time invitation URL because the recipient needs a bootstrap credential. The browser captures the token into in-memory React state on page load and immediately removes the query string from the visible URL.

The token is **not** copied to localStorage or sessionStorage. Reloading before acceptance requires reopening the invitation link. This is intentional: recovery convenience does not justify persistent browser storage of the invitation credential.

The edge now sends:

```
Referrer-Policy: no-referrer
```

so the original invitation URL is not propagated as a Referer header to same-origin or external subrequests.

Deployed Chromium acceptance verifies the query string is removed while the invitation can still be accepted.

## Browser edge headers

The Caddy edge adds:

- `Referrer-Policy: no-referrer`;
- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Resource-Policy: same-origin`;
- `X-Permitted-Cross-Domain-Policies: none`;
- existing HSTS, nosniff, frame and permissions policies.

The web CSP now additionally includes:

```
form-action 'self'
```

The application still requires `'unsafe-inline'` script/style allowances for the current Next.js/editor build. A nonce/hash-based CSP remains separate future hardening; this slice does not claim to close it.

## Private attachments

Uploads remain limited to the documented extension/MIME allowlist. Signature checks cover PNG, JPEG, GIF, WebP, PDF and ZIP-based archive formats. Adversarial unit coverage now explicitly rejects:

- HTML/script uploads by unsupported extension;
- a fake PNG with an invalid signature;
- a text file declared as PNG;
- a fake PDF with an invalid signature.

Private download acceptance also verifies:

- parent authorization is rechecked;
- `X-Content-Type-Options: nosniff`;
- sandboxed `Content-Security-Policy`;
- non-image files are served as attachments.

The active file-security slice adds required ClamAV malware inspection before encrypted storage/publication, with fail-closed scanner outages and blocked-upload audit evidence. It does not add sandbox detonation, retained forensic quarantine or content disarm/reconstruction; those remain separate controls.

## Webhook redirects and SSRF boundary

Webhook destinations require an exact deployment allowlist. Requests are bounded by timeout and response size. The worker uses Node's direct HTTP(S) request path and does not follow redirects.

The adversarial regression starts an allowlisted webhook endpoint that returns HTTP 302 toward an **unallowlisted** local target and proves the target is never contacted. The delivery is recorded for retry rather than following the redirect.

Allowlisting a private/internal origin is still an explicit deployment-administrator trust decision. This test prevents a permitted origin from turning a redirect into an unreviewed second destination.

## Residual security work

This slice does not close every production-security item. Remaining work includes:

- final-head acceptance of required malware scanning; retained quarantine/CDR remain separate future controls;
- nonce/hash-based CSP and removal of `unsafe-inline` where compatible;
- release container/base-OS vulnerability scanning and signed release artifacts;
- broader browser-engine/accessibility coverage;
- customer-specific penetration testing and deployment threat modelling;
- host/OS/network controls outside the application repository.

Security acceptance should continue to fail closed: do not weaken RLS, origin checks, webhook allowlists, TLS verification, upload validation or session revocation merely to make a test environment pass.
