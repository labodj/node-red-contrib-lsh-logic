#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adjacentCoordinatorRoot = resolve(root, "..", "labo-smart-home-coordinator");
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
  await access(join(root, "dist", "lsh-actuator-sync.js"));
  await access(join(root, "dist", "lsh-actuator-sync.html"));
  await access(join(root, "dist", "lsh-external-state.js"));
  await access(join(root, "dist", "lsh-external-state.html"));
  await access(join(root, "dist", "node-red-runtime.js"));
};

const readJsonFile = async (path) => JSON.parse(await readFile(path, "utf8"));

const readOptionalJsonFile = async (path) => {
  try {
    return await readJsonFile(path);
  } catch {
    return null;
  }
};

const pack = async (packageRoot, destination) => {
  const { stdout } = await run(npmBin, ["pack", "--json", "--pack-destination", destination], {
    cwd: packageRoot,
  });
  const [entry] = JSON.parse(stdout);
  return join(destination, entry.filename);
};

const localCoordinatorPackage = async () => {
  try {
    const packageJson = await readJsonFile(join(adjacentCoordinatorRoot, "package.json"));
    if (packageJson.name !== "labo-smart-home-coordinator") {
      return null;
    }
    return {
      root: adjacentCoordinatorRoot,
      version: packageJson.version,
    };
  } catch {
    return null;
  }
};

const resolvedCoordinatorPackage = async (consumerDir) => {
  const nestedPath = join(
    consumerDir,
    "node_modules",
    "node-red-contrib-lsh-logic",
    "node_modules",
    "labo-smart-home-coordinator",
    "package.json",
  );
  const nestedPackage = await readOptionalJsonFile(nestedPath);
  if (nestedPackage !== null) {
    return { path: nestedPath, packageJson: nestedPackage };
  }

  const rootPath = join(consumerDir, "node_modules", "labo-smart-home-coordinator", "package.json");
  return { path: rootPath, packageJson: await readJsonFile(rootPath) };
};

const main = async () => {
  await ensureBuildExists();
  const tempRoot = await mkdtemp(join(tmpdir(), "node-red-lsh-logic-package-"));
  try {
    const packagesDir = join(tempRoot, "packages");
    const consumerDir = join(tempRoot, "consumer");
    await mkdir(packagesDir);
    await mkdir(consumerDir);

    const localCoordinator = await localCoordinatorPackage();
    const coordinatorTarball =
      localCoordinator === null ? null : await pack(localCoordinator.root, packagesDir);
    const tarball = await pack(root, packagesDir);
    await writeFile(join(consumerDir, "package.json"), JSON.stringify({ private: true }, null, 2));
    if (coordinatorTarball !== null) {
      await run(
        npmBin,
        [
          "install",
          "--package-lock=false",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          coordinatorTarball,
        ],
        {
          cwd: consumerDir,
        },
      );
    }
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
    await access(
      join(
        consumerDir,
        "node_modules",
        "node-red-contrib-lsh-logic",
        "dist",
        "lsh-actuator-sync.html",
      ),
    );
    await access(
      join(
        consumerDir,
        "node_modules",
        "node-red-contrib-lsh-logic",
        "dist",
        "lsh-external-state.html",
      ),
    );
    const installedCoordinator = await resolvedCoordinatorPackage(consumerDir);
    if (localCoordinator !== null) {
      if (installedCoordinator.packageJson.version !== localCoordinator.version) {
        throw new Error(
          `Node-RED package resolved coordinator ${installedCoordinator.packageJson.version} ` +
            `from ${installedCoordinator.path}, but local coordinator is ${localCoordinator.version}. ` +
            "Update the dependency range before release.",
        );
      }
    }
    await run(
      process.execPath,
      [
        "--eval",
        `
          const register = require("node-red-contrib-lsh-logic");
          if (typeof register !== "function") throw new Error("missing Node-RED register export");
          if (typeof register.LshLogicNode !== "function") throw new Error("missing runtime export");
          if (!register.Output || register.Output.Lsh !== 0) throw new Error("missing Output enum export");
          const syncRegister = require("node-red-contrib-lsh-logic/dist/lsh-actuator-sync.js");
          if (typeof syncRegister !== "function") throw new Error("missing sync register export");
          if (typeof syncRegister.LshActuatorSyncNode !== "function") throw new Error("missing sync runtime export");
          const externalStateRegister = require("node-red-contrib-lsh-logic/dist/lsh-external-state.js");
          if (typeof externalStateRegister !== "function") throw new Error("missing external-state register export");
          if (typeof externalStateRegister.LshExternalStateNode !== "function") throw new Error("missing external-state runtime export");
          const runtimeHelpers = require("node-red-contrib-lsh-logic/dist/node-red-runtime.js");
          if (typeof runtimeHelpers.normalizeBooleanState !== "function") throw new Error("missing shared runtime helpers");
        `,
      ],
      { cwd: consumerDir },
    );

    const coordinatorNote =
      localCoordinator === null ? "" : ` with local coordinator ${localCoordinator.version}`;
    console.log(`Verified local Node-RED package install from ${tarball}${coordinatorNote}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
