// Fetches Mercura's form SDK packages from Mercura's registry into server/vendor/, which
// the build bundles (minified) into the plugin. vendor/ is not committed: the public
// repository carries only the minified bundle.
//
// Needs read access to npm.pkg.mercura.io (an ~/.npmrc entry: a token, or a username and password).
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

const serverRoot = path.join(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mercura-sdk-"));
// ~/.npmrc may send @mercura-aps to GitHub Packages, which wins over --registry.
// This temporary config pins the scope at Mercura's registry. A stale _authToken is
// preferred by npm and hides a working username and password, so a 401 is retried
// without the token. NPM_USER / NPM_PASS override both for one run and are never
// written into the repository.
const homeLines = fs.existsSync(path.join(os.homedir(), ".npmrc"))
  ? fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf8").split("\n").filter((line) => line.includes("npm.pkg.mercura.io") && !line.startsWith("@mercura-aps:"))
  : [];
const fromEnv = process.env.NPM_USER && process.env.NPM_PASS
  ? [
      `//npm.pkg.mercura.io/:username=${process.env.NPM_USER}`,
      `//npm.pkg.mercura.io/:_password=${Buffer.from(process.env.NPM_PASS).toString("base64")}`,
      `//npm.pkg.mercura.io/:email=${process.env.NPM_EMAIL || "npm@mercura.io"}`,
    ]
  : null;
function writeUserConfig(dropToken) {
  const auth = fromEnv ?? homeLines.filter((line) => !dropToken || !line.includes("_authToken"));
  const file = path.join(tmp, dropToken ? "npmrc-password" : "npmrc");
  fs.writeFileSync(file, [`@mercura-aps:registry=${REGISTRY}`, ...auth, ""].join("\n"), { mode: 0o600 });
  return file;
}
function pack(name, version, userConfig) {
  return execFileSync(
    "npm",
    ["pack", `${name}@${version}`, "--registry", REGISTRY, "--userconfig", userConfig, "--pack-destination", tmp, "--json"],
    { encoding: "utf8", cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
}
try {
  for (const [name, version, folder] of wanted) {
    let out;
    try {
      out = pack(name, version, writeUserConfig(false));
    } catch (error) {
      const denied = String(error.stderr ?? "").includes("E401");
      if (!denied || fromEnv || !homeLines.some((line) => line.includes("_password"))) throw error;
      out = pack(name, version, writeUserConfig(true));
    }
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
