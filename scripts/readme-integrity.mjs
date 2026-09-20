import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = resolve(root, "README.md");
const readme = await readFile(readmePath, "utf8");

const requiredText = [
  "Deterministic GitHub Governance",
  "Issue → Change → PR → Merge",
  "Canonical",
  "Deterministic",
  "Machine-verifiable",
];

const requiredFiles = [
  "docs/assets/readme/inari-hero.webp",
  "docs/GOLDEN_PATH_ARCHITECTURE.md",
  "docs/ARCHITECTURE.md",
  "docs/SEMANTIC_TEMPLATES.md",
  "docs/IMPLEMENTATION_CONTRACT.md",
  "LICENSE",
];

for (const text of requiredText) {
  if (!readme.includes(text)) {
    throw new Error(`README is missing required positioning text: ${text}`);
  }
}

for (const relativePath of requiredFiles) {
  await access(resolve(root, relativePath));
}

for (const relativePath of requiredFiles) {
  const markdownRef = `./${relativePath}`;
  if (!readme.includes(markdownRef)) {
    throw new Error(`README is missing required local reference: ${markdownRef}`);
  }
}

console.log("README integrity: OK");
