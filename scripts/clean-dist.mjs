#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.rmSync(path.join(repositoryRoot, "dist"), { recursive: true, force: true });
for (const buildInfo of ["tsconfig.build.tsbuildinfo", "tsconfig.tsbuildinfo"]) {
  fs.rmSync(path.join(repositoryRoot, buildInfo), { force: true });
}
