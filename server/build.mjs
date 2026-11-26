// Builds the plugin's MCP server into plugins/mercura-config-panel/server/:
//   index.mjs               the plugin's own code, bundled but NOT minified, so it can be read and audited
//   vendor.min.mjs          third-party code, minified: Mercura's frontend-form-sdk and open-source libraries
//   THIRD_PARTY_NOTICES.txt the licence of every package inside vendor.min.mjs
// Customers need only Node 22+: no npm install, no access to Mercura's private registry.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "../plugins/mercura-config-panel");
const outDir = path.join(pluginDir, "server");
const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin/plugin.json"), "utf8"));
const sdk = JSON.parse(fs.readFileSync(path.join(here, "node_modules/@mercura-aps/frontend-form-sdk/package.json"), "utf8"));
const date = new Date().toISOString().slice(0, 10);

// Third-party packages the plugin's own code imports; all of them come from vendor.min.mjs.
const VENDORED = /^(@mercura-aps\/frontend-form-sdk|@modelcontextprotocol\/sdk\/.*|zod|fake-indexeddb\/auto)$/;
const CJS_SHIM = `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);`;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. Third-party code, minified.
const vendor = await build({
  entryPoints: [path.join(here, "src/vendor.ts")],
  outfile: path.join(outDir, "vendor.min.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  metafile: true,
  absWorkingDir: here,
  banner: {
    js: `// Third-party code of the Mercura config-panel Claude plugin ${plugin.version} (${date}): @mercura-aps/frontend-form-sdk ${sdk.version} (Mercura ApS, see LICENSE) and open-source packages (see THIRD_PARTY_NOTICES.txt).\n${CJS_SHIM}`,
  },
  external: ["react", "react-dom", "vue", "use-sync-external-store", "use-sync-external-store/*"],
  logLevel: "warning",
});

// 2. The plugin's own code, readable.
await build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(outDir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(plugin.version) },
  banner: {
    js: `// Mercura config-panel Claude plugin ${plugin.version} (${date}). The plugin's own code; its source is server/src/ in this repository. Third-party code is in vendor.min.mjs.`,
  },
  plugins: [
    {
      name: "vendored",
      setup(b) {
        b.onResolve({ filter: VENDORED }, () => ({ path: "./vendor.min.mjs", external: true }));
      },
    },
  ],
  logLevel: "warning",
});

// 3. Licences of every package bundled into vendor.min.mjs.
const packages = new Map();
for (const input of Object.keys(vendor.metafile.inputs)) {
  const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//) ?? input.match(/^vendor\/([^/]+)\//);
  if (!m) continue;
  const name = m[1].startsWith("@") || input.includes("node_modules") ? m[1] : `@mercura-aps/${m[1]}`;
  if (packages.has(name)) continue;
  const dir = input.slice(0, input.indexOf(m[1]) + m[1].length);
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(here, dir, "package.json"), "utf8"));
  } catch {
    // keep the name only
  }
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].map((f) => path.join(here, dir, f)).find((f) => fs.existsSync(f));
  packages.set(name, {
    version: pkg.version ?? "",
    license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see package",
    text: licenseFile ? fs.readFileSync(licenseFile, "utf8").trim() : "",
  });
}
// The form SDK's own build already contains its dependencies (immer, superjson, ...), so
// they do not show up as separate inputs; list them from its package.json.
for (const dep of Object.keys(sdk.dependencies ?? {})) {
  if (packages.has(dep)) continue;
  const dir = [path.join(here, "node_modules", dep), path.join(here, "vendor/frontend-form-sdk/node_modules", dep)].find((d) => fs.existsSync(d));
  const pkg = dir ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) : {};
  const licenseFile = dir && ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  packages.set(dep, {
    version: `${pkg.version ?? sdk.dependencies[dep]} (inside @mercura-aps/frontend-form-sdk)`,
    license: typeof pkg.license === "string" ? pkg.license : "MIT",
    text: licenseFile ? fs.readFileSync(licenseFile, "utf8").trim() : "",
  });
}
const missing = [...packages].filter(([n, p]) => !n.startsWith("@mercura-aps/") && !p.text).map(([n]) => n);
if (missing.length) console.warn(`  warning: no licence text found for ${missing.join(", ")}`);
const notices = [
  `Third-party software in vendor.min.mjs of the Mercura config-panel Claude plugin ${plugin.version}`,
  "",
  ...[...packages].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, p]) => [
    "=".repeat(78),
    `${name} ${p.version} (${name.startsWith("@mercura-aps/") ? "Mercura ApS, proprietary: see LICENSE" : p.license})`,
    "=".repeat(78),
    name.startsWith("@mercura-aps/") ? "" : p.text || "(no licence file in the package)",
    "",
  ]),
].join("\n");
fs.writeFileSync(path.join(outDir, "THIRD_PARTY_NOTICES.txt"), notices);

for (const f of fs.readdirSync(outDir)) {
  const kib = (fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0);
  console.log(`  ${path.relative(process.cwd(), path.join(outDir, f))}  ${kib} KiB`);
}
console.log(`Built with @mercura-aps/frontend-form-sdk ${sdk.version}; ${packages.size} packages in vendor.min.mjs.`);
