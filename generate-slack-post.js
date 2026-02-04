// Generate weekly Slack post from snapshot + weekly report.
// Usage: node generate-slack-post.js [--snapshot path] [--report path] [--previous-report path] [--week-end YYYY-MM-DD]
// --previous-report: last week's report JSON, used to show "(from 4.4)" for rating change.
const fs = require('fs');
const path = require('path');
const { getDisplayName, getTier, getSlugsByTier } = require('./app-config.js');

const args = process.argv.slice(2);
const snapshotIdx = args.indexOf('--snapshot');
const reportIdx = args.indexOf('--report');
const prevReportIdx = args.indexOf('--previous-report');
const weekEndIdx = args.indexOf('--week-end');
const snapshotPath = snapshotIdx >= 0 ? args[snapshotIdx + 1] : null;
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;
const previousReportPath = prevReportIdx >= 0 ? args[prevReportIdx + 1] : null;
const weekEndArg = weekEndIdx >= 0 ? args[weekEndIdx + 1] : null;

function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  const sundayOffset = day === 0 ? 0 : -day;
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() + sundayOffset);
  const monday = new Date(sunday);
  monday.setUTCDate(sunday.getUTCDate() - 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

function formatDateRange(start, end) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const fmt = (iso) => {
    const d = new Date(iso + 'T12:00:00Z');
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  return `${fmt(start)} - ${fmt(end)}`;
}

function findLatestSnapshot(snapshotsDir) {
  const dir = path.resolve(snapshotsDir || path.join(__dirname, 'snapshots'));
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('archived-') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].f) : null;
}

function getSlugFromUrl(url) {
  const m = String(url).match(/apps\.shopify\.com\/([^/]+)/);
  return m ? m[1] : '';
}

// Build summary from snapshot (in-range counts, average rating, and per-review ratings for breakdown)
function snapshotSummary(data, rangeStart, rangeEnd) {
  const apps = [];
  let totalInRange = 0;
  for (const app of data.apps || []) {
    const slug = getSlugFromUrl(app.appReviewsUrl);
    const reviews = app.archivedReviews || [];
    let inRange = 0;
    const inRangeRatings = [];
    let ratingSum = 0;
    let ratingCount = 0;
    for (const r of reviews) {
      let isInRange = false;
      const d = r.dateISO;
      if (d && d >= rangeStart && d <= rangeEnd) isInRange = true;
      else if (r.dateText) {
        try {
          const parsed = new Date(r.dateText);
          if (!Number.isNaN(parsed.getTime())) {
            const iso = parsed.toISOString().slice(0, 10);
            if (iso >= rangeStart && iso <= rangeEnd) isInRange = true;
          }
        } catch {}
      }
      if (isInRange) {
        inRange++;
        const star = r.rating != null && r.rating >= 1 && r.rating <= 5 ? Math.round(Number(r.rating)) : null;
        inRangeRatings.push(star);
        if (star != null) {
          ratingSum += star;
          ratingCount++;
        }
      }
    }
    totalInRange += inRange;
    const averageRating = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null;
    apps.push({ slug, inRange, averageRating, inRangeRatings });
  }
  return { apps, totalInRange };
}

// Slack emoji per app slug
const EMOJI_BY_SLUG = {
  'kiwi-sizing': ':kiwiapp:',
  'event-tickets': ':evey-logo:',
  'preorder-now': ':preordernow:',
  'automatic-discount-rules': ':adg:',
  'boxup-product-builder': ':boxbuilder:',
  'quantity-breaks-now': ':bdnlogo:',
  'wholesale-pricing-now': ':wpnlogo:',
  'kiwi-return-saver': ':return-saver:',
  'ultimate-upsell': ':upplogo:',
  'zendrop': ':zendroplogo:',
};

function getEmojiForSlug(slug) {
  return EMOJI_BY_SLUG[slug] || '';
}

function generateSlackPost(options = {}) {
  const snapshotPath = options.snapshotPath || null;
  const reportPath = options.reportPath || null;
  const previousReportPath = options.previousReportPath || null;
  const weekEndArg = options.weekEnd || null;

  const refDate = weekEndArg || new Date().toISOString().slice(0, 10);
  const { start: weekStart, end: weekEnd } = getWeekRange(refDate);
  const dateRangeLabel = formatDateRange(weekStart, weekEnd);

  let archivedPerApp = {};
  let archivedTotal = 0;
  const snapshotFile = (snapshotPath && snapshotPath !== '') ? snapshotPath : findLatestSnapshot();
  if (snapshotFile && fs.existsSync(snapshotFile)) {
    const data = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    const summary = snapshotSummary(data, weekStart, weekEnd);
    archivedTotal = summary.totalInRange;
    summary.apps.forEach((a) => { archivedPerApp[a.slug] = { inRange: a.inRange, averageRating: a.averageRating, inRangeRatings: a.inRangeRatings || [] }; });
  }

  const snapshotsDir = path.join(__dirname, 'snapshots');
  const defaultReportPath = path.join(snapshotsDir, `weekly-report-${weekEnd}.json`);
  const resolvedReportPath = reportPath || (fs.existsSync(defaultReportPath) ? defaultReportPath : null);

  let report = { apps: [] };
  if (resolvedReportPath && fs.existsSync(resolvedReportPath)) {
    report = JSON.parse(fs.readFileSync(resolvedReportPath, 'utf8'));
  }
  let previousReport = { apps: [] };
  const prevWeekEnd = (() => {
    const d = new Date(weekEnd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const defaultPrevReportPath = path.join(snapshotsDir, `weekly-report-${prevWeekEnd}.json`);
  const resolvedPrevReportPath = previousReportPath || (fs.existsSync(defaultPrevReportPath) ? defaultPrevReportPath : null);
  if (resolvedPrevReportPath && fs.existsSync(resolvedPrevReportPath)) {
    previousReport = JSON.parse(fs.readFileSync(resolvedPrevReportPath, 'utf8'));
  }
  const reportBySlug = {};
  report.apps.forEach((a) => { reportBySlug[a.slug] = { ...a }; });
  previousReport.apps.forEach((a) => {
    if (reportBySlug[a.slug] && a.currentRating != null) reportBySlug[a.slug].previousRating = a.currentRating;
  });

  const tiers = getSlugsByTier();
  const tierLabels = { 1: 'TIER 1', 2: 'TIER 2', 3: 'TIER 3' };
  const lines = [];

  lines.push(`WEEKLY APP REVIEWS REPORT (${dateRangeLabel})`);
  lines.push('');
  lines.push("Here's a quick look at how many new reviews we received across our apps last week:");
  lines.push('');

  let totalNewReviews = 0;
  const ratings = [];

  for (let t = 0; t < tiers.length; t++) {
    const tierNum = t + 1;
    lines.push(tierLabels[tierNum] || `TIER ${tierNum}`);
    for (const slug of tiers[t]) {
      const name = getDisplayName(slug);
      const emoji = getEmojiForSlug(slug);
      const label = emoji ? `${emoji} ${name}` : name;
      const r = reportBySlug[slug] || {};
      const newReviews = r.newReviews != null ? r.newReviews : 0;
      totalNewReviews += newReviews;
      const rating = r.currentRating != null ? r.currentRating : null;
      if (rating != null) ratings.push(rating);
      const ratingStr = rating != null ? rating.toFixed(1) : 'N/A';
      const fromStr = r.previousRating != null ? ` (from ${r.previousRating.toFixed(1)})` : '';
      const padding = ' '.repeat(Math.max(0, 20 - label.length));
      lines.push(` ${label}${padding} – ${newReviews} new reviews | Current ranking: ${ratingStr}${fromStr}`);
    }
    lines.push('');
  }

  lines.push(`Total: ${totalNewReviews} new reviews  @channel`);
  lines.push('');

  const overallAvg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : 'N/A';
  lines.push(`OVERALL AVERAGE: ${overallAvg}`);
  lines.push('');

  lines.push('---');
  lines.push('ARCHIVED REVIEWS (reviews moved to archived last week)');
  lines.push('');
  function formatArchivedRatings(entry) {
    if (!entry) return '';
    const ratings = entry.inRangeRatings || [];
    if (ratings.length === 0) {
      if (entry.averageRating != null) return ` (${entry.averageRating} ${entry.averageRating === 1 ? 'star' : 'stars'} avg)`;
      return '';
    }
    const known = ratings.filter((s) => s != null);
    if (known.length === 0 && entry.averageRating != null) return ` (${entry.averageRating} ${entry.averageRating === 1 ? 'star' : 'stars'} avg)`;
    if (known.length === 0) return '';
    if (ratings.length <= 6) {
      const parts = ratings.map((s) => (s != null ? `${s}:star:` : '—'));
      return ' (' + parts.join(', ') + ')';
    }
    const dist = {};
    ratings.forEach((s) => {
      const k = s != null ? `${s}:star:` : '—';
      dist[k] = (dist[k] || 0) + 1;
    });
    const distStr = Object.entries(dist).map(([k, v]) => v > 1 ? v + '×' + k : k).join(', ');
    return ' (' + distStr + ')';
  }

  if (archivedTotal > 0 || Object.keys(archivedPerApp).length > 0) {
    const allSlugs = new Set([...Object.keys(archivedPerApp), ...tiers.flat().filter(Boolean)]);
    for (const slug of allSlugs) {
      const entry = archivedPerApp[slug];
      const count = entry && entry.inRange != null ? entry.inRange : 0;
      if (count > 0) {
        const archivedWord = count === 1 ? 'Archived' : 'Archived';
        const ratingStr = formatArchivedRatings(entry);
        const name = getDisplayName(slug);
        const emoji = getEmojiForSlug(slug);
        const label = emoji ? `${emoji} ${name}` : name;
        lines.push(` ${label}: ${count} ${archivedWord}${ratingStr}`);
      }
    }
    lines.push('');
    lines.push(`Total archived (this week): ${archivedTotal}`);
  } else {
    lines.push(' No archived count data for this week. Run the weekly snapshot and use --snapshot to point to it.');
  }

  return lines.join('\n');
}

function main() {
  const out = generateSlackPost({
    snapshotPath: snapshotPath || undefined,
    reportPath: reportPath || undefined,
    previousReportPath: previousReportPath || undefined,
    weekEnd: weekEndArg || undefined,
  });
  console.log(out);
}

if (require.main === module) main();
module.exports = { generateSlackPost, findLatestSnapshot };
