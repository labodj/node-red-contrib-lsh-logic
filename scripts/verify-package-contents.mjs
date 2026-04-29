import { execFileSync } from "node:child_process";

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const [pack] = JSON.parse(raw);
const files = pack.files.map((entry) => entry.path).sort();

const allowedFilePatterns = [
  /^README\.md$/,
  /^LIFECYCLE\.md$/,
  /^LICENSE$/,
  /^NOTICE$/,
  /^CITATION\.cff$/,
  /^package\.json$/,
  /^dist\/[^.][\w./-]*$/,
  /^docs\/[^.][\w./-]*\.md$/,
  /^examples\/[^.][\w./-]*\.json$/,
  /^images\/[^.][\w./-]*\.(png|jpg|jpeg|webp)$/,
  /^vendor\/lsh-protocol\/README\.md$/,
  /^vendor\/lsh-protocol\/LICENSE$/,
  /^vendor\/lsh-protocol\/NOTICE$/,
  /^vendor\/lsh-protocol\/CITATION\.cff$/,
  /^vendor\/lsh-protocol\/docs\/profiles-and-roles\.md$/,
  /^vendor\/lsh-protocol\/shared\/lsh_protocol\.md$/,
];

const requiredFiles = [
  "README.md",
  "LIFECYCLE.md",
  "LICENSE",
  "NOTICE",
  "CITATION.cff",
  "package.json",
  "dist/lsh-logic.js",
  "dist/lsh-logic.d.ts",
  "dist/lsh-logic.html",
  "examples/lsh-logic-example.json",
  "examples/system-config.minimal.json",
  "examples/system-config.multi-device.json",
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
