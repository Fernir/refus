"use strict";

/**
 * @vscode/ripgrep resolves rg at runtime to @vscode/ripgrep-<platform>-<arch>.
 * npm only installs optional deps for the host OS, so the VSIX would miss other platforms.
 * This installs every optional platform package (npm install --force) so vsce packs them all.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const rgManifest = path.join(root, "node_modules", "@vscode", "ripgrep", "package.json");

if (!fs.existsSync(rgManifest)) {
  console.warn("ensure-all-ripgrep-platforms: @vscode/ripgrep not installed yet, skip.");
  process.exit(0);
}

const rgPkg = require(rgManifest);
const optional = rgPkg.optionalDependencies || {};
const pairs = Object.entries(optional).filter(([name]) =>
  name.startsWith("@vscode/ripgrep-")
);

if (pairs.length === 0) {
  console.warn("ensure-all-ripgrep-platforms: no optional @vscode/ripgrep-* entries, skip.");
  process.exit(0);
}

const spec = pairs.map(([name, ver]) => `${name}@${ver}`).join(" ");
const cmd = `npm install --no-save --force --no-audit --no-fund ${spec}`;

execSync(cmd, { stdio: "inherit", cwd: root, env: process.env });
