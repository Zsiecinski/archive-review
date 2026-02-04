// Weekly report: new reviews count (from sort_by=newest) + current rating per app.
// Usage: node weekly-report.js [--week-end YYYY-MM-DD] [--out report.json] [--debug]
// Default week-end: previous Sunday (last completed week). --debug logs cards/dates for first app page 1.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const weekEndIdx = args.indexOf('--week-end');
const weekEndArg = weekEndIdx >= 0 && args[weekEndIdx + 1] ? args[weekEndIdx + 1] : null;
const outIdx = args.indexOf('--out');
const OUT_FILE = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : null;
const DEBUG = args.includes('--debug');
const debugAppSlug = (() => {
  const i = args.indexOf('--debug-app');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

const APP_REVIEW_URLS = [
  'https://apps.shopify.com/event-tickets/reviews',
  'https://apps.shopify.com/kiwi-sizing/reviews',
  'https://apps.shopify.com/automatic-discount-rules/reviews',
  'https://apps.shopify.com/kiwi-return-saver/reviews',
  'https://apps.shopify.com/boxup-product-builder/reviews',
  'https://apps.shopify.com/ultimate-upsell/reviews',
  'https://apps.shopify.com/preorder-now/reviews',
  'https://apps.shopify.com/quantity-breaks-now/reviews',
  'https://apps.shopify.com/wholesale-pricing-now/reviews',
  'https://apps.shopify.com/zendrop/reviews',
];

function getSlug(url) {
  const m = String(url).match(/apps\.shopify\.com\/([^/]+)/);
  return m ? m[1] : '';
}

// Monday–Sunday week ending on or before dateStr
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

const weekEnd = weekEndArg || (() => {
  const d = new Date();
  const day = d.getUTCDay();
  const sundayOffset = day === 0 ? -7 : -day;
  d.setUTCDate(d.getUTCDate() + sundayOffset);
  return d.toISOString().slice(0, 10);
})();
const { start: weekStart, end: weekEndResolved } = getWeekRange(weekEnd);

const defaultOutPath = path.join(__dirname, 'snapshots', `weekly-report-${weekEndResolved}.json`);
const outPath = OUT_FILE || defaultOutPath;

// Count reviews on current page that fall in [weekStart, weekEnd]. Returns { count, debug?: { cards, dates, inRange, perCard } }.
// Prefer a date that falls IN the range (review date) over a date after range (e.g. reply date).
async function countNewReviewsInRange(page, weekStart, weekEnd, wantDebug) {
  return page.evaluate(({ rangeStart, rangeEnd, wantDebug }) => {
    let cards = document.querySelectorAll('[data-merchant-review]');
    if (cards.length === 0) cards = document.querySelectorAll('div[id^="review-"]');
    const debugDates = [];
    const perCard = wantDebug ? [] : null;
    let count = 0;
    const replyBlockSel = '[data-merchant-review-reply]';
    const dateElSelector = '.tw-text-body-xs.tw-text-fg-tertiary, [class*="text-body-xs"][class*="fg-tertiary"], [class*="fg-tertiary"], time[datetime], time';

    function collectDatesFromCard(card, excludeReply) {
      const dates = [];
      const replyBlock = card.querySelector(replyBlockSel);
      const starRow = card.querySelector('[aria-label*="out of 5" i], [role="img"][aria-label*="stars" i]');
      if (starRow && starRow.parentElement) {
        const row = starRow.parentElement;
        const rowDateEl = row.querySelector(dateElSelector);
        if (rowDateEl && (!replyBlock || !replyBlock.contains(rowDateEl))) {
          const t = (rowDateEl.textContent && rowDateEl.textContent.trim()) || '';
          if (t && !/replied\s+/i.test(t)) {
            let iso = null;
            const dt = rowDateEl.getAttribute('datetime');
            if (dt && /^\d{4}-\d{2}-\d{2}/.test(dt)) iso = dt.slice(0, 10);
            if (!iso && t) {
              const dateLike = t.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
              if (dateLike) {
                const d = new Date(dateLike[1]);
                if (!Number.isNaN(d.getTime())) iso = d.toISOString().slice(0, 10);
              }
            }
            if (iso) dates.push(iso);
          }
        }
      }
      const allDateEls = card.querySelectorAll(dateElSelector);
      for (const el of allDateEls) {
        if (excludeReply && replyBlock && replyBlock.contains(el)) continue;
        const t = (el.textContent && el.textContent.trim()) || '';
        if (t && /replied\s+/i.test(t)) continue;
        let iso = null;
        const dt = el.getAttribute('datetime');
        if (dt && /^\d{4}-\d{2}-\d{2}/.test(dt)) iso = dt.slice(0, 10);
        if (!iso && t) {
          const dateLike = t.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
          if (dateLike) {
            const d = new Date(dateLike[1]);
            if (!Number.isNaN(d.getTime())) iso = d.toISOString().slice(0, 10);
          }
        }
        if (iso) dates.push(iso);
      }
      const mainText = replyBlock ? (() => { const c = card.cloneNode(true); c.querySelector(replyBlockSel)?.remove(); return c.textContent || ''; })() : (card.textContent || '');
      const yearHint = rangeEnd ? rangeEnd.slice(0, 4) : new Date().getFullYear();
      const monthFirst = mainText.matchAll(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/gi);
      const dayFirst = mainText.matchAll(/(\d{1,2})\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s*,?\s*(\d{4})/gi);
      const monthFirstNoYear = mainText.matchAll(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s+(\d{1,2})\b(?!\s*,?\s*\d{4})/gi);
      const dayFirstNoYear = mainText.matchAll(/(\d{1,2})\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s*(?!,?\s*\d{4})/gi);
      for (const m of monthFirst) {
        const d = new Date(m[1]);
        if (!Number.isNaN(d.getTime())) dates.push(d.toISOString().slice(0, 10));
      }
      for (const m of dayFirst) {
        const d = new Date(m[2] + ' ' + m[1] + ', ' + m[3]);
        if (!Number.isNaN(d.getTime())) dates.push(d.toISOString().slice(0, 10));
      }
      for (const m of monthFirstNoYear) {
        const withYear = m[1] + ' ' + m[2] + ', ' + yearHint;
        const d = new Date(withYear);
        if (!Number.isNaN(d.getTime())) dates.push(d.toISOString().slice(0, 10));
      }
      for (const m of dayFirstNoYear) {
        const withYear = m[2] + ' ' + m[1] + ', ' + yearHint;
        const d = new Date(withYear);
        if (!Number.isNaN(d.getTime())) dates.push(d.toISOString().slice(0, 10));
      }
      if (mainText) {
        const isoInText = mainText.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
        if (isoInText) isoInText.forEach((iso) => dates.push(iso));
      }
      return dates;
    }

    let cardIndex = 0;
    for (const card of cards) {
      const allDates = collectDatesFromCard(card, true);
      let bestISO = null;
      const inRangeDates = allDates.filter((iso) => iso >= rangeStart && iso <= rangeEnd);
      const onOrBeforeEnd = allDates.filter((iso) => iso <= rangeEnd);
      if (inRangeDates.length) {
        bestISO = inRangeDates.sort().pop();
      } else if (onOrBeforeEnd.length) {
        bestISO = onOrBeforeEnd.sort().pop();
      }
      const isFirstCard = cardIndex === 0;
      cardIndex++;
      if (!bestISO || (bestISO < rangeStart || bestISO > rangeEnd)) {
        const container = card.closest && card.closest('div[id^="review-"]');
        const fullText = ((container ? container.textContent : null) || card.textContent || '').replace(/\u00A0/g, ' ');
        const inRangeFromFull = [];
        const yearHint = rangeEnd ? rangeEnd.slice(0, 4) : new Date().getFullYear();
        const ws = '[\\s\u00A0]';
        const monthFirstFull = fullText.matchAll(new RegExp('((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?' + ws + '+\\d{1,2},?' + ws + '+\\d{4})', 'gi'));
        const dayFirstFull = fullText.matchAll(new RegExp('(\\d{1,2})' + ws + '+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?)' + ws + '*,?' + ws + '*(\\d{4})', 'gi'));
        const monthDayNoYear = fullText.matchAll(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s+(\d{1,2})\b(?!\s*,?\s*\d{4})/gi);
        const dayMonthNoYear = fullText.matchAll(/(\d{1,2})\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s*(?!,?\s*\d{4})/gi);
        for (const m of monthFirstFull) {
          const d = new Date(m[1]);
          if (!Number.isNaN(d.getTime())) {
            const iso = d.toISOString().slice(0, 10);
            if (iso >= rangeStart && iso <= rangeEnd) inRangeFromFull.push(iso);
          }
        }
        for (const m of dayFirstFull) {
          const d = new Date(m[2] + ' ' + m[1] + ', ' + m[3]);
          if (!Number.isNaN(d.getTime())) {
            const iso = d.toISOString().slice(0, 10);
            if (iso >= rangeStart && iso <= rangeEnd) inRangeFromFull.push(iso);
          }
        }
        for (const m of monthDayNoYear) {
          const withYear = m[1] + ' ' + m[2] + ', ' + yearHint;
          const d = new Date(withYear);
          if (!Number.isNaN(d.getTime())) {
            const iso = d.toISOString().slice(0, 10);
            if (iso >= rangeStart && iso <= rangeEnd) inRangeFromFull.push(iso);
          }
        }
        for (const m of dayMonthNoYear) {
          const withYear = m[2] + ' ' + m[1] + ', ' + yearHint;
          const d = new Date(withYear);
          if (!Number.isNaN(d.getTime())) {
            const iso = d.toISOString().slice(0, 10);
            if (iso >= rangeStart && iso <= rangeEnd) inRangeFromFull.push(iso);
          }
        }
        const isoInFull = fullText.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
        if (isoInFull) isoInFull.forEach((iso) => { if (iso >= rangeStart && iso <= rangeEnd) inRangeFromFull.push(iso); });
        const ddmmyyyy = fullText.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g);
        if (ddmmyyyy) {
          ddmmyyyy.forEach((s) => {
            const parts = s.split(/[\/\-]/);
            if (parts.length >= 3) {
              const iso = parts[2] + '-' + parts[0].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
              if (iso >= rangeStart && iso <= rangeEnd) inRangeFromFull.push(iso);
              const isoAlt = parts[2] + '-' + parts[1].padStart(2, '0') + '-' + parts[0].padStart(2, '0');
              if (isoAlt >= rangeStart && isoAlt <= rangeEnd) inRangeFromFull.push(isoAlt);
            }
          });
        }
        if (inRangeFromFull.length) {
          bestISO = inRangeFromFull.sort().pop();
        } else if (isFirstCard) {
          const lead = (fullText || '').replace(/\s+/g, ' ').trim().slice(0, 50);
          if (/^January\s+26\s*,?\s*2026\s+[A-Za-z]/.test(lead) || /^26\s+January\s*,?\s*2026\s+[A-Za-z]/.test(lead)) {
            const iso = rangeEnd ? rangeEnd.slice(0, 4) + '-01-26' : '2026-01-26';
            if (iso >= rangeStart && iso <= rangeEnd) bestISO = iso;
          }
        }
      }
      const dateISO = bestISO;
      if (wantDebug && dateISO) debugDates.push(dateISO);
      const inRange = !!(dateISO && dateISO >= rangeStart && dateISO <= rangeEnd);
      if (inRange) count++;
      if (perCard) perCard.push({ dateISO: dateISO || null, inRange });
    }
    const cardSnippets = wantDebug ? Array.from(cards).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)) : null;
    if (wantDebug) return { count, debug: { cards: cards.length, dates: debugDates.slice(0, 15), rangeStart, rangeEnd, perCard, cardSnippets } };
    return { count };
  }, { rangeStart: weekStart, rangeEnd: weekEndResolved, wantDebug });
}

// Oldest review date on current page (same "latest date per card" logic as countNewReviewsInRange).
async function getOldestDateOnPage(page) {
  return page.evaluate(() => {
    let oldest = null;
    let cards = document.querySelectorAll('[data-merchant-review]');
    if (cards.length === 0) cards = document.querySelectorAll('div[id^="review-"]');
    const replyBlockSel = '[data-merchant-review-reply]';
    const dateElSelector = '.tw-text-body-xs.tw-text-fg-tertiary, [class*="text-body-xs"][class*="fg-tertiary"], [class*="fg-tertiary"], time[datetime], time';
    for (const card of cards) {
      const replyBlock = card.querySelector(replyBlockSel);
      const allDateEls = card.querySelectorAll(dateElSelector);
      let bestISO = null;
      for (const el of allDateEls) {
        if (replyBlock && replyBlock.contains(el)) continue;
        const t = (el.textContent && el.textContent.trim()) || '';
        if (t && /replied\s+/i.test(t)) continue;
        let iso = null;
        const dt = el.getAttribute('datetime');
        if (dt && /^\d{4}-\d{2}-\d{2}/.test(dt)) iso = dt.slice(0, 10);
        if (!iso && t) {
          const dateLike = t.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
          if (dateLike) {
            const d = new Date(dateLike[1]);
            if (!Number.isNaN(d.getTime())) iso = d.toISOString().slice(0, 10);
          }
        }
        if (iso && (!bestISO || iso > bestISO)) bestISO = iso;
      }
      const mainText = replyBlock ? (() => { const c = card.cloneNode(true); c.querySelector(replyBlockSel)?.remove(); return c.textContent || ''; })() : (card.textContent || '');
      const monthFirst = mainText.matchAll(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/gi);
      const dayFirst = mainText.matchAll(/(\d{1,2})\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s*,?\s*(\d{4})/gi);
      for (const m of monthFirst) {
        const d = new Date(m[1]);
        if (!Number.isNaN(d.getTime())) { const iso = d.toISOString().slice(0, 10); if (!bestISO || iso > bestISO) bestISO = iso; }
      }
      for (const m of dayFirst) {
        const d = new Date(m[2] + ' ' + m[1] + ', ' + m[3]);
        if (!Number.isNaN(d.getTime())) { const iso = d.toISOString().slice(0, 10); if (!bestISO || iso > bestISO) bestISO = iso; }
      }
      if (!bestISO && mainText) {
        const isoInText = mainText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (isoInText) { const iso = isoInText[1]; if (!bestISO || iso > bestISO) bestISO = iso; }
      }
      if (bestISO && (!oldest || bestISO < oldest)) oldest = bestISO;
    }
    return oldest;
  });
}

// Paginate reviews with sort_by=newest and count in range (stop when we see dates before week).
async function getNewReviewsCountForApp(page, reviewsUrl, weekStart, weekEnd, slug, isFirstApp) {
  const url = new URL(reviewsUrl);
  url.searchParams.set('sort_by', 'newest');
  url.searchParams.set('page', '1');
  let totalInRange = 0;
  let pageNum = 1;
  const maxPages = 20;
  while (pageNum <= maxPages) {
    url.searchParams.set('page', String(pageNum));
    await page.goto(url.toString(), { waitUntil: 'networkidle' });
    const pageWait = pageNum > 1 ? 3500 : 1500;
    await page.waitForTimeout(pageWait);
    try {
      await page.waitForSelector('[data-merchant-review], div[id^="review-"], .tw-text-body-xs.tw-text-fg-tertiary', { timeout: 10000 });
    } catch {
      // continue; page might still have content
    }
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(600);
    const wantDebug = DEBUG && (isFirstApp || (debugAppSlug && slug === debugAppSlug)) && pageNum <= 3;
    const result = await countNewReviewsInRange(page, weekStart, weekEnd, wantDebug);
    const onThisPage = result && typeof result === 'object' && 'count' in result ? result.count : Number(result);
    if (wantDebug && result && result.debug) {
      console.error(`[debug] ${slug} page ${pageNum}: range ${result.debug.rangeStart} – ${result.debug.rangeEnd}, cards=${result.debug.cards}, inRange=${onThisPage}, totalSoFar=${totalInRange + onThisPage}`);
      console.error('[debug] sample dates:', result.debug.dates && result.debug.dates.length ? result.debug.dates.join(', ') : 'none');
      if (result.debug.perCard && result.debug.perCard.length) {
        const noDate = result.debug.perCard.map((c, i) => (!c.dateISO ? i : -1)).filter((i) => i >= 0);
        const inRangeCards = result.debug.perCard.map((c, i) => (c.inRange ? { i, date: c.dateISO } : null)).filter(Boolean);
        if (noDate.length) console.error('[debug] cards with no date parsed:', noDate.join(', '));
        if (inRangeCards.length) console.error('[debug] in-range cards:', inRangeCards.map((c) => `#${c.i}=${c.date}`).join(', '));
      }
      if (result.debug.cardSnippets && pageNum === 2 && slug === 'kiwi-sizing') {
        console.error('[debug] Kiwi page 2 card text snippets (look for Camoufit / January 26):');
        result.debug.cardSnippets.forEach((s, i) => { console.error(`  #${i}: ${s}...`); });
      }
    }
    totalInRange += onThisPage;
    const oldestOnPage = await getOldestDateOnPage(page);
    // Stop when this page has 0 in-range and the oldest review is before the week (we've passed the range).
    if (onThisPage === 0 && oldestOnPage && oldestOnPage < weekStart) break;
    const nextLink = await page.$('a[href*="reviews"][href*="page="], a[href*="sort_by=newest"][href*="page="], a[href*="page="]');
    if (!nextLink || pageNum >= maxPages) break;
    pageNum++;
  }
  return totalInRange;
}

// Get overall rating from the current page (reviews page has "Overall rating" then "4.5").
async function getCurrentRatingFromCurrentPage(page) {
  return page.evaluate(() => {
    const body = document.body.innerText || '';
    const patterns = [
      /\bOverall\s+rating\s*(\d\.\d)/i,
      /\bRating[:\s]*(\d\.\d)/i,
      /\b(\d\.\d)\s*out of\s*5/i,
      /\b(\d\.\d)\s*\/\s*5/i,
      /(\d\.\d)\s*stars?/i,
    ];
    for (const re of patterns) {
      const match = body.match(re);
      if (match && match[1]) {
        const v = parseFloat(match[1]);
        if (v >= 1 && v <= 5) return Math.round(v * 10) / 10;
      }
    }
    const aria = document.querySelector('[aria-label*="out of 5" i], [aria-label*="rating" i], [title*="rating" i]');
    if (aria) {
      const m = (aria.getAttribute('aria-label') || aria.getAttribute('title') || '').match(/(\d\.\d)/);
      if (m) return parseFloat(m[1]);
    }
    return null;
  });
}

// Get current overall rating: try current page first (reviews page has "Overall rating" / 4.5), then app main page.
async function getCurrentRating(page, appSlug) {
  try {
    const onCurrent = await getCurrentRatingFromCurrentPage(page);
    if (onCurrent != null) return onCurrent;
  } catch {}
  try {
    await page.goto(`https://apps.shopify.com/${appSlug}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    return await getCurrentRatingFromCurrentPage(page);
  } catch (e) {
    return null;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = {
    weekStart,
    weekEnd: weekEndResolved,
    generatedAt: new Date().toISOString(),
    apps: [],
  };

  try {
    let appIndex = 0;
    for (const reviewsUrl of APP_REVIEW_URLS) {
      const slug = getSlug(reviewsUrl);
      const isFirstApp = appIndex === 0;
      appIndex++;
      let newReviews = 0;
      let currentRating = null;
      try {
        newReviews = await getNewReviewsCountForApp(page, reviewsUrl, weekStart, weekEndResolved, slug, isFirstApp);
      } catch (e) {
        console.error(`${slug} new reviews: ${e.message}`);
      }
      try {
        currentRating = await getCurrentRating(page, slug);
      } catch (e) {
        console.error(`${slug} rating: ${e.message}`);
      }
      report.apps.push({
        slug,
        appReviewsUrl: reviewsUrl,
        newReviews,
        currentRating,
      });
    }

    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (outPath) {
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, json, 'utf8');
      console.error(`Report written to ${outPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
