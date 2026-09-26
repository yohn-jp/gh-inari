#!/usr/bin/env node
// Local app build into apps/setup-console/dist; the packaged product build is
// scripts/build-setup-console.mjs (output dist/setup-console/).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetupConsole } from "../../../scripts/build-setup-console.mjs";

await buildSetupConsole(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "dist"));
