import { readFileSync } from "node:fs";
import vm from "node:vm";

type Language = "zh" | "en" | "it";
type TranslationBundle = Record<Language, Record<string, string>>;

interface I18nMismatch {
  language: Language;
  missing: string[];
  extra: string[];
}

const i18nPath = "src/client/i18n.ts";
const source = readFileSync(i18nPath, "utf8")
  .replace(/^export\s+\{\};\s*$/m, "")
  .replace("window.translations = translations;", "globalThis.__translations = translations;");
const context: Record<string, unknown> = {};

vm.runInNewContext(source, context, {
  filename: i18nPath,
});

const translations = context.__translations as TranslationBundle | undefined;
const languages: Language[] = ["zh", "en", "it"];

if (!translations) {
  console.error("Missing i18n translations object.");
  process.exit(1);
}

for (const language of languages) {
  if (!translations?.[language]) {
    console.error(`Missing i18n language object: ${language}`);
    process.exit(1);
  }
}

const referenceLanguage = languages[0];
const referenceKeys = Object.keys(translations[referenceLanguage]).sort();
const failed: I18nMismatch[] = [];

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
