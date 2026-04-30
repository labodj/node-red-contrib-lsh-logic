#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

const run = async (command, args, options = {}) => {
  try {
    return await execFileAsync(command, args, {
      cwd: root,
      maxBuffer: 1024 * 1024 * 16,
      ...options,
    });
  } catch (error) {
    const stderr = error.stderr ? `\n${error.stderr}` : "";
    const stdout = error.stdout ? `\n${error.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed.${stdout}${stderr}`, { cause: error });
  }
};

const ensureBuildExists = async () => {
  await access(join(root, "dist", "lsh-logic.js"));
  await access(join(root, "dist", "lsh-logic.html"));
};

const pack = async (destination) => {
  const { stdout } = await run(npmBin, ["pack", "--json", "--pack-destination", destination]);
  const [entry] = JSON.parse(stdout);
  return join(destination, entry.filename);
};

const main = async () => {
  await ensureBuildExists();
  const tempRoot = await mkdtemp(join(tmpdir(), "node-red-lsh-logic-package-"));
  try {
    const packagesDir = join(tempRoot, "packages");
    const consumerDir = join(tempRoot, "consumer");
    await mkdir(packagesDir);
    await mkdir(consumerDir);

    const tarball = await pack(packagesDir);
    await writeFile(join(consumerDir, "package.json"), JSON.stringify({ private: true }, null, 2));
    await run(
      npmBin,
      ["install", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      {
        cwd: consumerDir,
      },
    );

    await access(
      join(consumerDir, "node_modules", "node-red-contrib-lsh-logic", "dist", "lsh-logic.html"),
    );
    await access(join(consumerDir, "node_modules", "labo-smart-home-coordinator", "package.json"));
    await run(
      process.execPath,
      [
        "--eval",
        `
          const register = require("node-red-contrib-lsh-logic");
          if (typeof register !== "function") throw new Error("missing Node-RED register export");
          if (typeof register.LshLogicNode !== "function") throw new Error("missing runtime export");
          if (!register.Output || register.Output.Lsh !== 0) throw new Error("missing Output enum export");
        `,
      ],
      { cwd: consumerDir },
    );

    console.log(`Verified local Node-RED package install from ${tarball}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
