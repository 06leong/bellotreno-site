import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["public/scripts", "functions"];

function collectFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (stat.isFile() && fullPath.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const findings = [];
for (const file of roots.flatMap(collectFiles).sort()) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes("innerHTML")) {
      findings.push({
        file,
        line: index + 1,
        text: line.trim(),
      });
    }
  });
}

if (findings.length === 0) {
  console.log("No innerHTML usage found.");
} else {
  console.log(`innerHTML audit found ${findings.length} usage(s):`);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}: ${finding.text}`);
  }
}
