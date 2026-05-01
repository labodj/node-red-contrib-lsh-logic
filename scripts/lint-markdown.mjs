import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = ["README.md", "DOCS.md", "LIFECYCLE.md", "docs"];
const errors = [];

const collectMarkdownFiles = async (entry) => {
  if (entry.endsWith(".md")) {
    return [entry];
  }

  const files = [];
  for (const item of await readdir(entry, { withFileTypes: true })) {
    const path = join(entry, item.name);
    if (item.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path)));
    } else if (item.isFile() && item.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
};

const markdownFiles = (await Promise.all(roots.map(collectMarkdownFiles))).flat().sort();

for (const file of markdownFiles) {
  const text = await readFile(file, "utf8");
  const displayPath = relative(process.cwd(), file);
  const lines = text.split("\n");
  let inFence = false;
  let h1Count = 0;
  let firstMeaningfulLine = "";

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.endsWith("\r")) {
      errors.push(`${displayPath}:${lineNumber} uses CRLF line endings.`);
    }
    if (/[ \t]+$/.test(line)) {
      errors.push(`${displayPath}:${lineNumber} has trailing whitespace.`);
    }
    if (line.includes("\t")) {
      errors.push(`${displayPath}:${lineNumber} contains a tab character.`);
    }
    if (line.startsWith("```")) {
      inFence = !inFence;
    }
    if (!firstMeaningfulLine && line.trim()) {
      firstMeaningfulLine = line;
    }
    if (!inFence && /^# /.test(line)) {
      h1Count += 1;
    }
    for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (match[1].trim().length === 0) {
        errors.push(`${displayPath}:${lineNumber} has a Markdown link with an empty target.`);
      }
    }
  });

  if (inFence) {
    errors.push(`${displayPath} has an unclosed fenced code block.`);
  }
  if (!firstMeaningfulLine.startsWith("# ")) {
    errors.push(`${displayPath} must start with a level-1 heading.`);
  }
  if (h1Count !== 1) {
    errors.push(`${displayPath} must contain exactly one level-1 heading; found ${h1Count}.`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${markdownFiles.length} Markdown file(s).`);
