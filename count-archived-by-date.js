// Count archived reviews with date in Monday–Sunday week, per app.
// Usage: node count-archived-by-date.js [snapshot.json] [refDate]
// refDate: YYYY-MM-DD; week is Monday–Sunday ending on or before refDate. Default: snapshotDate or today.
const fs = require('fs');
const path = process.argv[2] || 'snapshots/archived-2025-02-03-test.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const refDate = process.argv[3] || data.snapshotDate || new Date().toISOString().slice(0, 10);

function getWeekMondayToSunday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  const sundayOffset = day === 0 ? 0 : -day;
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() + sundayOffset);
  const monday = new Date(sunday);
  monday.setUTCDate(sunday.getUTCDate() - 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

const { start, end } = getWeekMondayToSunday(refDate);

function appSlug(url) {
  if (!url) return 'unknown';
  const m = url.match(/apps\.shopify\.com\/([^/]+)/);
  return m ? m[1] : url;
}

const results = [];
let grandTotal = 0;

for (const app of data.apps || []) {
  const slug = appSlug(app.appReviewsUrl);
  const reviews = app.archivedReviews || [];
  let inRange = 0;
  for (const r of reviews) {
    const d = r.dateISO;
    if (d && d >= start && d <= end) {
      inRange++;
      continue;
    }
    if (r.dateText) {
      const parsed = new Date(r.dateText);
      if (!Number.isNaN(parsed.getTime())) {
        const iso = parsed.toISOString().slice(0, 10);
        if (iso >= start && iso <= end) inRange++;
      }
    }
  }
  results.push({ app: slug, count: inRange });
  grandTotal += inRange;
}

console.log(`Archived reviews with date in ${start} – ${end} (Monday – Sunday), by app:\n`);
for (const { app, count } of results) {
  console.log(`${app}: ${count}`);
}
console.log('\nTotal:', grandTotal);
