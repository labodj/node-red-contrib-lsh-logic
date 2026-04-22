import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageJsonPath = resolve(repoRoot, "package.json");
const versionModulePath = resolve(repoRoot, "src/version.ts");
const mode = process.argv.includes("--check") ? "check" : "write";

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageVersion = packageJson.version;

if (typeof packageVersion !== "string" || packageVersion.trim() === "") {
  throw new Error("package.json must expose a non-empty string version.");
}

const nextVersionModule = `/**
 * Runtime package version published through Home Assistant discovery metadata.
 * This file is generated from \`package.json\` by \`npm run sync:version\`.
 */
export const PACKAGE_VERSION = ${JSON.stringify(packageVersion)};
`;

let currentVersionModule = "";
try {
  currentVersionModule = readFileSync(versionModulePath, "utf8");
} catch (error) {
  if ((error && typeof error === "object" && "code" in error && error.code === "ENOENT") !== true) {
    throw error;
  }
}

if (currentVersionModule === nextVersionModule) {
  process.exit(0);
}

if (mode === "check") {
  console.error(
    "src/version.ts is out of sync with package.json. Run `npm run sync:version` to regenerate it.",
  );
  process.exit(1);
}

if (currentVersionModule !== nextVersionModule) {
  writeFileSync(versionModulePath, nextVersionModule, "utf8");
}
