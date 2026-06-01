import { getTrenordTrafficInformation } from "../functions/api/trenord/traffic.ts";

const [, , trainNumber, date] = process.argv;
const secret = process.env.TRENORD_BFF_SECRET;

if (!trainNumber || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Usage: TRENORD_BFF_SECRET=... node scripts/validate-trenord-traffic.mjs <trainNumber> <YYYY-MM-DD>");
  process.exit(1);
}

if (!secret) {
  console.error("TRENORD_BFF_SECRET is required for live validation.");
  process.exit(1);
}

const result = await getTrenordTrafficInformation(trainNumber, date, secret);
console.log(JSON.stringify({
  available: result.available,
  trainNumber: result.trainNumber,
  date: result.date,
  line: result.line,
  trainCategory: result.trainCategory,
  trainOperator: result.trainOperator,
  direttrice: result.direttrice,
  direttriceDescription: result.direttriceDescription,
  direttriceSecurity: result.direttriceSecurity,
  matchSource: result.matchSource,
  noticeCount: result.notices.length,
  notices: result.notices.map((notice) => ({
    id: notice.id,
    date: notice.date,
    severityDescription: notice.severityDescription,
    severityLevel: notice.severityLevel,
    urls: notice.urls,
    descriptionPreview: notice.description.slice(0, 160),
  })),
}, null, 2));
