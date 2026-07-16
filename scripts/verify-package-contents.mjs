import { execFileSync } from "node:child_process";

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const packResult = JSON.parse(raw);
const [pack] = Array.isArray(packResult) ? packResult : Object.values(packResult);
const files = pack.files.map((entry) => entry.path).sort();

const allowedFilePatterns = [
  /^README\.md$/,
  /^DOCS\.md$/,
  /^LIFECYCLE\.md$/,
  /^LICENSE$/,
  /^NOTICE$/,
  /^CITATION\.cff$/,
  /^package\.json$/,
  /^dist\/[^.][\w./-]*$/,
  /^docs\/[^.][\w./-]*\.md$/,
  /^examples\/[^.][\w./-]*\.json$/,
  /^images\/[^.][\w./-]*\.(png|jpg|jpeg|webp)$/,
];

const requiredFiles = [
  "README.md",
  "DOCS.md",
  "LIFECYCLE.md",
  "LICENSE",
  "NOTICE",
  "CITATION.cff",
  "package.json",
  "dist/lsh-actuator-sync.js",
  "dist/lsh-actuator-sync.d.ts",
  "dist/lsh-actuator-sync.html",
  "dist/lsh-external-state.js",
  "dist/lsh-external-state.d.ts",
  "dist/lsh-external-state.html",
  "dist/lsh-logic.js",
  "dist/lsh-logic.d.ts",
  "dist/lsh-logic.html",
  "dist/node-red-runtime.js",
  "dist/node-red-runtime.d.ts",
  "examples/lsh-actuator-sync.json",
  "examples/lsh-external-state.json",
  "examples/lsh-logic.json",
  "examples/inline-config.minimal.json",
  "examples/inline-config.multi-device.json",
  "images/actuator-sync-flow.png",
  "images/external-state-flow.png",
  "images/logic-flow.png",
  "images/lsh-actuator-sync-node.png",
  "images/lsh-external-state-node.png",
  "images/lsh-logic-node.png",
];

const unexpected = files.filter(
  (file) =>
    file.split("/").some((segment) => segment.startsWith(".")) ||
    !allowedFilePatterns.some((pattern) => pattern.test(file)),
);
const missing = requiredFiles.filter((file) => !files.includes(file));

if (unexpected.length > 0 || missing.length > 0) {
  if (unexpected.length > 0) {
    console.error(`Unexpected package files:\n${unexpected.join("\n")}`);
  }
  if (missing.length > 0) {
    console.error(`Missing package files:\n${missing.join("\n")}`);
  }
  process.exit(1);
}

console.log(`Verified ${files.length} packaged file(s).`);
