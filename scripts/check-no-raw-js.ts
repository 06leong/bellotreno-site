import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const ignoredDirectories = new Set([
  ".astro",
  ".git",
  "dist",
  "node_modules",
]);

const rawJavaScriptExtensions = new Set([".js", ".mjs", ".cjs"]);

function collectRawJavaScriptFiles(root: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      if (!ignoredDirectories.has(entry)) {
        files.push(...collectRawJavaScriptFiles(fullPath));
      }
    } else if (info.isFile() && rawJavaScriptExtensions.has(path.extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectRawJavaScriptFiles(process.cwd()).sort();

if (files.length > 0) {
  console.error("Raw JavaScript source files are not allowed after the TypeScript migration:");
  for (const file of files) {
    console.error(`- ${path.relative(process.cwd(), file)}`);
  }
  process.exit(1);
}

console.log("Raw JavaScript source check passed: 0 file(s).");
