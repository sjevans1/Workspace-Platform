# Third-party licenses

Generated from the lockfile and installed, unmodified package notices. Run `npm ci && npm run licenses` to refresh. Application code is governed by the root LICENSE; third-party code retains its own license. This inventory includes development tools and platform-optional packages.

## BlockNote boundary

Only BlockNote Core, React, Mantine and server utilities are used. No @blocknote/xl package is installed or imported. BlockNote files are unmodified; wrappers live in packages/editor and apps/web/components/Editor.tsx. Their MPL-2.0 notices must remain available with distributed bundles. Exact corresponding source: [Core 0.55.0](https://registry.npmjs.org/@blocknote/core/-/core-0.55.0.tgz), [React](https://registry.npmjs.org/@blocknote/react/-/react-0.55.0.tgz), [Mantine](https://registry.npmjs.org/@blocknote/mantine/-/mantine-0.55.0.tgz), [server utilities](https://registry.npmjs.org/@blocknote/server-util/-/server-util-0.55.0.tgz). Keep an internal copy of these source archives when distributing a release.

## Infrastructure

PostgreSQL uses the PostgreSQL License; Valkey uses BSD-3-Clause; Caddy and SeaweedFS use Apache-2.0. Container images carry additional base-system notices. Preserve those notices and generate a container SBOM for each customer release. Node.js includes MIT and third-party notices in its official image. ClamAV 1.5.4 is distributed under GNU GPL v2 in the official Cisco-Talos source tree and is shipped here as a separate, unmodified scanner service. Customer release packaging must preserve the image's license/notices and retain or provide access to the exact corresponding ClamAV source for the distributed image version/digest, including applicable bundled-component notices. The npm license generator does not cover this container dependency.

## npm inventory

| Package | Version | Declared license | Preserved notice |
|---|---|---|---|
| @asamuzakjp/css-color | 5.1.11 | MIT | [LICENSE](docs/licenses/bd4539377980dd79.txt) |
| @asamuzakjp/dom-selector | 7.1.1 | MIT | [LICENSE](docs/licenses/7cdf9db3b91cc77b.txt) |
| @asamuzakjp/generational-cache | 1.0.1 | MIT | [LICENSE](docs/licenses/b420627648716006.txt) |
| @asamuzakjp/nwsapi | 2.3.9 | MIT | [LICENSE](docs/licenses/9b0ffd74f2cde752.txt) |
| @aws-sdk/checksums | 3.1001.1 | Apache-2.0 | [LICENSE](docs/licenses/07364a5f7d0177a5.txt) |
| @aws-sdk/client-s3 | 3.1142.0 | Apache-2.0 | [LICENSE](docs/licenses/e345c2ee7df4446e.txt) |
| @aws-sdk/core | 3.978.1 | Apache-2.0 | [LICENSE](docs/licenses/edea91454b811f12.txt) |
| @aws-sdk/credential-provider-env | 3.972.72 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @aws-sdk/credential-provider-http | 3.972.74 | Apache-2.0 | See upstream package and bundled dependency files |
| @aws-sdk/credential-provider-ini | 3.973.17 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @aws-sdk/credential-provider-login | 3.972.79 | Apache-2.0 | See upstream package and bundled dependency files |
| @aws-sdk/credential-provider-node | 3.972.84 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @aws-sdk/credential-provider-process | 3.972.72 | Apache-2.0 | [LICENSE](docs/licenses/2ef1e48ea743d9c8.txt) |
| @aws-sdk/credential-provider-sso | 3.973.16 | Apache-2.0 | [LICENSE](docs/licenses/2ef1e48ea743d9c8.txt) |
| @aws-sdk/credential-provider-web-identity | 3.972.78 | Apache-2.0 | [LICENSE](docs/licenses/2ef1e48ea743d9c8.txt) |
| @aws-sdk/middleware-sdk-s3 | 3.972.77 | Apache-2.0 | [LICENSE](docs/licenses/07364a5f7d0177a5.txt) |
| @aws-sdk/nested-clients | 3.997.46 | Apache-2.0 | See upstream package and bundled dependency files |
| @aws-sdk/signature-v4-multi-region | 3.996.47 | Apache-2.0 | [LICENSE](docs/licenses/07364a5f7d0177a5.txt) |
| @aws-sdk/token-providers | 3.1138.0 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @aws-sdk/types | 3.974.6 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @aws-sdk/xml-builder | 3.972.41 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | [LICENSE](docs/licenses/09e8a9bcec806710.txt) |
| @blocknote/core | 0.55.0 | MPL-2.0 | [LICENSE](docs/licenses/4b89d4518bd135ab.txt) |
| @blocknote/mantine | 0.55.0 | MPL-2.0 | [LICENSE](docs/licenses/4b89d4518bd135ab.txt) |
| @blocknote/react | 0.55.0 | MPL-2.0 | [LICENSE](docs/licenses/4b89d4518bd135ab.txt) |
| @blocknote/server-util | 0.55.0 | MPL-2.0 | [LICENSE](docs/licenses/4b89d4518bd135ab.txt) |
| @bramus/specificity | 2.4.2 | MIT | [LICENSE](docs/licenses/ae842a63dd9bc829.txt) |
| @csstools/color-helpers | 6.1.2 | MIT-0 | [LICENSE.md](docs/licenses/947e32047a166cd0.txt) |
| @csstools/css-calc | 3.4.1 | MIT | [LICENSE.md](docs/licenses/d00d032f517721b4.txt) |
| @csstools/css-color-parser | 4.2.4 | MIT | [LICENSE.md](docs/licenses/d00d032f517721b4.txt) |
| @csstools/css-parser-algorithms | 4.0.1 | MIT | [LICENSE.md](docs/licenses/d00d032f517721b4.txt) |
| @csstools/css-syntax-patches-for-csstree | 1.1.14 | MIT-0 | [LICENSE.md](docs/licenses/947e32047a166cd0.txt) |
| @csstools/css-tokenizer | 4.0.2 | MIT | [LICENSE.md](docs/licenses/d00d032f517721b4.txt) |
| @electric-sql/pglite | 0.5.8 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-age | 0.0.9 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-pg_hashids | 0.0.9 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-pg_ivm | 0.0.9 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-pg_textsearch | 0.0.10 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-pg_uuidv7 | 0.0.9 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-pgtap | 0.0.9 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-pgvector | 0.0.9 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @electric-sql/pglite-socket | 0.2.11 | Apache-2.0 | [LICENSE](docs/licenses/a6cba85bc92e0cff.txt) |
| @emnapi/runtime | 1.11.3 | MIT | [LICENSE](docs/licenses/2088f55c67314984.txt) |
| @emoji-mart/data | 1.2.1 | MIT | [LICENSE](docs/licenses/9acd87e46fa3c7fb.txt) |
| @esbuild/aix-ppc64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/android-arm | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/android-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/android-x64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/darwin-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/darwin-x64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/freebsd-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/freebsd-x64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-arm | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-ia32 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-loong64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-mips64el | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-ppc64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-riscv64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-s390x | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/linux-x64 | 0.28.2 | MIT | See upstream package and bundled dependency files |
| @esbuild/netbsd-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/netbsd-x64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/openbsd-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/openbsd-x64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/openharmony-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/sunos-x64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/win32-arm64 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/win32-ia32 | 0.28.2 | MIT | Not installed on this platform |
| @esbuild/win32-x64 | 0.28.2 | MIT | Not installed on this platform |
| @exodus/bytes | 1.16.0 | MIT | [LICENSE](docs/licenses/dbffd380d59504ba.txt) |
| @fastify/accept-negotiator | 2.1.0 | MIT | [LICENSE](docs/licenses/e2d09f74a77005e8.txt) |
| @fastify/ajv-compiler | 4.0.6 | MIT | [LICENSE](docs/licenses/e2d09f74a77005e8.txt) |
| @fastify/busboy | 3.2.2 | MIT | [LICENSE](docs/licenses/07544f419a647952.txt) |
| @fastify/cookie | 11.1.2 | MIT | [LICENSE](docs/licenses/ba9677e5a34c2738.txt) |
| @fastify/deepmerge | 3.2.1 | MIT | [LICENSE](docs/licenses/9107d3439217d1dc.txt) |
| @fastify/error | 4.2.0 | MIT | [LICENSE](docs/licenses/ec99456b6f97f7e5.txt) |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT | [LICENSE](docs/licenses/e2d09f74a77005e8.txt) |
| @fastify/forwarded | 3.0.2 | MIT | [LICENSE](docs/licenses/9276503e39bdcaad.txt) |
| @fastify/helmet | 13.1.1 | MIT | [LICENSE](docs/licenses/964706cd807eeda8.txt) |
| @fastify/merge-json-schemas | 0.2.1 | MIT | [LICENSE](docs/licenses/a5b84e79d71db5b8.txt) |
| @fastify/multipart | 10.1.2 | MIT | [LICENSE](docs/licenses/ba9677e5a34c2738.txt) |
| @fastify/proxy-addr | 5.1.1 | MIT | [LICENSE](docs/licenses/4ffb54af38f35ca8.txt) |
| @fastify/rate-limit | 11.2.0 | MIT | [LICENSE](docs/licenses/d24d2e5bdc50e739.txt) |
| @fastify/send | 4.1.1 | MIT | [LICENSE](docs/licenses/1756787cdb2b0e68.txt) |
| @fastify/static | 10.1.5 | MIT | [LICENSE](docs/licenses/ba9677e5a34c2738.txt) |
| @fastify/swagger | 9.9.0 | MIT | [LICENSE](docs/licenses/ba9677e5a34c2738.txt) |
| @fastify/swagger-ui | 6.1.1 | MIT | [LICENSE](docs/licenses/e2d09f74a77005e8.txt) |
| @floating-ui/core | 1.8.0 | MIT | [LICENSE](docs/licenses/0e4c9a9b6c71019c.txt) |
| @floating-ui/dom | 1.8.0 | MIT | [LICENSE](docs/licenses/0e4c9a9b6c71019c.txt) |
| @floating-ui/react | 0.27.20 | MIT | [LICENSE](docs/licenses/0e4c9a9b6c71019c.txt) |
| @floating-ui/react-dom | 2.1.9 | MIT | [LICENSE](docs/licenses/0e4c9a9b6c71019c.txt) |
| @floating-ui/utils | 0.2.12 | MIT | [LICENSE](docs/licenses/0e4c9a9b6c71019c.txt) |
| @handlewithcare/prosemirror-inputrules | 0.1.4 | MIT | [LICENSE](docs/licenses/a3b78b4ac5933fd3.txt) |
| @hocuspocus/common | 4.7.0 | MIT | [LICENSE.md](docs/licenses/dce30f7f8fff923e.txt) |
| @hocuspocus/provider | 4.7.0 | MIT | [LICENSE.md](docs/licenses/dce30f7f8fff923e.txt) |
| @hocuspocus/server | 4.7.0 | MIT | [LICENSE.md](docs/licenses/dce30f7f8fff923e.txt) |
| @img/colour | 1.1.0 | MIT | [LICENSE.md](docs/licenses/e2eaa4603c14cb26.txt) |
| @img/sharp-darwin-arm64 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-darwin-x64 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-freebsd-wasm32 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-libvips-darwin-arm64 | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-darwin-x64 | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linux-arm | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linux-arm64 | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linux-ppc64 | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linux-riscv64 | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linux-s390x | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linux-x64 | 1.3.4 | LGPL-3.0-or-later | See upstream package and bundled dependency files |
| @img/sharp-libvips-linuxmusl-arm64 | 1.3.4 | LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-libvips-linuxmusl-x64 | 1.3.4 | LGPL-3.0-or-later | See upstream package and bundled dependency files |
| @img/sharp-linux-arm | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-linux-arm64 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-linux-ppc64 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-linux-riscv64 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-linux-s390x | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-linux-x64 | 0.35.5 | Apache-2.0 | [LICENSE](docs/licenses/73ba74dfaa520b49.txt) |
| @img/sharp-linuxmusl-arm64 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-linuxmusl-x64 | 0.35.5 | Apache-2.0 | [LICENSE](docs/licenses/73ba74dfaa520b49.txt) |
| @img/sharp-wasm32 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | [LICENSE](docs/licenses/73ba74dfaa520b49.txt) |
| @img/sharp-webcontainers-wasm32 | 0.35.5 | Apache-2.0 | Not installed on this platform |
| @img/sharp-win32-arm64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-win32-ia32 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Not installed on this platform |
| @img/sharp-win32-x64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Not installed on this platform |
| @ioredis/commands | 2.0.0 | MIT | [LICENSE](docs/licenses/d6c8d3da280f25f5.txt) |
| @lifeomic/attempt | 3.1.0 | MIT | [LICENSE](docs/licenses/2bfbec382a4ebcc1.txt) |
| @lukeed/ms | 2.0.2 | MIT | [license](docs/licenses/9a9edad7baae5262.txt) |
| @mantine/core | 9.6.3 | MIT | [LICENSE](docs/licenses/61c765e625bc25d5.txt) |
| @mantine/hooks | 9.6.3 | MIT | [LICENSE](docs/licenses/61c765e625bc25d5.txt) |
| @next/env | 16.3.6 | MIT | See upstream package and bundled dependency files |
| @next/swc-darwin-arm64 | 16.3.6 | MIT | Not installed on this platform |
| @next/swc-darwin-x64 | 16.3.6 | MIT | Not installed on this platform |
| @next/swc-linux-arm64-gnu | 16.3.6 | MIT | Not installed on this platform |
| @next/swc-linux-arm64-musl | 16.3.6 | MIT | Not installed on this platform |
| @next/swc-linux-x64-gnu | 16.3.6 | MIT | See upstream package and bundled dependency files |
| @next/swc-linux-x64-musl | 16.3.6 | MIT | See upstream package and bundled dependency files |
| @next/swc-win32-arm64-msvc | 16.3.6 | MIT | Not installed on this platform |
| @next/swc-win32-x64-msvc | 16.3.6 | MIT | Not installed on this platform |
| @pinojs/redact | 0.4.0 | MIT | [LICENSE](docs/licenses/58d4023bfbed5fb5.txt) |
| @playwright/test | 1.63.0 | Apache-2.0 | [LICENSE](docs/licenses/45873d00a0dd2435.txt), [NOTICE](docs/licenses/6d602191187b35b9.txt) |
| @shikijs/types | 4.4.3 | MIT | [LICENSE](docs/licenses/7a9d8d01038aeacf.txt) |
| @shikijs/vscode-textmate | 10.0.2 | MIT | [LICENSE.md](docs/licenses/b5cb7ff7859e7d28.txt) |
| @smithy/core | 3.35.0 | Apache-2.0 | [LICENSE](docs/licenses/07364a5f7d0177a5.txt) |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @smithy/fetch-http-handler | 5.8.0 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @smithy/node-http-handler | 4.12.1 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @smithy/signature-v4 | 5.7.4 | Apache-2.0 | [LICENSE](docs/licenses/d82ceb8cbd004a2d.txt) |
| @smithy/types | 4.19.0 | Apache-2.0 | [LICENSE](docs/licenses/07364a5f7d0177a5.txt) |
| @swc/helpers | 0.5.23 | Apache-2.0 | [LICENSE](docs/licenses/d96eba1f1881334d.txt) |
| @tiptap/core | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-bold | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-bubble-menu | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-code | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-floating-menu | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-italic | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-strike | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-text | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extension-underline | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/extensions | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/pm | 3.31.3 | MIT | [LICENSE](docs/licenses/c96e5ecb55ac5931.txt) |
| @tiptap/react | 3.31.3 | MIT | [LICENSE.md](docs/licenses/c96e5ecb55ac5931.txt) |
| @types/hast | 3.0.5 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/node | 26.6.3 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/pg | 8.23.1 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/react | 19.3.0 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/react-dom | 19.3.0 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/unist | 3.0.3 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/use-sync-external-store | 0.0.6 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @types/use-sync-external-store | 1.5.0 | MIT | [LICENSE](docs/licenses/c2cfccb812fe4821.txt) |
| @typescript/typescript-aix-ppc64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-darwin-arm64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-darwin-x64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-freebsd-arm64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-freebsd-x64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-arm | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-arm64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-loong64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-mips64el | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-ppc64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-riscv64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-s390x | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-linux-x64 | 7.0.2 | Apache-2.0 | [LICENSE](docs/licenses/a7d00bfd54525bc6.txt), [NOTICE.txt](docs/licenses/f5c708b59114507b.txt) |
| @typescript/typescript-netbsd-arm64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-netbsd-x64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-openbsd-arm64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-openbsd-x64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-sunos-x64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-win32-arm64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @typescript/typescript-win32-x64 | 7.0.2 | Apache-2.0 | Not installed on this platform |
| @workspace/web | 0.1.0 | See notice | See upstream package and bundled dependency files |
| abstract-logging | 2.0.1 | MIT | See upstream package and bundled dependency files |
| ajv | 8.20.0 | MIT | [LICENSE](docs/licenses/a05350a88e318e4f.txt) |
| ajv-formats | 3.0.1 | MIT | [LICENSE](docs/licenses/9df3bb69929a3b65.txt) |
| async-mutex | 0.5.0 | MIT | [LICENSE](docs/licenses/afdf40d8e1d2478a.txt) |
| atomic-sleep | 1.0.0 | MIT | [LICENSE](docs/licenses/8d58741278b289a7.txt) |
| avvio | 9.3.0 | MIT | [LICENSE](docs/licenses/0dae13c0bb4d8c6d.txt) |
| balanced-match | 4.0.4 | MIT | [LICENSE.md](docs/licenses/d408f38ffa3355c5.txt) |
| baseline-browser-mapping | 2.11.26 | Apache-2.0 | [LICENSE.txt](docs/licenses/c71d239df91726fc.txt) |
| bidi-js | 1.1.0 | MIT | [LICENSE.txt](docs/licenses/49d4d143fed599de.txt) |
| bowser | 2.14.1 | MIT | [LICENSE](docs/licenses/dfde54fedc270c2a.txt) |
| brace-expansion | 5.0.12 | MIT | [LICENSE](docs/licenses/9c63a23124d68cd3.txt) |
| caniuse-lite | 1.0.30001813 | CC-BY-4.0 | [LICENSE](docs/licenses/fd3a263fe19ed8fa.txt) |
| client-only | 0.0.1 | MIT | See upstream package and bundled dependency files |
| clsx | 2.1.1 | MIT | [license](docs/licenses/9a9edad7baae5262.txt) |
| cluster-key-slot | 1.1.1 | Apache-2.0 | [LICENSE](docs/licenses/0ea1dc735df3fd3f.txt) |
| content-disposition | 3.0.0 | MIT | [LICENSE](docs/licenses/bd47ce7b88c77596.txt) |
| cookie | 1.1.1 | MIT | [LICENSE](docs/licenses/c02110eedc16c711.txt) |
| cookie | 2.0.1 | MIT | [LICENSE](docs/licenses/c02110eedc16c711.txt) |
| crossws | 0.4.12 | MIT | [LICENSE](docs/licenses/7aef9ff475a591e0.txt) |
| css-tree | 3.2.1 | MIT | [LICENSE](docs/licenses/719a251ceca49c05.txt) |
| csstype | 3.2.3 | MIT | [LICENSE](docs/licenses/11d55bd4541c75ee.txt) |
| csv-parse | 7.0.3 | MIT | [LICENSE](docs/licenses/032efe3de772e9f8.txt) |
| csv-stringify | 6.9.0 | MIT | [LICENSE](docs/licenses/032efe3de772e9f8.txt) |
| data-urls | 7.0.0 | MIT | [LICENSE.txt](docs/licenses/528eec83cb836a0a.txt) |
| debug | 4.4.3 | MIT | [LICENSE](docs/licenses/3a61c6c96caf5c1d.txt) |
| decimal.js | 10.6.0 | MIT | [LICENCE.md](docs/licenses/3108b546bcff5d34.txt) |
| denque | 2.1.0 | Apache-2.0 | [LICENSE](docs/licenses/cd9809cec53323a3.txt) |
| depd | 2.0.0 | MIT | [LICENSE](docs/licenses/bd134b41da59e452.txt) |
| dequal | 2.0.3 | MIT | [license](docs/licenses/306fa513e39b23a6.txt) |
| detect-libc | 2.1.2 | Apache-2.0 | [LICENSE](docs/licenses/b40930bbcf80744c.txt) |
| detect-node-es | 1.1.0 | MIT | [LICENSE](docs/licenses/54b32293ea560d22.txt) |
| emoji-mart | 5.6.0 | MIT | [LICENSE](docs/licenses/9acd87e46fa3c7fb.txt) |
| entities | 8.1.0 | BSD-2-Clause | [LICENSE](docs/licenses/cb992345949ccd6e.txt) |
| esbuild | 0.28.2 | MIT | [LICENSE.md](docs/licenses/b40ec5baec7bb34f.txt) |
| escape-html | 1.0.3 | MIT | [LICENSE](docs/licenses/255aa557a1f55224.txt) |
| fast-decode-uri-component | 1.0.1 | MIT | [LICENSE](docs/licenses/27384b39baee4b47.txt) |
| fast-deep-equal | 3.1.3 | MIT | [LICENSE](docs/licenses/7bf9b2de73a6b356.txt) |
| fast-equals | 5.4.3 | MIT | [LICENSE](docs/licenses/c0af1c3e74a891b4.txt) |
| fast-json-stringify | 7.0.1 | MIT | [LICENSE](docs/licenses/b08de5bb7b21f44a.txt) |
| fast-querystring | 1.1.2 | MIT | [LICENSE](docs/licenses/4f8cf48502224399.txt) |
| fast-uri | 3.1.8 | BSD-3-Clause | [LICENSE](docs/licenses/b010b0dfdfdb23d7.txt) |
| fast-uri | 3.1.8 | BSD-3-Clause | [LICENSE](docs/licenses/b010b0dfdfdb23d7.txt) |
| fast-uri | 4.2.1 | BSD-3-Clause | [LICENSE](docs/licenses/b010b0dfdfdb23d7.txt) |
| fastify | 5.12.5 | MIT | [LICENSE](docs/licenses/23c9186385917145.txt) |
| fastify-plugin | 6.0.0 | MIT | [LICENSE](docs/licenses/ba9677e5a34c2738.txt) |
| fastq | 1.20.3 | ISC | [LICENSE](docs/licenses/c3367f6d01a79d36.txt) |
| find-my-way | 9.9.0 | MIT | [LICENSE](docs/licenses/693f9539655acc18.txt) |
| fsevents | 2.3.3 | MIT | Not installed on this platform |
| get-nonce | 1.0.1 | MIT | [LICENSE](docs/licenses/acf3b087b348d2f2.txt) |
| glob | 13.0.6 | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/a49c9ba464796f65.txt) |
| helmet | 8.3.0 | MIT | [LICENSE](docs/licenses/dd282ebd50392cbb.txt) |
| html-encoding-sniffer | 6.0.0 | MIT | [LICENSE.txt](docs/licenses/528eec83cb836a0a.txt) |
| http-errors | 2.0.1 | MIT | [LICENSE](docs/licenses/dcb94ff9b1e037a8.txt) |
| inherits | 2.0.4 | ISC | [LICENSE](docs/licenses/5ffe28e7ade7d8f1.txt) |
| ioredis | 6.0.0 | MIT | [LICENSE](docs/licenses/7c1ed12e0891c08e.txt) |
| ip-address | 10.7.2 | MIT | [LICENSE](docs/licenses/f8d791359a50cbca.txt) |
| ipaddr.js | 2.5.0 | MIT | [LICENSE](docs/licenses/62568a2d1337b771.txt) |
| is-potential-custom-element-name | 1.0.1 | MIT | [LICENSE-MIT.txt](docs/licenses/483acb265f182907.txt) |
| isomorphic.js | 0.2.5 | MIT | [LICENSE](docs/licenses/dd6488c9c1a4ce2d.txt) |
| jose | 6.2.12 | MIT | [LICENSE.md](docs/licenses/8078b0829d6c3e9e.txt) |
| jsdom | 29.1.1 | MIT | [LICENSE.txt](docs/licenses/242d37e7cab25cba.txt) |
| json-schema-ref-resolver | 3.0.0 | MIT | [LICENSE](docs/licenses/0943b637252a9c6f.txt) |
| json-schema-resolver | 3.0.0 | MIT | [LICENSE](docs/licenses/dfc6eb4df78850d3.txt) |
| json-schema-traverse | 1.0.0 | MIT | [LICENSE](docs/licenses/7bf9b2de73a6b356.txt) |
| kleur | 4.1.5 | MIT | [license](docs/licenses/306fa513e39b23a6.txt) |
| lib0 | 0.2.119 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| lib0 | 0.2.119 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| lib0 | 0.2.119 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| lib0 | 0.2.119 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| lib0 | 0.2.119 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| lib0 | 0.2.119 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| lib0 | 1.0.0-rc.22 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| light-my-request | 6.6.0 | BSD-3-Clause | [LICENSE](docs/licenses/c59ffead4ccbc72d.txt) |
| lru-cache | 11.5.3 | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/8a1af140fdfbf5af.txt) |
| lucide-react | 1.48.0 | ISC | [LICENSE](docs/licenses/b495047bd93a9b06.txt) |
| mdn-data | 2.27.1 | CC0-1.0 | [LICENSE](docs/licenses/36ffd9dc085d529a.txt) |
| mime | 3.0.0 | MIT | [LICENSE](docs/licenses/8f2658c03422c408.txt) |
| minimatch | 10.2.6 | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/2c7c5d22ed5a8ee9.txt) |
| minipass | 7.1.3 | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/8a1af140fdfbf5af.txt) |
| ms | 2.1.3 | MIT | [license.md](docs/licenses/1662fae9b5314d11.txt) |
| nanoid | 3.3.19 | MIT | [LICENSE](docs/licenses/da4db1480d9beea3.txt) |
| next | 16.3.6 | MIT | [license.md](docs/licenses/ee765244e2d59f52.txt) |
| oauth4webapi | 3.8.8 | MIT | [LICENSE.md](docs/licenses/81e7b4b0196e8caa.txt) |
| on-exit-leak-free | 2.1.2 | MIT | [LICENSE](docs/licenses/47404ffc18f12678.txt) |
| openapi-types | 12.1.3 | MIT | [LICENSE](docs/licenses/a5b243ddbec533f2.txt) |
| openid-client | 6.8.8 | MIT | [LICENSE.md](docs/licenses/14c5cc0dc21f44ad.txt) |
| orderedmap | 2.1.1 | MIT | [LICENSE](docs/licenses/869c30f368eb0873.txt) |
| parse5 | 8.0.1 | MIT | [LICENSE](docs/licenses/8c535800331e1e44.txt) |
| path-scurry | 2.0.2 | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/8a1af140fdfbf5af.txt) |
| pg | 8.23.0 | MIT | [LICENSE](docs/licenses/192b8f5c96900f04.txt) |
| pg-cloudflare | 1.4.0 | MIT | [LICENSE](docs/licenses/192b8f5c96900f04.txt) |
| pg-connection-string | 2.14.0 | MIT | [LICENSE](docs/licenses/2244b5486c442700.txt) |
| pg-int8 | 1.0.1 | ISC | [LICENSE](docs/licenses/4e8e87ccdfc7e4b4.txt) |
| pg-pool | 3.14.0 | MIT | [LICENSE](docs/licenses/4f15ee7fc2a72082.txt) |
| pg-protocol | 1.16.0 | MIT | [LICENSE](docs/licenses/192b8f5c96900f04.txt) |
| pg-types | 2.2.0 | MIT | See upstream package and bundled dependency files |
| pgpass | 1.0.5 | MIT | See upstream package and bundled dependency files |
| picocolors | 1.1.1 | ISC | [LICENSE](docs/licenses/6582629e29794668.txt) |
| pino | 10.3.1 | MIT | [LICENSE](docs/licenses/d4eb00c3ef2fa54c.txt) |
| pino-abstract-transport | 3.0.0 | MIT | [LICENSE](docs/licenses/31f005ecff86a12a.txt) |
| pino-std-serializers | 7.1.0 | MIT | [LICENSE](docs/licenses/6206673d24786f09.txt) |
| playwright | 1.63.0 | Apache-2.0 | [LICENSE](docs/licenses/45873d00a0dd2435.txt), [NOTICE](docs/licenses/6d602191187b35b9.txt) |
| playwright-core | 1.63.0 | Apache-2.0 | [LICENSE](docs/licenses/45873d00a0dd2435.txt), [NOTICE](docs/licenses/6d602191187b35b9.txt) |
| postcss | 8.5.23 | MIT | [LICENSE](docs/licenses/5be1f3465bba68a6.txt) |
| postgres-array | 2.0.0 | MIT | [license](docs/licenses/f057f36739d53d22.txt) |
| postgres-bytea | 1.0.1 | MIT | [license](docs/licenses/f057f36739d53d22.txt) |
| postgres-date | 1.0.7 | MIT | [license](docs/licenses/f057f36739d53d22.txt) |
| postgres-interval | 1.2.0 | MIT | [license](docs/licenses/f057f36739d53d22.txt) |
| prettier | 3.6.2 | MIT | [LICENSE](docs/licenses/b0f2417199889f1c.txt) |
| process-warning | 4.0.1 | MIT | [LICENSE](docs/licenses/d9726abc9eff9496.txt) |
| process-warning | 5.1.0 | MIT | [LICENSE](docs/licenses/8d3c1dd501e05640.txt) |
| prosemirror-changeset | 2.4.4 | MIT | [LICENSE](docs/licenses/7543dfe82fa61d5b.txt) |
| prosemirror-commands | 1.7.2 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-dropcursor | 1.8.4 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-gapcursor | 1.4.1 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-highlight | 0.15.3 | MIT | [LICENSE](docs/licenses/784abd61b4f27de3.txt) |
| prosemirror-history | 1.5.0 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-inputrules | 1.5.1 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-keymap | 1.2.3 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-model | 1.25.12 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-schema-list | 1.5.1 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-state | 1.4.4 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-tables | 1.8.5 | MIT | [LICENSE](docs/licenses/d1d2046ebbe6362f.txt) |
| prosemirror-transform | 1.12.2 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| prosemirror-view | 1.42.6 | MIT | [LICENSE](docs/licenses/ef0b452ced6304db.txt) |
| punycode | 2.3.1 | MIT | [LICENSE-MIT.txt](docs/licenses/483acb265f182907.txt) |
| quick-format-unescaped | 4.0.4 | MIT | [LICENSE](docs/licenses/5ac141bfc70bec8f.txt) |
| react | 19.3.0 | MIT | [LICENSE](docs/licenses/da6d3703ed11cbe4.txt) |
| react-dom | 19.3.0 | MIT | [LICENSE](docs/licenses/da6d3703ed11cbe4.txt) |
| react-number-format | 5.4.5 | MIT | [LICENSE](docs/licenses/55aaf8cf3f0c0237.txt) |
| react-remove-scroll | 2.7.2 | MIT | [LICENSE](docs/licenses/30f0cfddf483d112.txt) |
| react-remove-scroll-bar | 2.3.8 | MIT | See upstream package and bundled dependency files |
| react-style-singleton | 2.2.3 | MIT | [LICENSE](docs/licenses/30f0cfddf483d112.txt) |
| real-require | 0.2.0 | MIT | [LICENSE.md](docs/licenses/cbf263504e800cf0.txt) |
| real-require | 1.0.0 | MIT | [LICENSE.md](docs/licenses/cbf263504e800cf0.txt) |
| redis-errors | 1.2.0 | MIT | [LICENSE](docs/licenses/43f5ac55d8171ff9.txt) |
| require-from-string | 2.0.2 | MIT | [license](docs/licenses/6ee0feb1f6ef996f.txt) |
| ret | 0.5.0 | MIT | [LICENSE](docs/licenses/bfc2c678db20d806.txt) |
| reusify | 1.1.0 | MIT | [LICENSE](docs/licenses/93a1506953b08ad4.txt) |
| rfdc | 1.4.1 | MIT | [LICENSE](docs/licenses/1ce941682a96c7b8.txt) |
| rope-sequence | 1.3.4 | MIT | [LICENSE](docs/licenses/530424aebdd0e73f.txt) |
| safe-regex2 | 5.1.1 | MIT | [LICENSE](docs/licenses/3871c31d0cc37395.txt) |
| safe-stable-stringify | 2.5.0 | MIT | [LICENSE](docs/licenses/3a6d6de49d284a36.txt) |
| saxes | 6.0.0 | ISC | See upstream package and bundled dependency files |
| scheduler | 0.28.0 | MIT | [LICENSE](docs/licenses/da6d3703ed11cbe4.txt) |
| secure-json-parse | 4.1.0 | BSD-3-Clause | [LICENSE](docs/licenses/d490035c46547ddc.txt) |
| semver | 7.8.5 | ISC | [LICENSE](docs/licenses/4ec3d4c66cd87f5c.txt) |
| set-cookie-parser | 2.7.2 | MIT | [LICENSE](docs/licenses/c5c6c5183a789d12.txt) |
| setprototypeof | 1.2.0 | ISC | [LICENSE](docs/licenses/76d6d1ea0c268da3.txt) |
| sharp | 0.35.5 | Apache-2.0 | [LICENSE](docs/licenses/73ba74dfaa520b49.txt) |
| sonic-boom | 4.2.1 | MIT | [LICENSE](docs/licenses/db5c3795cb080810.txt) |
| source-map-js | 1.2.1 | BSD-3-Clause | [LICENSE](docs/licenses/6cb0631f71c77497.txt) |
| split2 | 4.2.0 | ISC | [LICENSE](docs/licenses/c372ef2fa1dfcb12.txt) |
| standard-as-callback | 2.1.0 | MIT | [LICENSE](docs/licenses/a1de72eb7bdf08c1.txt) |
| statuses | 2.0.2 | MIT | [LICENSE](docs/licenses/512cfa4d5e7a7569.txt) |
| styled-jsx | 5.1.6 | MIT | [license.md](docs/licenses/24d4a4580df855c3.txt) |
| symbol-tree | 3.2.4 | MIT | [LICENSE](docs/licenses/9ea1eccdabe46976.txt) |
| tabbable | 6.5.0 | MIT | [LICENSE](docs/licenses/8e714750725e75c8.txt) |
| tagged-tag | 1.0.0 | MIT | [license](docs/licenses/5c932d88256b4ab9.txt) |
| thread-stream | 4.2.0 | MIT | [LICENSE](docs/licenses/47404ffc18f12678.txt) |
| tldts | 7.4.16 | MIT | [LICENSE](docs/licenses/c64182d48160db94.txt) |
| tldts-core | 7.4.16 | MIT | [LICENSE](docs/licenses/c64182d48160db94.txt) |
| toad-cache | 3.7.4 | MIT | [LICENSE](docs/licenses/644304c533dee964.txt) |
| toidentifier | 1.0.1 | MIT | [LICENSE](docs/licenses/a832d679750e49ab.txt) |
| tough-cookie | 6.0.2 | BSD-3-Clause | [LICENSE](docs/licenses/22ec6791c91ba42c.txt) |
| tr46 | 6.0.0 | MIT | [LICENSE.md](docs/licenses/499d6d466d064e04.txt) |
| tslib | 2.8.1 | 0BSD | [LICENSE.txt](docs/licenses/210b19e543130388.txt) |
| tsx | 4.23.15 | MIT | [LICENSE](docs/licenses/8dded67841a9261a.txt) |
| type-fest | 5.10.0 | (MIT OR CC0-1.0) | [license-cc0](docs/licenses/a2010f343487d3f7.txt), [license-mit](docs/licenses/5c932d88256b4ab9.txt) |
| typescript | 7.0.2 | Apache-2.0 | [LICENSE](docs/licenses/a7d00bfd54525bc6.txt), [NOTICE.txt](docs/licenses/f5c708b59114507b.txt) |
| undici | 7.30.0 | MIT | [LICENSE](docs/licenses/a6db8096b2707bc0.txt) |
| undici-types | 8.9.0 | MIT | [LICENSE](docs/licenses/a6db8096b2707bc0.txt) |
| use-callback-ref | 1.3.3 | MIT | [LICENSE](docs/licenses/30f0cfddf483d112.txt) |
| use-sidecar | 1.1.3 | MIT | [LICENSE](docs/licenses/30f0cfddf483d112.txt) |
| use-sync-external-store | 1.6.0 | MIT | [LICENSE](docs/licenses/da6d3703ed11cbe4.txt) |
| w3c-keyname | 2.2.8 | MIT | [LICENSE](docs/licenses/869c30f368eb0873.txt) |
| w3c-xmlserializer | 5.0.0 | MIT | [LICENSE.md](docs/licenses/ab654de803cdaa9e.txt) |
| webidl-conversions | 8.0.1 | BSD-2-Clause | [LICENSE.md](docs/licenses/a889cc4dbee2ae17.txt) |
| whatwg-mimetype | 5.0.0 | MIT | [LICENSE.txt](docs/licenses/528eec83cb836a0a.txt) |
| whatwg-url | 16.0.1 | MIT | [LICENSE.txt](docs/licenses/db480f236292a093.txt) |
| xml-name-validator | 5.0.0 | Apache-2.0 | [LICENSE.txt](docs/licenses/a6cba85bc92e0cff.txt) |
| xmlchars | 2.2.0 | MIT | [LICENSE](docs/licenses/45d196313c2647d3.txt) |
| xtend | 4.0.2 | MIT | [LICENSE](docs/licenses/82e67379203d5794.txt) |
| y-prosemirror | 1.3.7 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| y-protocols | 1.0.6 | MIT | [LICENSE](docs/licenses/5446db1e43fe52fa.txt) |
| yaml | 2.9.1 | ISC | [LICENSE](docs/licenses/5bba27375d93e911.txt) |
| yjs | 13.6.33 | MIT | [LICENSE](docs/licenses/341baa53605ed85d.txt) |
| zod | 4.6.5 | MIT | [LICENSE](docs/licenses/3f1189b28e3866e0.txt) |
