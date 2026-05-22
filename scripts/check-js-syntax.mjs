import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["public/scripts", "functions", "src/lib"];

function collectJsFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
    } else if (info.isFile() && fullPath.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = roots.flatMap(collectJsFiles).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    const stderr = error.stderr?.toString() || error.stdout?.toString() || error.message;
    failures.push(`${file}\n${stderr.trim()}`);
  }
}

if (failures.length > 0) {
  console.error(`JavaScript syntax check failed for ${failures.length} file(s):\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`JavaScript syntax check passed for ${files.length} file(s).`);
