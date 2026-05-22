import { readFileSync } from "node:fs";
import vm from "node:vm";

const i18nPath = "public/scripts/i18n.js";
const source = readFileSync(i18nPath, "utf8");
const context = {};

vm.runInNewContext(`${source}\nglobalThis.__translations = translations;`, context, {
  filename: i18nPath,
});

const translations = context.__translations;
const languages = ["zh", "en", "it"];

for (const language of languages) {
  if (!translations?.[language]) {
    console.error(`Missing i18n language object: ${language}`);
    process.exit(1);
  }
}

const referenceLanguage = languages[0];
const referenceKeys = Object.keys(translations[referenceLanguage]).sort();
const failed = [];

for (const language of languages.slice(1)) {
  const keys = new Set(Object.keys(translations[language]));
  const reference = new Set(referenceKeys);
  const missing = referenceKeys.filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !reference.has(key)).sort();
  if (missing.length > 0 || extra.length > 0) {
    failed.push({ language, missing, extra });
  }
}

if (failed.length > 0) {
  for (const result of failed) {
    console.error(`i18n key mismatch for ${result.language}`);
    if (result.missing.length > 0) {
      console.error(`  Missing: ${result.missing.join(", ")}`);
    }
    if (result.extra.length > 0) {
      console.error(`  Extra: ${result.extra.join(", ")}`);
    }
  }
  process.exit(1);
}

console.log(`i18n key check passed for ${languages.join(", ")} (${referenceKeys.length} keys).`);
