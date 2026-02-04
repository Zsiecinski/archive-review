// report-archived-diff.js
// Compares two weekly snapshots to see which apps had new archived reviews in that period.
// Usage: node report-archived-diff.js <before.json> <after.json> "January 26 - February 1"
//
// Run the scraper at end of each week and save:
//   node shopify-archived-reviews.js --out snapshots/archived-2025-01-25.json
//   node shopify-archived-reviews.js --out snapshots/archived-2025-02-01.json
// Then run this report:
//   node report-archived-diff.js snapshots/archived-2025-01-25.json snapshots/archived-2025-02-01.json "January 26 - February 1"

const fs = require('fs');

function loadSnapshot(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  return data.apps != null ? data : { apps: [] };
}

function appName(url) {
  if (!url) return '';
  return url.replace(/^https:\/\/apps\.shopify\.com\//, '').replace(/\/reviews.*$/, '') || url;
}

function idsFromApp(app) {
  if (!app || app.error) return new Set();
  const reviews = app.archivedReviews || [];
  const set = new Set();
  for (const r of reviews) {
    if (r.id != null && r.id !== '') set.add(String(r.id));
  }
  return set;
}

function main() {
  const [beforePath, afterPath, periodLabel] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('Usage: node report-archived-diff.js <before.json> <after.json> "Period label"');
    process.exit(1);
  }
  const label = periodLabel || 'Report period';

  const beforeData = loadSnapshot(beforePath);
  const afterData = loadSnapshot(afterPath);
  const beforeApps = (beforeData.apps || []).filter(Boolean);
  const afterApps = (afterData.apps || []).filter(Boolean);

  const beforeByUrl = new Map();
  for (const app of beforeApps) {
    if (app.appReviewsUrl) beforeByUrl.set(app.appReviewsUrl, app);
  }
  const afterByUrl = new Map();
  for (const app of afterApps) {
    if (app.appReviewsUrl) afterByUrl.set(app.appReviewsUrl, app);
  }

  const allUrls = new Set([...beforeByUrl.keys(), ...afterByUrl.keys()]);

  console.log('');
  console.log('========================================');
  console.log('WEEKLY APP REVIEWS REPORT (' + label + ')');
  console.log('========================================');
  console.log('Comparing: ' + beforePath + '  →  ' + afterPath);
  if (beforeData.snapshotDate) console.log('Before snapshot date: ' + beforeData.snapshotDate);
  if (afterData.snapshotDate) console.log('After snapshot date:  ' + afterData.snapshotDate);
  console.log('');

  let anyNew = false;
  for (const url of [...allUrls].sort()) {
    const name = appName(url);
    const beforeApp = beforeByUrl.get(url);
    const afterApp = afterByUrl.get(url);
    const beforeIds = idsFromApp(beforeApp);
    const afterIds = idsFromApp(afterApp);
    const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
    const removedIds = [...beforeIds].filter((id) => !afterIds.has(id));

    if (afterApp && afterApp.error) {
      console.log(name + ': Error in after snapshot – ' + (afterApp.error || 'unknown'));
      continue;
    }
    if (newIds.length > 0) anyNew = true;
    if (newIds.length > 0) {
      console.log(name + ': ' + newIds.length + ' new review(s) archived this period');
      console.log('  New archived IDs: ' + newIds.slice(0, 20).join(', ') + (newIds.length > 20 ? ' ... (+' + (newIds.length - 20) + ' more)' : ''));
    } else if (removedIds.length > 0) {
      console.log(name + ': No new archived this period (archived total: ' + afterIds.size + '; ' + removedIds.length + ' no longer in snapshot)');
    } else {
      console.log(name + ': No new archived reviews this period (total archived: ' + afterIds.size + ')');
    }
  }
  console.log('');
  if (anyNew) {
    console.log('Summary: At least one app had new archived reviews in this period.');
  } else {
    console.log('Summary: No new archived reviews detected for any app in this period.');
  }
  console.log('');
}

main();
