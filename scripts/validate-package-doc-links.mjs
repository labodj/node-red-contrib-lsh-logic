import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const packResult = JSON.parse(packOutput);
const packEntries = Array.isArray(packResult) ? packResult : Object.values(packResult);
if (packEntries.length !== 1) {
  throw new Error("Expected npm pack --dry-run --json to return exactly one package entry");
}

const packagedFiles = new Set(
  packEntries[0].files.map(({ path: filePath }) => normalizePath(filePath)),
);
const markdownFiles = [...packagedFiles].filter((filePath) => filePath.endsWith(".md")).sort();
const htmlFiles = [...packagedFiles].filter((filePath) => filePath.endsWith(".html")).sort();

const markdownInlineLink = /!?\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const markdownReferenceLink = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
const htmlHrefOrSrc = /\b(?:href|src)=["']([^"']+)["']/g;

const errors = [];
const summaries = [];

for (const filePath of markdownFiles) {
  const links = markdownLinks(readPackagedFile(filePath));
  validateLinks(filePath, links, { forbidRelativePathLinks: filePath === "README.md" });
}

for (const filePath of htmlFiles) {
  const links = htmlLinks(readPackagedFile(filePath));
  validateLinks(filePath, links, { forbidRelativePathLinks: false });
}

if (errors.length > 0) {
  throw new Error(`Package documentation links are not registry-safe:\n${errors.join("\n")}`);
}

console.log(`Validated package documentation links in ${packEntries[0].filename}`);
for (const summary of summaries) {
  console.log(
    `- ${summary.filePath}: external=${summary.external}, anchors=${summary.anchors}, relative=${summary.relative}`,
  );
}

function validateLinks(filePath, links, { forbidRelativePathLinks }) {
  const summary = {
    filePath,
    external: 0,
    anchors: 0,
    relative: 0,
  };

  for (const rawLink of links) {
    const link = rawLink.trim().replace(/^<|>$/g, "");
    const parsed = parseLink(link);

    if (parsed.isExternal) {
      summary.external += 1;
      continue;
    }
    if (parsed.isAnchor) {
      summary.anchors += 1;
      continue;
    }
    if (!parsed.pathName) {
      continue;
    }

    if (parsed.isRootRelative) {
      errors.push(`${filePath}: root-relative link ${rawLink} is not package-relative`);
      continue;
    }

    if (forbidRelativePathLinks) {
      errors.push(`${filePath}: top-level npm/Node-RED README uses relative link ${rawLink}`);
      continue;
    }

    const resolvedPath = resolvePackagePath(filePath, parsed.pathName);
    if (packagedFiles.has(resolvedPath) || hasPackagedChild(resolvedPath)) {
      summary.relative += 1;
      continue;
    }

    errors.push(`${filePath}: relative link ${rawLink} resolves outside package (${resolvedPath})`);
  }

  summaries.push(summary);
}

function markdownLinks(markdown) {
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [
    ...withoutCodeBlocks.matchAll(markdownInlineLink),
    ...withoutCodeBlocks.matchAll(markdownReferenceLink),
  ].map((match) => match[1]);
}

function htmlLinks(html) {
  return [...html.matchAll(htmlHrefOrSrc)].map((match) => match[1]);
}

function readPackagedFile(filePath) {
  return readFileSync(path.join(repoRoot, filePath), "utf8");
}

function parseLink(link) {
  if (link.startsWith("#")) {
    return { isAnchor: true, isExternal: false, pathName: "" };
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("//")) {
    return { isAnchor: false, isExternal: true, pathName: "" };
  }

  const pathName = decodeURIComponent(link.split("#", 1)[0].split("?", 1)[0]);
  return {
    isAnchor: !pathName && link.includes("#"),
    isExternal: false,
    isRootRelative: pathName.startsWith("/"),
    pathName,
  };
}

function resolvePackagePath(currentFile, linkPath) {
  const currentDirectory = path.posix.dirname(normalizePath(currentFile));
  return normalizePath(path.posix.normalize(path.posix.join(currentDirectory, linkPath)));
}

function hasPackagedChild(directoryPath) {
  return [...packagedFiles].some((filePath) => filePath.startsWith(`${directoryPath}/`));
}

function normalizePath(filePath) {
  return filePath
    .split(path.sep)
    .join(path.posix.sep)
    .replace(/^package\//, "")
    .replace(/\/+$/, "");
}
