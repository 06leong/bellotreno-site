import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["public/scripts"];

function collectJsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
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

function getCommandOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const processError = error as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    return processError.stderr?.toString() || processError.stdout?.toString() || processError.message || String(error);
  }
  return String(error);
}

const files = roots.flatMap(collectJsFiles).sort();
const failures: string[] = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failures.push(`${file}\n${getCommandOutput(error).trim()}`);
  }
}

if (failures.length > 0) {
  console.error(`JavaScript syntax check failed for ${failures.length} file(s):\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`Raw JavaScript syntax check passed for ${files.length} file(s).`);
