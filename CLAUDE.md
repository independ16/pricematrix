# PriceMatrix — Project Brief for Claude Code

## What This Is
Internal pricing tool for Patio Products, Inc. A React SPA that pulls ~43k price records from Google Sheets and presents them as a searchable, filterable matrix. Users (role-gated) can browse prices by product/category across all tiers, see customer-specific pricing, view qty discounts, flag data quality issues, and export to CSV, JSON, PDF, or Sage.

## GitHub
`https://github.com/independ16/pricematrix.git` (branch: `dev` → merge to `main` when verified)

## Deployed URLs
- **Dev:** https://dev--patioproducts-pricebook.netlify.app
- **Prod:** https://patioproducts-pricebook.netlify.app

## Stack
- React 18 + Vite 5, single-file app (`src/App.jsx` — currently ~2,797 lines)
- Netlify hosting + serverless functions (`netlify/functions/`)
- Google Sheets as data source (service account, via `sheet-data.js` function)
- Supabase for auth (REST calls only, no SDK): `lhtkmuvfiqbnkppwvsjj.supabase.co`
- No component library — all CSS is inline in App.jsx as a template literal (`const CSS`)

## Key External IDs
- **Supabase project:** `lhtkmuvfiqbnkppwvsjj.supabase.co`
- **Google Sheets ID:** `12L-DSPUcCDbzf1i6ysHLZaJ1WtwDEM9WPF9voHAE3_U`
- **Master tab:** `WooCoommerce_Prices_Master` (intentional double-o)
- **Customer pricing tabs:** `Customer_Pricing_Ratio_STAGING`, `Customer_Specific_Pricing`

## App.jsx Structure (line landmarks)
| Lines | Section |
|-------|---------|
| 1–93 | Constants: TIERS, TIER_COLORS, DEFAULT_EXCLUDED_CATEGORIES |
| 16–82 | Supabase auth helpers (sbSignIn, sbRefresh, sbUpdatePassword, session storage) |
| 95–120 | getRoleCapabilities — role → feature flags |
| 108–120 | PRICE_SOURCE constants, CUSTOMER_NAMES map |
| 122–184 | PasswordSetGate component (invite/recovery link handler) |
| 186–378 | Data helpers: getProducts, buildMatrix, getTierFlat, resolveCustomerPrice, buildCustomerIndex, buildSageExport, downloadCSV, downloadJSON |
| 380–549 | computeRedFlags — data quality flag analysis |
| 551–918 | CSS — large inline template literal |
| 919–933 | LogoImg component |
| 934–1043 | AuthGate component |
| 1044–1222 | UserManagementModal |
| 1223–1240 | PctBadge, WatermarkBar |
| 1241–1514 | DetailPanel |
| 1515–1745 | SheetView |
| 1788–1845 | computeCustomerFlags |
| 1846–2143 | CustomerView (includes print-only per-category PDF layout, mirrors SheetView) |
| 2197–end | FlagInfoTooltip, FLAG_DESCRIPTIONS, Root App component (export default) |

## Roles
`admin` > `manager` > `viewer` > `commercial` / `wholesale` / `retail`
- admin/manager: all tiers + customer view; admin adds CSV/JSON/Sage/Sync
- viewer: all tiers, sheet view only
- tier-specific roles: see only their tier

## Customer Pricing Architecture
Three price sources, priority order:
1. **SPECIFIC** — exact `customer_id + child_id + qty_break` row from `Customer_Specific_Pricing`
2. **RATIO** — generic ratio row from `Customer_Pricing_Ratio_STAGING` (customer_id blank, applies Wholesale × ratio)
3. **WL3** — fallback to Wholesale_L3 tier price

`buildCustomerIndex(data)` builds a lookup map. `resolveCustomerPrice(idx, childId, customerId, qty)` resolves priority.

Current customers in CUSTOMER_NAMES:
- 425: PAVCO Furniture, Inc.
- 483: A&K Enterprise of Manatee
- 418: Florida Patio / Alumatech — combined internal label; Florida Patio owns Alumatech, same negotiated pricing for both. As of Aug 2026, all 338 SPECIFIC rows live under `customer_id=418` only. `Customer_Pricing_Ratio_STAGING`'s old ~4,355-row formula-based data for 418 was deleted and fully replaced by curated SPECIFIC overrides — everything not explicitly overridden falls through to plain WL3.
- 441: Leisure Furniture (added May 2026 — fabric SKUs only, SPECIFIC rows)
- 601: Alumatech — **not yet used anywhere in PriceMatrix data** (zero rows under this id → doesn't appear in the Customer dropdown). Only matters for the WooCommerce push, where Florida Patio and Alumatech are separate customer accounts needing identical pricing mirrored to both ids. See Outstanding Work.

## CustomerView Column Logic (critical — do not regress)
- `custBreaks` memo: exists for break derivation only — NOT used for column rendering or price resolution
- `visibleBreaks` is derived from `Object.keys(r.prices)` across filtered rows (mirrors SheetView's `allBreaks`)
- `rows` memo stores `prices[qty_break] = {price, source}` ONLY for real source entries — no fallback fill
- colSpan on category header rows uses `visibleBreaks.length` (NOT `custBreaks.length`)

## Netlify Functions
- `sheet-data.js` — fetches all three pricing tabs, gzips response, 5-min cache. No auth on the endpoint itself — it's a public URL (`/.netlify/functions/sheet-data`), same data the app fetches, no service-account credentials needed to read it.
- `create-user.js`, `invite-user.js`, `set-password.js`, `get-profile.js` — Supabase user management

## scripts/ (untracked, not yet committed)
- `build-wc-customer-export.js` — builds a WooCommerce user-specific pricing import TSV from local exports of `Customer_Pricing_Ratio_STAGING` + `Customer_Specific_Pricing`. **Known bug:** only the ratio-rows loop mirrors `customer_id=418` → both `418` and `601` (Florida Patio/Alumatech); the specific-rows loop uses `row.customer_id` verbatim with no mirroring. Since all Florida Patio pricing now lives as SPECIFIC rows under 418 only (see Customer Pricing Architecture), running this script unmodified would produce a WC export with zero pricing for the Alumatech account. **Fix the specific-rows loop to mirror 418→601 before running this for the WC push.**
- `regenerate-ratio-staging.js` — generated the old formula-based ratio pricing for 418 (superseded/deleted; not used going forward for Florida Patio, kept only as reference for the TSV column format).

## Dev Workflow
```
npm run dev          # Vite dev server on port 3000
netlify dev          # Full local with functions on port 8888 (needed for sheet-data)
npm run build        # Production build to dist/
```

## Editing App.jsx — Safety Rules
1. **Always check line count before and after edits** — expected baseline is ~2,797 lines
2. For large patches: use explicit `old_string` with enough surrounding context to guarantee unique match
3. Never introduce `custBreaks` back into CustomerView column rendering or price resolution

## Outstanding Work (as of August 17-18, 2026)
- [ ] **Next up: WC export/upload for customer specific pricing** (all customers pushed at once, not incremental). Fix `scripts/build-wc-customer-export.js`'s specific-rows-loop mirroring gap first (see scripts/ section above) — without it, Alumatech (601) gets zero pricing in the WC push.
- [x] Florida Patio / Alumatech (418) pricing migration — replaced ~4,355 stale formula-based `Customer_Pricing_Ratio_STAGING` rows with 338 curated SPECIFIC rows in `Customer_Specific_Pricing`, cross-validated against the customer's clean price list and live master catalog. Verified via customer-view JSON export, zero discrepancies after one correction round (6 renamed-SKU rows had stale prices, fixed).
- [x] `30-910` (6" Wheel) catalog bug fixed in WC/master — Box(1000) variant had no distinct SKU (shared `30-910` with the Each variant) and its price was below the Each price, backwards for a 1000-count box. Corrected to `30-910-E`/`30-910-B` with proper tier pricing (Wholesale/WL2/WL3 = 600× each-price, Commercial = 1.1×, Retail = 1.8× — this category's real multiplier, not the usual 2×).
- [x] Print header fix (dev + prod) — `.print-hdr` (the "Price List — {tier/customer}" title) was coded but never actually visible in print output; no `@media print` rule set it to `display:block`. Also fixed a `:first-of-type` selector bug that would have forced the header onto its own blank first page once made visible (see `.print-hdr + .print-cat-section` in CSS).
- [ ] Orange-row (no-catalog-SKU) items from the Florida Patio price list still pending: `PC-2xx`/`SP-2xx` powder coat/spray paint variant mapping (David has pack-weight formula, not yet applied), plus `04-203`, `V3-215`, `V3-218` individual review. Not blocking — these SKUs just aren't priced in PriceMatrix.
- [ ] n8n ratio workflow: PAVCO (425) and A&K (483) only — no changes needed
- [ ] Qty discount flag: flag breaks where higher-qty price < ~80-90% of qty=0 price (deferred until sentinel corrections done)
- [ ] Patioproducts.com domain in Resend (SPF/DKIM) — eliminates Gmail warning on invite emails
- [x] Leisure Furniture (441): fabric-only SPECIFIC rows, no ratio workflow needed — complete
- [x] Customer pricing PDF now splits into per-category tables (matches Sheet View) — fixes columns being cut off past ~10+ on wide qty-break spreads; verified on dev and prod
