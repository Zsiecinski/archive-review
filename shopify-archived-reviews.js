// shopify-archived-reviews.js
// Node.js + Playwright script to find and extract archived reviews for multiple Shopify apps
// Usage: node shopify-archived-reviews.js [--out snapshot.json] [--test]
//
// --out <file>   Save JSON to file (for weekly snapshots). Include snapshot date in filename, e.g. archived-2025-02-01.json
// --test         Scrape only the first app (for quick testing). Requires: npx playwright install (once)

const fs = require('fs');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT_FILE = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : null;
const DEBUG = args.includes('--debug');
const TEST_SINGLE_APP = args.includes('--test');

// List of Shopify app review URLs to check
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

// Determine last page number for the current app reviews listing
async function getLastPageNumber(page) {
  // Ensure pagination is fully rendered by scrolling
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(2000);

  // Find all anchors with a page param and extract the largest page number
  const pageNumbers = await page.$$eval(
    'a[href*=\"reviews?page=\"], a[href*=\"?page=\"]',
    (anchors) => {
      const nums = [];
      for (const a of anchors) {
        try {
          const href = a.getAttribute('href') || '';
          const url = new URL(href, window.location.origin);
          const pageParam = url.searchParams.get('page');
          if (!pageParam) continue;
          const n = parseInt(pageParam, 10);
          if (!Number.isNaN(n)) nums.push(n);
        } catch {
          // Ignore malformed URLs
        }
      }
      return nums;
    }
  );

  if (!pageNumbers || pageNumbers.length === 0) {
    // Fallback: assume we're already on the only page
    return 1;
  }

  return Math.max(...pageNumbers);
}

// Click the main "Show archived reviews" button to reveal the archived reviews section (page-level toggle)
async function clickShowArchivedReviewsButton(page) {
  const selector =
    '[data-archived-reviews-target="buttonContainer"] button[data-element="show_archived_reviews_button"], ' +
    '[data-archived-reviews-target="buttonContainer"] button';
  try {
    const btn = await page.waitForSelector(selector, { state: 'visible', timeout: 8000 });
    if (!btn) return;
    const text = await btn.textContent();
    if (text && /show\s+archived\s+reviews/i.test(text.trim())) {
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await btn.click();
      await page.waitForTimeout(1500);
    }
  } catch {
    // Button may not exist on this page (e.g. no archived reviews)
  }
}

// Click all "Show archived reviews" buttons so archived content is expanded (one per review card)
async function expandArchivedReviews(page) {
  const selector =
    '[data-archived-reviews-target="buttonContainer"] button, button[data-element="show_archived_reviews_button"]';
  const buttons = await page.$$(selector);
  for (const btn of buttons) {
    try {
      const text = await btn.textContent();
      if (text && /show\s+archived\s+reviews/i.test(text.trim())) {
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await btn.click();
        await page.waitForTimeout(500);
      }
    } catch {
      // Ignore stale or non-visible buttons
    }
  }
}

// Stars for a review live inside the review container in a div with aria-label e.g. "5 out of 5 stars":
// <div class="tw-flex tw-relative tw-space-x-0.5 tw-w-[88px] tw-h-md" aria-label="5 out of 5 stars" role="img">...</div>

// Extract archived reviews from each review card (button container + date divs inside card)
async function extractArchivedReviewsFromCards(page) {
  return page.evaluate(() => {
    const results = [];
    const buttonContainers = document.querySelectorAll('[data-archived-reviews-target="buttonContainer"]');
    const cardSelector = 'article, li, [data-review-id], [data-app-review-id], [data-merchant-review], [role="listitem"], div[id^="review-"], [class*="review"]';

    function getRating(el) {
      if (!el || !el.querySelector) return { rating: null, ratingLabel: null };
      const ratingNode =
        el.querySelector('[aria-label*="out of 5 stars" i]') ||
        el.querySelector('[aria-label*="out of 5" i]') ||
        el.querySelector('[role="img"][aria-label*="star" i]');
      if (!ratingNode) return { rating: null, ratingLabel: null };
      const ratingLabel = ratingNode.getAttribute('aria-label') || null;
      if (!ratingLabel) return { rating: null, ratingLabel: null };
      const match = ratingLabel.match(/([0-9.]+)\s+out of/i);
      if (!match || !match[1]) return { rating: null, ratingLabel };
      const parsed = parseFloat(match[1]);
      return { rating: Number.isNaN(parsed) ? null : parsed, ratingLabel };
    }

    for (const btnContainer of buttonContainers) {
      const card = btnContainer.closest(cardSelector) || btnContainer.closest('div[class]')?.parentElement || btnContainer.parentElement;
      if (!card || !(card instanceof HTMLElement)) continue;

      const cardRating = getRating(card);

      // Find all date divs in this card (.tw-text-body-xs.tw-text-fg-tertiary)
      const dateDivs = card.querySelectorAll('.tw-text-body-xs.tw-text-fg-tertiary');
      for (const dateEl of dateDivs) {
        const dateText = dateEl.textContent?.replace(/\s+/g, ' ').trim() || null;
        if (!dateText) continue;
        const parentBlock = dateEl.closest(cardSelector) || dateEl.parentElement;
        const blockRating = parentBlock ? getRating(parentBlock) : cardRating;
        const rating = blockRating.rating ?? cardRating.rating;
        const ratingLabel = blockRating.ratingLabel || cardRating.ratingLabel;
        let text = null;
        const textEl = parentBlock?.querySelector('[data-component="ReviewComment"], .ui-review__body, .review-content, .review__content, p');
        if (textEl && textEl !== dateEl) {
          text = textEl.textContent?.replace(/\s+/g, ' ').trim() || null;
        }
        // Parse "February 2, 2026" -> ISO
        let dateISO = null;
        try {
          const d = new Date(dateText);
          if (!Number.isNaN(d.getTime())) dateISO = d.toISOString().slice(0, 10);
        } catch {}
        const id = (parentBlock?.getAttribute?.('data-review-id') || parentBlock?.getAttribute?.('data-app-review-id') || parentBlock?.getAttribute?.('data-id')) || null;
        results.push({ id, rating, ratingLabel, text, dateText, dateISO });
      }

      // If no date divs in card, still record one entry from card using any date we can find
      if (dateDivs.length === 0) {
        const dateEl = card.querySelector('.tw-text-body-xs.tw-text-fg-tertiary');
        const dateText = dateEl?.textContent?.replace(/\s+/g, ' ').trim() || null;
        let dateISO = null;
        if (dateText) {
          try {
            const d = new Date(dateText);
            if (!Number.isNaN(d.getTime())) dateISO = d.toISOString().slice(0, 10);
          } catch {}
        }
        const textEl = card.querySelector('[data-component="ReviewComment"], .ui-review__body, .review-content, p');
        const text = textEl?.textContent?.replace(/\s+/g, ' ').trim() || null;
        const id = card.getAttribute('data-review-id') || card.getAttribute('data-app-review-id') || card.getAttribute('data-id') || null;
        if (dateText || text || id) {
          results.push({ id, rating: cardRating.rating, ratingLabel: cardRating.ratingLabel, text, dateText, dateISO });
        }
      }
    }

    return results;
  });
}

// Extract from review containers [data-merchant-review] (stars live in div with aria-label "X out of 5 stars" inside)
async function extractArchivedReviewsFromMerchantContainers(page) {
  return page.evaluate(() => {
    const results = [];
    const containers = document.querySelectorAll('[data-merchant-review]');
    for (const container of containers) {
      const id =
        container.getAttribute('data-review-content-id') ||
        container.getAttribute('data-review-id') ||
        container.getAttribute('data-app-review-id') ||
        (container.closest && container.closest('[id^="review-"]')?.id?.replace(/^review-/, '')) ||
        null;
      const starsDiv = container.querySelector('[aria-label*="out of 5 stars" i], [aria-label*="out of 5" i], [role="img"][aria-label*="star" i]');
      let rating = null;
      let ratingLabel = null;
      if (starsDiv) {
        ratingLabel = starsDiv.getAttribute('aria-label') || null;
        if (ratingLabel) {
          const match = ratingLabel.match(/([0-9.]+)\s+out of/i);
          if (match && match[1]) {
            const parsed = parseFloat(match[1]);
            if (!Number.isNaN(parsed)) rating = parsed;
          }
        }
      }
      const dateEl = container.querySelector('.tw-text-body-xs.tw-text-fg-tertiary');
      const dateText = dateEl?.textContent?.replace(/\s+/g, ' ').trim() || null;
      let dateISO = null;
      if (dateText) {
        try {
          const d = new Date(dateText);
          if (!Number.isNaN(d.getTime())) dateISO = d.toISOString().slice(0, 10);
        } catch {}
      }
      const textEl = container.querySelector('[data-truncate-content-copy] p, [data-component="ReviewComment"], .ui-review__body, .review-content, .review__content, p');
      const text = textEl?.textContent?.replace(/\s+/g, ' ').trim() || null;
      if (id || rating !== null || dateText || text) {
        results.push({ id, rating, ratingLabel, text, dateText, dateISO });
      }
    }
    return results;
  });
}

// Extract archived reviews on the current (last) page
async function extractArchivedReviews(page) {
  // Expand archived sections (click "Show archived reviews" in each review card)
  await expandArchivedReviews(page);
  await page.waitForTimeout(1000);

  const hasArchivedContainer = await page.$('#archived-reviews-container');
  let containerReviews = [];

  if (hasArchivedContainer) {
    containerReviews = await page.$$eval(
    '#archived-reviews-container',
    (containers) => {
      if (!containers || containers.length === 0) return [];

      const container = containers[0];
      const results = [];
      const seenIds = new Set();

      // Helper: extract one review's data from a card element
      function extractFromCard(card) {
        if (!card || !(card instanceof HTMLElement)) return null;
        const id =
          card.getAttribute('data-review-id') ||
          card.getAttribute('data-app-review-id') ||
          card.getAttribute('data-id') ||
          null;
        let rating = null;
        let ratingLabel = null;
        const ratingNode =
          card.querySelector('[aria-label*="out of 5 stars" i]') ||
          card.querySelector('[aria-label*="out of 5" i]');
        if (ratingNode) {
          ratingLabel = ratingNode.getAttribute('aria-label') || null;
          if (ratingLabel) {
            const match = ratingLabel.match(/([0-9.]+)\s+out of/i);
            if (match && match[1]) {
              const parsed = parseFloat(match[1]);
              if (!Number.isNaN(parsed)) rating = parsed;
            }
          }
        }
        const textEl =
          card.querySelector('[data-component="ReviewComment"]') ||
          card.querySelector('.ui-review__body') ||
          card.querySelector('.review-content') ||
          card.querySelector('.review__content') ||
          card.querySelector('p');
        const text =
          textEl && textEl.textContent
            ? textEl.textContent.replace(/\s+/g, ' ').trim()
            : null;
        // Try multiple ways to find dates
        let dateText = null;
        let dateISO = null;
        
        // 1) Look for <time> element with datetime
        const timeEl = card.querySelector('time');
        if (timeEl) {
          dateISO = timeEl.getAttribute('datetime') || null;
          dateText = timeEl.textContent?.replace(/\s+/g, ' ').trim() || null;
        }
        
        // 2) Look for any element with datetime attribute
        if (!dateISO) {
          const datetimeEl = card.querySelector('[datetime]');
          if (datetimeEl) {
            dateISO = datetimeEl.getAttribute('datetime') || null;
            if (!dateText) dateText = datetimeEl.textContent?.replace(/\s+/g, ' ').trim() || null;
          }
        }
        
        // 3) Shopify app reviews date div: .tw-text-body-xs.tw-text-fg-tertiary
        if (!dateISO && !dateText) {
          const dateEl = card.querySelector('.tw-text-body-xs.tw-text-fg-tertiary');
          if (dateEl) {
            dateText = dateEl.textContent?.replace(/\s+/g, ' ').trim() || null;
          }
        }
        // 4) Other date-related elements
        if (!dateISO && !dateText) {
          const dateEl = card.querySelector('[data-date], [data-archived-date], .date, .review-date, .archived-date, [class*="date"]');
          if (dateEl) {
            dateISO = dateEl.getAttribute('datetime') || dateEl.getAttribute('data-date') || dateEl.getAttribute('data-archived-date') || null;
            if (!dateText) dateText = dateEl.textContent?.replace(/\s+/g, ' ').trim() || null;
          }
        }
        
        // 5) Look for text that looks like a date (ISO format or common formats)
        if (!dateISO && !dateText) {
          const cardText = card.textContent || '';
          // Try ISO date: YYYY-MM-DD
          const isoMatch = cardText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
          if (isoMatch) {
            dateISO = isoMatch[1];
          }
          // Try common date formats
          const dateMatch = cardText.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i);
          if (dateMatch && !dateText) {
            dateText = dateMatch[0].trim();
          }
        }
        
        return { id, rating, ratingLabel, text, dateText, dateISO };
      }

      // 1) Find review cards by <time> first (so we get dates)
      const timeEls = container.querySelectorAll('time');
      for (const timeEl of timeEls) {
        const card =
          timeEl.closest('[data-id], [data-review-id], [data-app-review-id]') ||
          timeEl.closest('li, article, [role="listitem"]') ||
          timeEl.parentElement?.parentElement ||
          timeEl.parentElement;
        const row = extractFromCard(card);
        if (!row) continue;
        const dateISO = timeEl.getAttribute('datetime') || row.dateISO;
        const dateText =
          timeEl.textContent?.replace(/\s+/g, ' ').trim() || row.dateText;
        const rec = {
          id: row.id,
          rating: row.rating,
          ratingLabel: row.ratingLabel,
          text: row.text,
          dateText,
          dateISO,
        };
        if (row.id) seenIds.add(String(row.id));
        if (rec.id || rec.rating !== null || rec.text || rec.dateText || rec.dateISO) {
          results.push(rec);
        }
      }

      // 2) Add any data-id blocks we missed (no time inside)
      const idBlocks = container.querySelectorAll(
        '[data-review-id], [data-app-review-id], [data-id]'
      );
      for (const el of idBlocks) {
        const id =
          el.getAttribute('data-review-id') ||
          el.getAttribute('data-app-review-id') ||
          el.getAttribute('data-id') ||
          null;
        if (id && seenIds.has(String(id))) continue;
        const row = extractFromCard(el);
        if (!row) continue;
        if (row.id) seenIds.add(String(row.id));
        if (row.id || row.rating !== null || row.text || row.dateText || row.dateISO) {
          results.push(row);
        }
      }

      if (results.length === 0) {
        const fallbacks = Array.from(container.children);
        for (const el of fallbacks) {
          const row = extractFromCard(el);
          if (row && (row.id || row.rating !== null || row.text || row.dateText || row.dateISO)) {
            results.push(row);
          }
        }
      }

      return results;
    }
  );
  }

  // Also extract from each review card (button container + .tw-text-body-xs.tw-text-fg-tertiary)
  const cardReviews = await extractArchivedReviewsFromCards(page) || [];

  // Extract from [data-merchant-review] / div[id^="review-"] containers (stars from aria-label div inside)
  const merchantReviews = await extractArchivedReviewsFromMerchantContainers(page) || [];

  // Merge: prefer container if present, then add card-based and merchant-based entries not already seen
  const seen = new Set(containerReviews.map((r) => (r.dateText || '') + (r.text || '') + (r.id || '')).filter(Boolean));
  const merged = [...containerReviews];
  for (const r of [...merchantReviews, ...cardReviews]) {
    const key = (r.dateText || '') + (r.text || '') + (r.id || '');
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }
  if (merged.length === 0 && (cardReviews.length > 0 || merchantReviews.length > 0)) {
    return cardReviews.length > 0 ? cardReviews : merchantReviews;
  }
  return merged;
}

// Scrape a single app's archived reviews starting from its reviews URL
async function scrapeApp(page, baseReviewsUrl) {
  // Normalize to page=1 if not present
  const firstPageUrlObj = new URL(baseReviewsUrl);
  if (!firstPageUrlObj.searchParams.get('page')) {
    firstPageUrlObj.searchParams.set('page', '1');
  }
  const firstPageUrl = firstPageUrlObj.toString();

  // 1. Load the initial reviews page
  await page.goto(firstPageUrl, { waitUntil: 'networkidle' });

  // 2. Click "Show archived reviews" to reveal the archived section (page-level toggle)
  await clickShowArchivedReviewsButton(page);

  // 3. Determine the last page number from pagination
  const lastPageNumber = await getLastPageNumber(page);

  // 4. Navigate to the last page (if different from current)
  if (lastPageNumber > 1) {
    const lastPageUrl = new URL(firstPageUrl);
    lastPageUrl.searchParams.set('page', String(lastPageNumber));
    await page.goto(lastPageUrl.toString(), { waitUntil: 'networkidle' });
    // Click "Show archived reviews" again on the last page (section may be per-page)
    await clickShowArchivedReviewsButton(page);
  }

  // 5. Extract archived reviews, if any
  const archivedReviews = await extractArchivedReviews(page);

  return {
    appReviewsUrl: baseReviewsUrl,
    firstPageUrl,
    lastPage: lastPageNumber,
    archivedReviews,
  };
}

async function main() {
  // Launch Chromium; we use default Playwright bundle, which may reuse any already-installed browsers
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];

  try {
    const urlsToScrape = TEST_SINGLE_APP ? APP_REVIEW_URLS.slice(0, 1) : APP_REVIEW_URLS;
    for (const appUrl of urlsToScrape) {
      try {
        const data = await scrapeApp(page, appUrl);
        results.push(data);
      } catch (err) {
        // Capture per-app error without failing the whole run
        results.push({
          appReviewsUrl: appUrl,
          error:
            (err && err.message) ||
            String(err) ||
            'Unknown error while scraping this app',
        });
      }
    }

    // Output formatted JSON with all apps' results
    const payload = { apps: results };
    const json = JSON.stringify(payload, null, 2);
    console.log(json);
    if (OUT_FILE) {
      const withDate = { snapshotDate: new Date().toISOString().slice(0, 10), ...payload };
      fs.writeFileSync(OUT_FILE, JSON.stringify(withDate, null, 2), 'utf8');
      console.error(`Snapshot written to ${OUT_FILE}`);
    }

    // Print last archived review date per app to stderr
    const summary = [];
    for (const app of results) {
      if (app.error) {
        summary.push({ app: app.appReviewsUrl, lastDate: null, note: app.error });
        continue;
      }
      const reviews = app.archivedReviews || [];
      let lastDateISO = null;
      let lastDateText = null;
      for (const r of reviews) {
        const iso = r.dateISO || null;
        const text = r.dateText || null;
        if (iso || text) {
          if (!lastDateISO && !lastDateText) {
            lastDateISO = iso;
            lastDateText = text;
          } else if (iso) {
            if (!lastDateISO || iso > lastDateISO) {
              lastDateISO = iso;
              lastDateText = text;
            }
          }
        }
      }
      const appName = (app.appReviewsUrl || '').replace(/^https:\/\/apps\.shopify\.com\//, '').replace(/\/reviews.*$/, '') || app.appReviewsUrl;
      summary.push({
        app: appName,
        url: app.appReviewsUrl,
        lastDateISO: lastDateISO || null,
        lastDateText: lastDateText || null,
        count: reviews.length,
      });
    }
    console.error('\n--- Last archived review date per app ---');
    for (const s of summary) {
      const dateStr = s.lastDateISO || s.lastDateText || (s.note ? `Error: ${s.note}` : 'no dates captured');
      const countStr = s.count != null ? `${s.count} archived` : '';
      console.error(`${s.app}: ${dateStr}${countStr ? ' (' + countStr + ')' : ''}`);
    }
  } catch (err) {
    // In case of unexpected global errors, log to stderr and exit non-zero
    console.error('Error while scraping archived reviews:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();

