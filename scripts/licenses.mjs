import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8")),
  licenses = new Map(),
  rows = [];
await mkdir("docs/licenses", { recursive: true });
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/")) continue;
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  } catch {
    rows.push(
      `| ${path.split("node_modules/").at(-1)} | ${p.version} | ${p.license || "See upstream package"} | Not installed on this platform |`,
    );
    continue;
  }
  const refs = [];
  for (const name of await readdir(path)) {
    if (!/^(licen[cs]e|notice|copying)([.\-]|$)/i.test(name)) continue;
    try {
      const text = await readFile(join(path, name), "utf8");
      if (text.includes("\u0000")) continue;
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      licenses.set(hash, text);
      refs.push(`[${name}](docs/licenses/${hash}.txt)`);
    } catch {}
  }
  rows.push(
    `| ${pkg.name} | ${pkg.version} | ${String(pkg.license || p.license || "See notice").replaceAll("|", "/")} | ${refs.join(", ") || "See upstream package and bundled dependency files"} |`,
  );
}
for (const [hash, text] of licenses)
  await writeFile(`docs/licenses/${hash}.txt`, text);
const intro = `# Third-party licenses\n\nGenerated from the lockfile and installed, unmodified package notices. Run \`npm ci && npm run licenses\` to refresh. Application code is governed by the root LICENSE; third-party code retains its own license. This inventory includes development tools and platform-optional packages.\n\n## BlockNote boundary\n\nOnly BlockNote Core, React, Mantine and server utilities are used. No @blocknote/xl package is installed or imported. BlockNote files are unmodified; wrappers live in packages/editor and apps/web/components/Editor.tsx. Their MPL-2.0 notices must remain available with distributed bundles. Exact corresponding source: [Core 0.55.0](https://registry.npmjs.org/@blocknote/core/-/core-0.55.0.tgz), [React](https://registry.npmjs.org/@blocknote/react/-/react-0.55.0.tgz), [Mantine](https://registry.npmjs.org/@blocknote/mantine/-/mantine-0.55.0.tgz), [server utilities](https://registry.npmjs.org/@blocknote/server-util/-/server-util-0.55.0.tgz). Keep an internal copy of these source archives when distributing a release.\n\n## Infrastructure\n\nPostgreSQL uses the PostgreSQL License; Valkey uses BSD-3-Clause; Caddy and SeaweedFS use Apache-2.0. Container images carry additional base-system notices. Preserve those notices and generate a container SBOM for each customer release. Node.js includes MIT and third-party notices in its official image.\n\n## npm inventory\n\n| Package | Version | Declared license | Preserved notice |\n|---|---|---|---|\n`;
await writeFile(
  "THIRD_PARTY_LICENSES.md",
  intro + rows.sort().join("\n") + "\n",
);
console.log(`${rows.length} packages, ${licenses.size} distinct notice files`);
