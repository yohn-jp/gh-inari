import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status ?? "without a status"}: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout;
}

/** Pack and install this checkout into a temporary consumer outside the repository. */
export async function installPackedCli() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "inari-setup-package-cert-"));
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "setup-certification-consumer", private: true }),
  );
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], root),
  )[0];
  if (
    packed?.name !== packageJson.name ||
    packed?.version !== packageJson.version ||
    typeof packed.filename !== "string"
  ) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error("npm pack identity did not match package.json");
  }
  const tarball = path.join(temporary, packed.filename);
  try {
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        tarball,
      ],
      consumer,
    );
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  const installedRoot = path.join(consumer, "node_modules", ...packageJson.name.split("/"));
  return Object.freeze({
    entry: path.join(installedRoot, packageJson.bin["gh-inari"]),
    identity: Object.freeze({
      name: packed.name,
      version: packed.version,
      shasum: packed.shasum,
      integrity: packed.integrity,
    }),
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    },
  });
}
