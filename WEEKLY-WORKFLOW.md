# Weekly app reviews workflow

End-of-week flow: **snapshot** (archived reviews) → **weekly report** (new reviews + ratings) → **Slack post**.

## 1. Run weekly snapshot (archived reviews)

Saves archived reviews from the last page of each app to a dated file.

```powershell
cd "d:\Archived Review Tracker\shopify-scraper"
node shopify-archived-reviews.js --out snapshots/archived-YYYY-MM-DD.json
```

Or use the web app: **Run weekly snapshot** (saves to `snapshots/archived-{today}.json`).

Use the **Sunday** of the week you’re reporting (e.g. `archived-2026-02-01.json` for the week Jan 26 – Feb 1).

## 2. Run weekly report (new reviews + current ratings)

Scrapes each app’s **newest** reviews and counts how many fall in the Monday–Sunday week. Also fetches **current star rating** from each app’s main page.

```powershell
node weekly-report.js [--week-end YYYY-MM-DD] [--out report.json]
```

- **--week-end** Default: previous Sunday.
- **--out** Default: `snapshots/weekly-report-{weekEnd}.json`.

Saves `snapshots/weekly-report-2026-02-01.json` (for the week ending that Sunday). Run this **after** the snapshot so the same week is used.

## 3. Generate Slack post

Builds the weekly message (tiers, new reviews, ratings, archived section).

**From CLI:**

```powershell
node generate-slack-post.js [--snapshot path] [--report path] [--previous-report path] [--week-end YYYY-MM-DD]
```

- Uses **latest snapshot** in `snapshots/` if `--snapshot` is omitted.
- Uses `snapshots/weekly-report-{weekEnd}.json` if `--report` is omitted.
- Uses `snapshots/weekly-report-{prevSunday}.json` for “(from 4.4)” if `--previous-report` is omitted and that file exists.

**From web app:** Open **Weekly Slack post** → **Generate Slack post** → copy the text and paste into Slack.

## App tiers and names

Edit `app-config.js` to set **display names** and **tiers** (1, 2, 3) for the Slack post. Current mapping:

- **Tier 1:** Kiwi Size Chart, Evey Events, PreOrder Now  
- **Tier 2:** ADU, Bundle Builder, Bulk Discounts, Wholesale Pricing  
- **Tier 3:** Kiwi Return Saver, Ultimate Upsell, Zendrop  

## Quick reference

| Step | Command / action |
|------|------------------|
| 1. Snapshot (archived) | `node shopify-archived-reviews.js --out snapshots/archived-2026-02-01.json` or web app |
| 2. Weekly report (new + ratings) | `node weekly-report.js --week-end 2026-02-01` |
| 3. Slack post | `node generate-slack-post.js --week-end 2026-02-01` or web app **Generate Slack post** |

The Slack post includes **ARCHIVED REVIEWS** at the bottom (count per app for that week). Partner/developer rating pages (e.g. stay-tuned) are not scraped; ratings come from the **public app store page** (e.g. `https://apps.shopify.com/event-tickets`). If you need ratings from a partner dashboard, add them manually or extend the scraper with auth.
