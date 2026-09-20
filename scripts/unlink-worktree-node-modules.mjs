#!/usr/bin/env node
// preinstall: if node_modules is a symlink (seeded from the main worktree by
// the post-checkout hook), replace it with a real directory before pnpm
// installs — otherwise installing here would mutate the main worktree's deps.
import { lstatSync, unlinkSync, mkdirSync } from "node:fs";

const target = "node_modules";

let stat;
try {
  stat = lstatSync(target);
} catch {
  process.exit(0);
}

if (stat.isSymbolicLink()) {
  unlinkSync(target);
  mkdirSync(target);
}
