// App display names and tiers for the weekly Slack report.
// slug = URL segment from apps.shopify.com/<slug>/reviews
const APP_CONFIG = {
  'kiwi-sizing':            { displayName: 'Kiwi Size Chart',      tier: 1 },
  'event-tickets':          { displayName: 'Evey Events',           tier: 1 },
  'preorder-now':           { displayName: 'PreOrder Now',          tier: 1 },
  'automatic-discount-rules': { displayName: 'ADU',                 tier: 2 },
  'boxup-product-builder':   { displayName: 'Bundle Builder',       tier: 2 },
  'quantity-breaks-now':    { displayName: 'Bulk Discounts',       tier: 2 },
  'wholesale-pricing-now':  { displayName: 'Wholesale Pricing',    tier: 2 },
  'kiwi-return-saver':      { displayName: 'Kiwi Return Saver',     tier: 3 },
  'ultimate-upsell':        { displayName: 'Ultimate Upsell',      tier: 3 },
  'zendrop':                { displayName: 'Zendrop',              tier: 3 },
};

function getAppSlug(reviewsUrl) {
  if (!reviewsUrl) return '';
  const m = String(reviewsUrl).match(/apps\.shopify\.com\/([^/]+)/);
  return m ? m[1] : '';
}

function getDisplayName(slug) {
  return (APP_CONFIG[slug] && APP_CONFIG[slug].displayName) || slug;
}

function getTier(slug) {
  return (APP_CONFIG[slug] && APP_CONFIG[slug].tier) || 99;
}

// Apps grouped by tier for report order (Tier 1 first, then 2, then 3)
function getSlugsByTier() {
  const byTier = {};
  for (const slug of Object.keys(APP_CONFIG)) {
    const t = APP_CONFIG[slug].tier;
    if (!byTier[t]) byTier[t] = [];
    byTier[t].push(slug);
  }
  return [1, 2, 3].filter((t) => byTier[t]).map((t) => byTier[t]);
}

module.exports = { APP_CONFIG, getAppSlug, getDisplayName, getTier, getSlugsByTier };
