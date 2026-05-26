# PriceMatrix — Project Brief for Claude Code

## What This Is
Internal pricing tool for Patio Products, Inc. A React SPA that pulls ~43k price records from Google Sheets and presents them as a searchable, filterable matrix. Users (role-gated) can browse prices by product/category across all tiers, see customer-specific pricing, view qty discounts, flag data quality issues, and export to CSV, JSON, PDF, or Sage.

## GitHub
`https://github.com/independ16/pricematrix.git` (branch: `dev` → merge to `main` when verified)

## Deployed URLs
- **Dev:** https://dev--patioproducts-pricebook.netlify.app
- **Prod:** https://patioproducts-pricebook.netlify.app

## Stack
- React 18 + Vite 5, single-file app (`src/App.jsx` — currently ~2,753 lines)
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
| 1746–2022 | CustomerView |
| 2023–2147 | _FlagsView_REMOVED (dead code — do not resurrect) |
| 2148–2228 | FlagInfoTooltip, FLAG_DESCRIPTIONS |
| 2229–end | Root App component (export default) |

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
- 418: Florida Patio
- 441: Leisure Furniture (added May 2026 — fabric SKUs only, SPECIFIC rows)
- 601: Alumatech

## CustomerView Column Logic (critical — do not regress)
- `custBreaks` memo: exists for break derivation only — NOT used for column rendering or price resolution
- `visibleBreaks` is derived from `Object.keys(r.prices)` across filtered rows (mirrors SheetView's `allBreaks`)
- `rows` memo stores `prices[qty_break] = {price, source}` ONLY for real source entries — no fallback fill
- colSpan on category header rows uses `visibleBreaks.length` (NOT `custBreaks.length`)

## Netlify Functions
- `sheet-data.js` — fetches all three pricing tabs, gzips response, 5-min cache
- `create-user.js`, `invite-user.js`, `set-password.js`, `get-profile.js` — Supabase user management

## Dev Workflow
```
npm run dev          # Vite dev server on port 3000
netlify dev          # Full local with functions on port 8888 (needed for sheet-data)
npm run build        # Production build to dist/
```

## Editing App.jsx — Safety Rules
1. **Always check line count before and after edits** — expected baseline is ~2,753 lines
2. For large patches: use explicit `old_string` with enough surrounding context to guarantee unique match
3. Never introduce `custBreaks` back into CustomerView column rendering or price resolution
4. Dead code at ~line 2024 (`_FlagsView_REMOVED`) — leave alone until cleanup sprint

## Outstanding Work (as of May 26, 2026)
- [x] Leisure Furniture (441): fabric-only SPECIFIC rows, no ratio workflow needed — complete
- [ ] n8n ratio workflow: PAVCO (425) and A&K (483) only — no changes needed
- [ ] Merge dev → main once Leisure pricing is verified on dev
- [x] `Customer_Specific_Pricing_with_Leisure.tsv` (417 rows) pasted into Google Sheets — dev UI confirmed reading correctly
- [ ] Qty discount flag: flag breaks where higher-qty price < ~80-90% of qty=0 price (deferred until sentinel corrections done)
- [ ] Patioproducts.com domain in Resend (SPF/DKIM) — eliminates Gmail warning on invite emails
- [x] Dead code cleanup done: `_FlagsView_REMOVED`, dead `flagFilter` state removed
- [x] Supabase dashboard link fixed in UserManagementModal
- [x] Customer pricing flags added to CustomerView (`computeCustomerFlags`) — no-print, hover for details
- [x] "Florida Patio" renamed to "Florida Patio / Alumatech" (customer 418)
- [x] "variants" → "prices" in all UI count labels
