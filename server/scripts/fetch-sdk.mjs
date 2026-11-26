// Fetches Mercura's form SDK packages from Mercura's registry into server/vendor/, which
// the build bundles (minified) into the plugin. vendor/ is not committed: the public
// repository carries only the minified bundle.
//
// Needs read access to npm.pkg.mercura.io (an ~/.npmrc entry with its auth token).
//   node scripts/fetch-sdk.mjs                      newest versions
//   node scripts/fetch-sdk.mjs 1.13.0-r.8 1.28.0    exact versions (form SDK, schemas)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://npm.pkg.mercura.io";
const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, "..", "vendor");
const [sdkVersion = "latest", schemasVersion = "latest"] = process.argv.slice(2);
const wanted = [
  ["@mercura-aps/frontend-form-sdk", sdkVersion, "frontend-form-sdk"],
  ["@mercura-aps/frontend-schemas", schemasVersion, "frontend-schemas"],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mercura-sdk-"));
try {
  for (const [name, version, folder] of wanted) {
    const out = execFileSync("npm", ["pack", `${name}@${version}`, "--registry", REGISTRY, "--pack-destination", tmp, "--json"], {
      encoding: "utf8",
    });
    const { filename, version: got } = JSON.parse(out)[0];
    const dest = path.join(vendor, folder);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(tmp, path.basename(filename)), "-C", dest, "--strip-components=1"]);
    console.log(`${name}@${got} → vendor/${folder}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("Now run: npm install && npm test");
