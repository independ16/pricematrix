import { useState, useMemo, useCallback, useEffect } from "react";

// Capture any auth token from the URL hash immediately at module load,
// before React or the router can strip it.
const INITIAL_HASH = window.location.hash || "";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TIERS = ["Retail", "Commercial", "Wholesale", "Wholesale_L2", "Wholesale_L3"];
const ALL_TIERS = [...TIERS, "OEM"];
const QTY_BREAKS_ALL  = [0, 1, 5, 10, 25, 50, 100]; // full data set (1 may exist as dupe of 0)
const QTY_BREAKS      = [0, 5, 10, 25, 50, 100];     // display columns — qty_break 1 suppressed

// Tier colors readable on both light slate and dark backgrounds
const TIER_COLORS = {
  Retail:       "#c94040",
  Commercial:   "#b87020",
  Wholesale:    "#3a7d58",
  Wholesale_L2: "#2271a8",
  Wholesale_L3: "#5a5aaa",
  OEM:          "#888888",
};

const TIER_MULT = { Retail:1.0, Commercial:0.88, Wholesale:0.75, Wholesale_L2:0.65, Wholesale_L3:0.58, OEM:0.50 };
const QTY_MULT  = { 0:1.0, 1:1.0, 5:0.97, 10:0.93, 25:0.88, 50:0.84, 100:0.80 };

// ─── NETLIFY IDENTITY AUTH LAYER ──────────────────────────────────────────────
// Role mapping:
//   admin    → everything: all tiers, all views, all exports, sync (when built)
//   manager  → all tiers, Browse + Sheet + Customer View (read), crosstab CSV only
//   viewer   → Browse + Sheet View only, no exports, no Customer View
//
// User invitations: Netlify dashboard → Identity → Invite users (admin access only)
// Role assignment: Identity dashboard → click user → Roles

// MOCK AUTH — replaced by Netlify Identity widget on deploy
const MOCK_USERS = [
  { id:"u1", email:"admin@example.com",   name:"Admin User",   role:"admin"   },
  { id:"u2", email:"manager@example.com", name:"Sales Manager",role:"manager" },
  { id:"u3", email:"viewer@example.com",  name:"Viewer",       role:"viewer"  },
];

function getRoleCapabilities(role) {
  switch(role) {
    case "admin":   return {
      tiers: TIERS,
      canViewCustomers: true,
      canViewSheet: true,
      canExportCSV: true,   // crosstab CSV
      canExportJSON: true,  // JSON (machine readable)
      canExportSage: true,  // Sage 50
      canSync: true,        // trigger data sync (when built)
    };
    case "manager": return {
      tiers: TIERS,
      canViewCustomers: true,  // can see Customer View (demo data banner shown)
      canViewSheet: true,
      canExportCSV: true,      // crosstab CSV only
      canExportJSON: false,
      canExportSage: false,
      canSync: false,
    };
    case "viewer":  return {
      tiers: TIERS,
      canViewCustomers: false,
      canViewSheet: true,
      canExportCSV: false,
      canExportJSON: false,
      canExportSage: false,
      canSync: false,
    };
    default:        return {
      tiers: [],
      canViewCustomers: false,
      canViewSheet: false,
      canExportCSV: false,
      canExportJSON: false,
      canExportSage: false,
      canSync: false,
    };
  }
}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const PRODUCTS_DEF = [
  { sku:"LUB-PRO",  name:"Industrial Lubricant Pro",   cat:"Lubricants", variants:["1lb","5lb","10lb","55lb"], img:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=300&q=80", basePrices:[28.99,89.99,149.99,699.99] },
  { sku:"LUB-LITE", name:"Light Machine Oil",          cat:"Lubricants", variants:["Simple"],                  img:"https://images.unsplash.com/photo-1580584126903-c17d41830450?w=300&q=80", basePrices:[14.99] },
  { sku:"ADH-EP",   name:"Epoxy Adhesive 2-Part",      cat:"Adhesives",  variants:["50ml","250ml","1L"],       img:"https://images.unsplash.com/photo-1617791160588-241658ad6869?w=300&q=80", basePrices:[12.99,54.99,189.99] },
  { sku:"ADH-CA",   name:"Cyanoacrylate Instant Bond", cat:"Adhesives",  variants:["Simple"],                  img:"https://images.unsplash.com/photo-1601933470096-0e34634ffcde?w=300&q=80", basePrices:[8.99] },
  { sku:"COA-ZN",   name:"Zinc Primer Coating",        cat:"Coatings",   variants:["1gal","5gal"],             img:"https://images.unsplash.com/photo-1562259929-b4e1fd3aef09?w=300&q=80", basePrices:[49.99,219.99] },
  { sku:"COA-EP",   name:"Epoxy Floor Coating",        cat:"Coatings",   variants:["1gal","5gal","55gal"],     img:"https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=300&q=80", basePrices:[64.99,289.99,2799.99] },
  { sku:"SEA-RTV",  name:"RTV Silicone Sealant",       cat:"Sealants",   variants:["Simple"],                  img:"https://images.unsplash.com/photo-1609365634878-b73e2f56ca9d?w=300&q=80", basePrices:[11.49] },
  { sku:"SEA-PU",   name:"Polyurethane Sealant",       cat:"Sealants",   variants:["300ml","600ml"],           img:"https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=300&q=80", basePrices:[9.99,18.49] },
  { sku:"CLN-IND",  name:"Industrial Degreaser",       cat:"Cleaners",   variants:["1gal","5gal","55gal"],     img:"https://images.unsplash.com/photo-1563453392212-326f5e854473?w=300&q=80", basePrices:[34.99,149.99,1199.99] },
  { sku:"CLN-EL",   name:"Electronic Contact Cleaner", cat:"Cleaners",   variants:["Simple"],                  img:"https://images.unsplash.com/photo-1601933470096-0e34634ffcde?w=300&q=80", basePrices:[16.99] },
  { sku:"GRS-MP",   name:"Multi-Purpose Grease",       cat:"Greases",    variants:["1lb","5lb","35lb"],        img:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=300&q=80", basePrices:[22.99,89.99,549.99] },
  { sku:"GRS-HT",   name:"High-Temp Bearing Grease",   cat:"Greases",    variants:["Simple"],                  img:"https://images.unsplash.com/photo-1580584126903-c17d41830450?w=300&q=80", basePrices:[31.99] },
];

const MOCK_CUSTOMERS = [
  {
    id:"cust-001", name:"Acme Industrial Supply", tier:"Wholesale",
    special:{
      "LUB-PRO-001": { 0:19.99, 5:18.99, 10:17.99, 25:16.99, 50:15.99, 100:14.99 },
      "ADH-EP-002":  { 0:38.99, 10:36.99, 25:33.99 },
    }
  },
  {
    id:"cust-002", name:"Bridgewater Maintenance Co.", tier:"Commercial",
    special:{
      "GRS-MP-001": { 0:17.50, 5:16.50, 25:14.99 },
    }
  },
  {
    id:"cust-003", name:"Pacific Coast Contractors", tier:"Wholesale_L2",
    special:{
      "COA-EP-001": { 0:42.00, 5:39.00, 25:35.00 },
      "COA-ZN-001": { 0:29.99, 10:27.99 },
      "SEA-RTV-001": { 0:7.25, 10:6.50 },
    }
  },
];

function generateData() {
  const rows = []; let uid = 1; const now = "2026-02-25";
  PRODUCTS_DEF.forEach((p, pi) => {
    const parentId = 1000 + pi * 10;
    p.variants.forEach((variant, vi) => {
      const isSimple = variant === "Simple";
      const childId  = isSimple ? parentId : parentId + vi + 1;
      const childSku = `${p.sku}-${String(vi+1).padStart(3,"0")}`;
      const base     = p.basePrices[vi] ?? 19.99;
      ALL_TIERS.forEach(tier => {
        QTY_BREAKS_ALL.forEach(qty => {
          rows.push({
            uid: uid++, parent_id: parentId, child_id: childId,
            parent_sku: p.sku, child_sku: childSku,
            parent_name: p.name, variant_name: variant,
            tier, qty_break: qty,
            price: +(base * TIER_MULT[tier] * QTY_MULT[qty]).toFixed(2),
            category: p.cat, image_url: p.img, customer_id: null, last_updated: now,
          });
        });
      });
    });
  });
  return rows;
}

// ─── DATA HELPERS ─────────────────────────────────────────────────────────────
const fmt  = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
const fmtP = n => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

function getProducts(data) {
  const map = new Map();
  data.forEach(r => {
    if (!map.has(r.parent_id)) map.set(r.parent_id, {
      parent_id: r.parent_id, parent_sku: r.parent_sku,
      parent_name: decodeEntities(r.parent_name),
      category: decodeEntities(r.category),
      image_url: r.image_url,
    });
  });
  return [...map.values()];
}

function getVariants(data, parentId) {
  const map = new Map();
  data.filter(r => r.parent_id === parentId).forEach(r => {
    if (!map.has(r.child_id))
      map.set(r.child_id, { child_id: r.child_id, child_sku: r.child_sku, variant_name: r.variant_name });
  });
  return [...map.values()];
}

// { [childId]: { [tier]: { [qty]: price } } }
function buildMatrix(data, parentId) {
  const m = {};
  data.filter(r => r.parent_id === parentId).forEach(r => {
    m[r.child_id] ??= {};
    m[r.child_id][r.tier] ??= {};
    m[r.child_id][r.tier][r.qty_break] = r.price;
  });
  return m;
}

// For sheet view: { [childSku]: { parent_sku, parent_name, variant_name, category, [qty]: price } }
function getTierFlat(data, tier) {
  const m = {};
  data.filter(r => r.tier === tier).forEach(r => {
    m[r.child_sku] ??= {
      parent_sku: r.parent_sku,
      parent_name: decodeEntities(r.parent_name),
      variant_name: decodeEntities(r.variant_name),
      category: decodeEntities(r.category),
    };
    m[r.child_sku][r.qty_break] = r.price;
  });
  return m;
}

// Build Sage 50 export rows — one row per unique parent_sku
// Price Level 1 = Wholesale qty_break=0, Level 8 = Commercial, Level 10 = Retail
// All other levels = 0 (Sage placeholders)
// TODO: replace parent_sku with sage_item_id mapping once data column exists
// TODO: filter out variants not in Sage (e.g. bulk/case sizes) once sage_export flag exists
function buildSageExport(data) {
  const map = {};
  data.forEach(r => {
    if (r.qty_break !== 0) return;
    map[r.parent_sku] ??= {
      item_id: r.parent_sku,
      parent_name: decodeEntities(r.parent_name),
      category: decodeEntities(r.category),
      price_level_1: 0, price_level_2: 0, price_level_3: 0, price_level_4: 0,
      price_level_5: 0, price_level_6: 0, price_level_7: 0, price_level_8: 0,
      price_level_9: 0, price_level_10: 0,
    };
    if (r.tier === "Wholesale")   map[r.parent_sku].price_level_1  = r.price;
    if (r.tier === "Commercial")  map[r.parent_sku].price_level_8  = r.price;
    if (r.tier === "Retail")      map[r.parent_sku].price_level_10 = r.price;
  });
  return Object.values(map).sort((a,b) => a.item_id.localeCompare(b.item_id));
}

function pctVsWholesale(price, wsPrice) {
  if (!wsPrice) return null;
  return ((price - wsPrice) / wsPrice) * 100;
}

// Customer: resolve price for a child_sku at a qty_break
// qty_break=1 is a sentinel duplicate of 0 — skip it in resolution
function resolveCustomerPrice(data, customer, childSku, qty) {
  const special = customer.special[childSku];
  if (special) {
    // Find highest applicable break in special, ignoring break=1
    const specBreaks = Object.keys(special).map(Number)
      .filter(b => b !== 1)
      .sort((a,b) => b - a);
    const match = specBreaks.find(b => qty >= b);
    if (match !== undefined) return { price: special[match], isSpecial: true };
  }
  // Fall back to tier price — find applicable break dynamically from real data
  const tierRows = data.filter(r => r.child_sku === childSku && r.tier === customer.tier && r.qty_break !== 1);
  const applicable = tierRows.map(r => r.qty_break).filter(b => b > 0 && qty >= b);
  const qb = applicable.length ? Math.max(...applicable) : 0;
  const tierRow = tierRows.find(r => r.qty_break === qb);
  return { price: tierRow?.price ?? null, isSpecial: false };
}

// Decode HTML entities in strings from WooCommerce (e.g. &amp; → &)
function decodeEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#039;/g,"'");
}

function downloadCSV(filename, headers, rows) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
  a.download = filename; a.click();
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
// Light mode (default): slate/blue-gray base, brand green #489367, coral #ff5f84 accent
// Dark mode: toggled via .dark class on .app
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,400;0,500;1,400&family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── LIGHT MODE (default) ── */
:root{
  --bg:#e8ecf0;
  --s1:#f0f3f6;
  --s2:#e2e7ec;
  --s3:#d4dbe3;
  --s4:#c6d0da;
  --b1:#c0cad5;
  --b2:#aab6c4;
  --b3:#8fa0b2;
  --brand:#3a7d58;          /* slightly deeper green for light bg contrast */
  --brand-lt:#489367;       /* true brand green */
  --brand-dim:rgba(72,147,103,.12);
  --coral:#ff5f84;
  --coral-dim:rgba(255,95,132,.12);
  --text:#1a2530;
  --t2:#4a5f70;
  --t3:#7a8fa0;
  --t4:#b0bfcc;
  --ws:#2d6e47;             /* darker green for wholesale label on light */
  --ws-bg:rgba(72,147,103,.1);
  --above:#c94040;          /* retail/commercial above-wholesale indicator */
  --above-bg:rgba(201,64,64,.1);
  --below:#2d7a5a;          /* L2/L3 below-wholesale indicator */
  --below-bg:rgba(45,122,90,.1);
  --gold:#8a6800;            /* amber on light */
  --gold-bg:rgba(138,104,0,.08);
  --fd:'Syne',sans-serif;--fm:'DM Mono',monospace;--fb:'DM Sans',sans-serif;
  --r:7px;
  --shadow:0 1px 4px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06);
}

/* ── DARK MODE ── */
.dark{
  --bg:#0d1117;
  --s1:#161c24;
  --s2:#1c2430;
  --s3:#212c3a;
  --s4:#283444;
  --b1:#2a3a4a;
  --b2:#344a5e;
  --b3:#3d5870;
  --brand:#489367;
  --brand-lt:#5aad7a;
  --brand-dim:rgba(72,147,103,.15);
  --coral:#ff5f84;
  --coral-dim:rgba(255,95,132,.15);
  --text:#dce6f0;
  --t2:#7a9ab0;
  --t3:#4a6478;
  --t4:#2a3c4e;
  --ws:#5aad7a;
  --ws-bg:rgba(90,173,122,.1);
  --above:#ff7a7a;
  --above-bg:rgba(255,122,122,.1);
  --below:#4cc9f0;
  --below-bg:rgba(76,201,240,.1);
  --gold:#f0c040;
  --gold-bg:rgba(240,192,64,.1);
  --shadow:0 2px 8px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.2);
}

body{background:var(--bg);color:var(--text);font-family:var(--fb);font-size:13px;line-height:1.5;overflow:hidden;transition:background .2s,color .2s}
.app{display:flex;flex-direction:column;height:100vh}

/* ── TOPBAR ── */
.topbar{
  height:52px;padding:0 20px;
  background:var(--s1);border-bottom:1px solid var(--b1);
  display:flex;align-items:center;gap:16px;flex-shrink:0;z-index:100;
  box-shadow:var(--shadow);
}
.logo-img{mix-blend-mode:multiply;border-radius:4px}
.dark .logo-img{display:none!important}
.dark .logo-img + .logo{display:flex!important}
.logo{
  width:30px;height:30px;border-radius:6px;flex-shrink:0;
  background:var(--brand);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:800;font-size:13px;color:#fff;letter-spacing:-.5px;
}
.brand{font-family:var(--fd);font-weight:700;font-size:16px;letter-spacing:-.3px;white-space:nowrap;flex-shrink:0;color:var(--text)}
.divider{width:1px;height:20px;background:var(--b1);flex-shrink:0}
.nav{display:flex;gap:2px}
.nav-btn{
  padding:5px 13px;border-radius:6px;border:none;background:transparent;
  color:var(--t3);font-size:12px;font-family:var(--fb);cursor:pointer;transition:all .15s;white-space:nowrap;
}
.nav-btn:hover{color:var(--t2);background:var(--s3)}
.nav-btn.active{background:var(--brand-dim);color:var(--brand);border:1px solid rgba(72,147,103,.25)}
.nav-btn.cust-active{color:var(--brand)!important}
.topbar-end{margin-left:auto;display:flex;align-items:center;gap:8px;flex-shrink:0}

/* Dark mode toggle */
.theme-btn{
  width:32px;height:32px;border-radius:6px;border:1px solid var(--b2);
  background:var(--s3);color:var(--t2);font-size:14px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:all .15s;
}
.theme-btn:hover{background:var(--s4);color:var(--text)}

.user-chip{
  display:flex;align-items:center;gap:7px;padding:4px 10px 4px 5px;
  border-radius:20px;background:var(--s3);border:1px solid var(--b2);cursor:pointer;
  font-size:11px;font-family:var(--fm);color:var(--t2);transition:all .15s;
}
.user-chip:hover{background:var(--s4);color:var(--text)}
.user-avatar{
  width:22px;height:22px;border-radius:50%;
  background:var(--brand);
  display:flex;align-items:center;justify-content:center;
  font-size:9px;font-weight:700;color:#fff;flex-shrink:0;
}
.role-badge{
  padding:2px 6px;border-radius:20px;font-size:9px;font-family:var(--fm);
  background:var(--brand-dim);color:var(--brand);border:1px solid rgba(72,147,103,.3);
  text-transform:uppercase;letter-spacing:.06em;
}

/* ── BODY LAYOUT ── */
.body{flex:1;display:flex;overflow:hidden}
.sidebar{
  width:200px;min-width:200px;background:var(--s1);border-right:1px solid var(--b1);
  display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;
}
.sb-sec{padding:12px 14px;border-bottom:1px solid var(--b1)}
.sb-lbl{font-family:var(--fm);font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px}
.inp{
  width:100%;padding:7px 10px;background:var(--s2);border:1px solid var(--b1);
  border-radius:6px;color:var(--text);font-family:var(--fb);font-size:12px;outline:none;transition:border-color .2s;
}
.inp:focus{border-color:var(--brand)}
.inp::placeholder{color:var(--t3)}
.cat-list{display:flex;flex-direction:column;gap:1px;overflow-y:auto;max-height:300px}
.cat-btn{
  display:flex;justify-content:space-between;align-items:center;
  padding:6px 10px;border-radius:5px;border:none;background:transparent;
  color:var(--t2);font-size:12px;font-family:var(--fb);cursor:pointer;transition:all .12s;width:100%;text-align:left;
}
.cat-btn:hover{background:var(--s3);color:var(--text)}
.cat-btn.on{background:var(--brand-dim);color:var(--brand);font-weight:500}
.cat-cnt{font-family:var(--fm);font-size:10px;color:var(--t3)}
.sel{
  width:100%;padding:6px 10px;background:var(--s2);border:1px solid var(--b1);
  border-radius:6px;color:var(--text);font-size:12px;font-family:var(--fb);outline:none;cursor:pointer;
}
.sel option{background:var(--s2)}
.tier-legend{display:flex;flex-direction:column;gap:5px}
.tleg-row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--t2)}
.tdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.ws-tag{font-family:var(--fm);font-size:8px;color:var(--brand);margin-left:auto}
.oem-note{font-family:var(--fm);font-size:9px;color:var(--t3);margin-top:8px;line-height:1.5}

/* ── MAIN AREA ── */
.main{flex:1;display:flex;overflow:hidden}

/* ── CARD GRID ── */
.grid{
  flex:1;overflow-y:auto;padding:14px;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;align-content:start;
}
.pcard{
  background:var(--s1);border:1px solid var(--b1);border-radius:var(--r);
  overflow:hidden;cursor:pointer;transition:border-color .18s,box-shadow .18s,transform .18s;
  box-shadow:var(--shadow);min-height:80px;
}
.pcard:hover{border-color:var(--brand);transform:translateY(-1px);box-shadow:0 4px 16px rgba(72,147,103,.18)}
.pcard.on{border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-dim)}
.pcard-img-wrap{width:100%;height:110px;overflow:hidden;background:var(--s3);position:relative;flex-shrink:0}
.pcard-img{width:100%;height:110px;object-fit:cover;display:block}
.pcard-img-ph{
  width:100%;height:110px;position:absolute;top:0;left:0;
  align-items:center;justify-content:center;
  background:var(--s3);
  font-family:var(--fd);font-size:32px;font-weight:800;
  color:var(--brand);opacity:.25;letter-spacing:-1px;
}
.pcard-body{padding:10px 12px}
.pcard-cat{font-family:var(--fm);font-size:8px;color:var(--brand);text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px}
.pcard-name{font-family:var(--fd);font-weight:600;font-size:12px;line-height:1.3;margin-bottom:3px;color:var(--text)}
.pcard-sku{font-family:var(--fm);font-size:10px;color:var(--t3)}
.pcard-vars{display:flex;gap:3px;flex-wrap:wrap;margin-top:5px}
.vtag{font-size:9px;font-family:var(--fm);padding:2px 6px;border-radius:20px;background:var(--s3);color:var(--t2);border:1px solid var(--b1)}
.pcard-price-row{display:flex;align-items:baseline;gap:5px;margin-top:7px;padding-top:7px;border-top:1px solid var(--b1)}
.pcard-price{font-family:var(--fm);font-size:13px;font-weight:500;color:var(--brand)}
.pcard-plbl{font-size:10px;color:var(--t3)}
.empty{grid-column:1/-1;text-align:center;padding:48px;color:var(--t3)}
.empty h3{font-family:var(--fd);margin-bottom:6px;font-size:16px}

/* ── DETAIL PANEL ── */
.detail{
  width:560px;min-width:560px;background:var(--s1);border-left:1px solid var(--b1);
  display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;
  box-shadow:-2px 0 12px rgba(0,0,0,.05);
}
.det-hdr{padding:14px 18px;border-bottom:1px solid var(--b1);display:flex;gap:12px;align-items:flex-start;flex-shrink:0}
.det-img{width:60px;height:60px;object-fit:cover;border-radius:7px;background:var(--s3);flex-shrink:0;border:1px solid var(--b1)}
.det-info{flex:1;min-width:0}
.det-cat{font-family:var(--fm);font-size:8px;color:var(--brand);text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px}
.det-name{font-family:var(--fd);font-weight:700;font-size:16px;line-height:1.2;margin-bottom:2px;color:var(--text)}
.det-sku{font-family:var(--fm);font-size:10px;color:var(--t3)}
.det-close{background:none;border:1px solid var(--b1);color:var(--t3);font-size:16px;cursor:pointer;padding:3px 7px;border-radius:5px;transition:all .15s;flex-shrink:0}
.det-close:hover{color:var(--text);background:var(--s3)}

.det-acts{padding:9px 18px;border-bottom:1px solid var(--b1);display:flex;gap:7px;align-items:center;flex-shrink:0;background:var(--s2)}
.btn{padding:5px 12px;border-radius:6px;border:1px solid var(--b2);font-size:11px;font-family:var(--fm);cursor:pointer;transition:all .15s;background:var(--s1);color:var(--t2)}
.btn:hover{background:var(--s3);color:var(--text)}
.btn-a{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:500}
.btn-a:hover{background:var(--brand-lt);border-color:var(--brand-lt)}
.btn-o{background:transparent;border-color:rgba(72,147,103,.4);color:var(--brand)}
.btn-o:hover{background:var(--brand-dim)}
.row-count{font-family:var(--fm);font-size:10px;color:var(--t3);margin-left:auto}

/* CALC */
.calc{
  padding:9px 18px;border-bottom:1px solid var(--b1);
  background:var(--s2);display:flex;align-items:center;gap:9px;flex-shrink:0;flex-wrap:wrap;
}
.calc-lbl{font-family:var(--fm);font-size:10px;color:var(--t3);white-space:nowrap}
.calc-var{
  padding:5px 8px;background:var(--s1);border:1px solid var(--b1);border-radius:6px;
  color:var(--text);font-family:var(--fm);font-size:11px;outline:none;cursor:pointer;
}
.calc-var option{background:var(--s1)}
.calc-qty{
  width:72px;padding:5px 8px;background:var(--s1);border:1px solid var(--b1);
  border-radius:6px;color:var(--text);font-family:var(--fm);font-size:12px;outline:none;transition:border-color .2s;
}
.calc-qty:focus{border-color:var(--brand)}
.calc-arrow{color:var(--b3);font-size:12px}
.calc-total{font-family:var(--fm);font-size:14px;font-weight:500;color:var(--brand)}
.calc-unit{font-family:var(--fm);font-size:10px;color:var(--t3)}

/* TIER TABS */
.ttabs{padding:10px 18px 0;border-bottom:1px solid var(--b1);display:flex;gap:3px;overflow-x:auto;flex-shrink:0;background:var(--s2)}
.ttab{
  padding:5px 11px;border-radius:6px 6px 0 0;border:1px solid transparent;
  font-size:11px;font-family:var(--fm);cursor:pointer;transition:all .15s;
  background:transparent;color:var(--t3);white-space:nowrap;border-bottom:none;
}
.ttab:hover{color:var(--t2)}
.ttab.on{background:var(--s1);border-color:var(--b1);color:var(--text);margin-bottom:-1px;padding-bottom:6px}

.det-body{flex:1;overflow-y:auto;padding:14px 18px;background:var(--bg)}

/* PRICE TABLE */
.ptw{border-radius:7px;border:1px solid var(--b1);overflow:hidden;margin-bottom:16px;background:var(--s1)}
.pt{width:100%;border-collapse:collapse;font-family:var(--fm);font-size:11px}
.pt th{
  padding:7px 11px;text-align:left;font-size:9px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--t3);background:var(--s2);
  border-bottom:1px solid var(--b1);white-space:nowrap;
}
.pt th.r{text-align:right}
.pt td{padding:7px 11px;border-bottom:1px solid var(--b1);vertical-align:middle}
.pt tr:last-child td{border-bottom:none}
.pt tbody tr:hover td{background:var(--s2)}
.pt td.r{text-align:right}

/* Price cells */
.pc-ws{color:var(--ws);font-weight:500}
.pc-above{color:var(--above)}
.pc-below{color:var(--below)}
.pc-qty{color:var(--text)}

/* % badges — only in detail panel */
.pct{display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;margin-left:4px;vertical-align:middle;font-family:var(--fm)}
.pct-up{background:var(--above-bg);color:var(--above)}
.pct-ws{background:var(--ws-bg);color:var(--ws)}
.pct-down{background:var(--below-bg);color:var(--below)}

.msec{margin-bottom:18px}
.msec-hdr{font-family:var(--fd);font-weight:600;font-size:11px;color:var(--t2);display:flex;align-items:center;gap:7px;margin-bottom:7px}
.msec-hdr::after{content:'';flex:1;height:1px;background:var(--b1)}
.vbadge{padding:2px 7px;border-radius:20px;font-size:9px;background:var(--s3);color:var(--t2);font-family:var(--fm);border:1px solid var(--b1)}
.skubadge{font-size:9px;color:var(--t3);font-family:var(--fm)}

/* NO SELECTION */
.nosel{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--t3)}
.nosel-icon{font-size:36px;opacity:.2}
.nosel-title{font-family:var(--fd);font-size:14px}
.nosel-sub{font-size:11px;text-align:center;line-height:1.6;max-width:200px}

/* ── SHEET VIEW ── */
.sheet{flex:1;display:flex;flex-direction:column;overflow:hidden}
.sheet-bar{
  padding:9px 14px;border-bottom:1px solid var(--b1);background:var(--s1);
  display:flex;align-items:center;gap:9px;flex-shrink:0;flex-wrap:wrap;
  box-shadow:0 1px 0 var(--b1);
}
.tier-pills{display:flex;gap:4px;flex-wrap:wrap}
.tier-pill{
  padding:4px 11px;border-radius:20px;border:1px solid var(--b2);
  font-size:11px;font-family:var(--fm);cursor:pointer;background:transparent;
  color:var(--t3);transition:all .15s;white-space:nowrap;
}
.tier-pill:hover{color:var(--t2);background:var(--s3)}
.sheet-cnt{font-family:var(--fm);font-size:10px;color:var(--t3);margin-left:auto;white-space:nowrap}
.sheet-cnt span{color:var(--brand);font-weight:500}
.sheet-wrap{flex:1;overflow:auto;background:var(--bg)}
.st{border-collapse:collapse;font-family:var(--fm);font-size:11px;white-space:nowrap;width:auto}
.st th{
  padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--t3);background:var(--s1);border-bottom:2px solid var(--b2);
  position:sticky;top:0;z-index:10;
}
.st th.r{text-align:right}
.st td{padding:7px 12px;border-bottom:1px solid var(--b1);vertical-align:middle;background:var(--s1)}
.st td.r{text-align:right}
.st tbody tr:hover td{background:var(--s2)}
.s-name{font-family:var(--fd);font-weight:600;font-size:11px;color:var(--text)}
.s-var{font-size:10px;color:var(--t2);margin-top:1px}
.s-sku{font-size:9px;color:var(--t3)}
.s-price-base{color:var(--text);font-weight:500}
.s-price-qty{color:var(--t2)}
.cat-hdr td{
  padding:5px 12px;background:var(--s3);border-bottom:1px solid var(--b2);border-top:1px solid var(--b2);
  font-family:var(--fd);font-size:9px;color:var(--brand);font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;
}

/* ── CUSTOMER VIEW ── */
.custv{flex:1;display:flex;flex-direction:column;overflow:hidden}
.cust-bar{
  padding:9px 14px;border-bottom:1px solid var(--b1);background:var(--s1);
  display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap;
}
.cust-sel{
  padding:6px 12px;border-radius:6px;border:1px solid var(--b2);background:var(--s2);
  color:var(--text);font-family:var(--fm);font-size:12px;outline:none;cursor:pointer;
}
.cust-sel option{background:var(--s2)}
.cust-wrap{flex:1;overflow:auto;background:var(--bg)}
.ct{border-collapse:collapse;font-family:var(--fm);font-size:11px;min-width:100%;white-space:nowrap}
.ct th{
  padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--t3);background:var(--s1);border-bottom:2px solid var(--b2);
  position:sticky;top:0;z-index:10;
}
.ct th.r{text-align:right}
.ct td{padding:7px 12px;border-bottom:1px solid var(--b1);vertical-align:middle;background:var(--s1)}
.ct td.r{text-align:right;font-family:var(--fm)}
.ct tbody tr:hover td{background:var(--s2)}
.spec-flag{font-size:8px;padding:1px 5px;border-radius:3px;background:var(--coral-dim);color:var(--coral);margin-left:5px;border:1px solid rgba(255,95,132,.2)}
.c-price-base{color:var(--brand);font-weight:500}
.c-price-qty{color:var(--text)}
.c-price-nil{color:var(--t4)}

/* ── AUTH GATE ── */
.auth-wrap{
  flex:1;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at 50% 40%, var(--brand-dim) 0%, transparent 60%);
}
.auth-card{
  width:360px;background:var(--s1);border:1px solid var(--b2);border-radius:12px;
  padding:32px;display:flex;flex-direction:column;align-items:center;gap:16px;
  box-shadow:var(--shadow);
}
.auth-logo{
  width:48px;height:48px;border-radius:10px;
  background:var(--brand);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:800;font-size:20px;color:#fff;
}
.auth-title{font-family:var(--fd);font-weight:700;font-size:20px;text-align:center;color:var(--text)}
.auth-sub{font-size:12px;color:var(--t2);text-align:center;line-height:1.6;max-width:260px}
.auth-select-lbl{font-family:var(--fm);font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;align-self:flex-start}
.auth-select{
  width:100%;padding:9px 12px;background:var(--s2);border:1px solid var(--b2);
  border-radius:7px;color:var(--text);font-family:var(--fm);font-size:12px;outline:none;cursor:pointer;
}
.auth-select option{background:var(--s2)}
.auth-btn{
  width:100%;padding:11px;border-radius:7px;border:none;
  background:var(--brand);
  color:#fff;font-family:var(--fd);font-weight:700;font-size:14px;cursor:pointer;
  transition:opacity .2s,background .2s;
}
.auth-btn:hover{background:var(--brand-lt)}
.auth-note{font-size:10px;font-family:var(--fm);color:var(--t3);text-align:center;line-height:1.5}

/* ── SCROLLBARS ── */
::-webkit-scrollbar{width:7px;height:7px}
::-webkit-scrollbar-track{background:var(--s2)}
::-webkit-scrollbar-thumb{background:var(--b3);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--t3)}

.fade{animation:fi .15s ease}
@keyframes fi{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

@media print{
  .topbar,.sidebar,.det-acts,.det-close,.ttabs,.calc,.auth-wrap,.theme-btn{display:none!important}
  .body,.main{display:block!important;height:auto!important;overflow:visible!important}
  .detail{width:100%!important;border:none!important}
  .grid{display:none!important}
  body{background:#fff!important;color:#000!important}
  .pt th,.pt td{border-color:#ddd!important}
  .pc-ws,.pc-above,.pc-below,.pc-qty{color:#000!important}
  .pct{display:none!important}
  /* Customer PDF */
  .cust-bar{display:none!important}
  .custv{display:block!important;height:auto!important}
  .cust-wrap{overflow:visible!important;height:auto!important}
  .ct th,.ct td{border-color:#ddd!important;color:#000!important;background:#fff!important}
  .cat-hdr td{background:#f0f0f0!important;color:#333!important}
  .no-print{display:none!important}
  .cust-wrap td span[style]{color:#000!important}
  .print-cust-hdr{display:block!important}
}
.print-cust-hdr{display:none;padding:0 0 18px 0}
.print-cust-hdr h1{font-family:var(--fd);font-size:20px;color:#000;margin-bottom:4px}
.print-cust-hdr p{font-size:12px;color:#666;font-family:var(--fb)}
`;

// ─── PCT BADGE ────────────────────────────────────────────────────────────────
function PctBadge({ price, wsPrice }) {
  if (wsPrice == null || wsPrice === 0) return null;
  const p = ((price - wsPrice) / wsPrice) * 100;
  if (!isFinite(p) || isNaN(p)) return null;
  if (Math.abs(p) < 0.05) return <span className="pct pct-ws">WS</span>;
  return <span className={`pct ${p > 0 ? "pct-up" : "pct-down"}`}>{fmtP(p)}</span>;
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────
function DetailPanel({ product, visibleTiers, onClose, allData, focusChildSku, caps }) {
  const [selTier, setSelTier] = useState("All");
  const [calcVar,  setCalcVar]  = useState(null);
  const [calcQty,  setCalcQty]  = useState("");
  const [filterColor, setFilterColor] = useState("All");
  const [filterSize,  setFilterSize]  = useState("All");

  const variants = useMemo(() => getVariants(allData, product.parent_id), [allData, product.parent_id]);
  const matrix   = useMemo(() => buildMatrix(allData, product.parent_id), [allData, product.parent_id]);
  const firstSku = variants[0]?.child_id;
  const cvSku    = calcVar || firstSku;

  // Detect if variants follow "Color / Size" pattern
  const isSlashVariants = useMemo(() =>
    variants.length > 1 && variants.every(v => v.variant_name.includes(" / ")),
  [variants]);

  const colorOptions = useMemo(() => {
    if (!isSlashVariants) return [];
    return ["All", ...new Set(variants.map(v => v.variant_name.split(" / ")[0].trim()))];
  }, [isSlashVariants, variants]);

  const sizeOptions = useMemo(() => {
    if (!isSlashVariants) return [];
    return ["All", ...new Set(variants.map(v => v.variant_name.split(" / ")[1].trim()))];
  }, [isSlashVariants, variants]);

  // When a focusChildSku is provided (from SKU search), pre-set the size filter
  useEffect(() => {
    if (!focusChildSku || !isSlashVariants) return;
    const match = variants.find(v => v.child_sku === focusChildSku);
    if (match) {
      const [color, size] = match.variant_name.split(" / ").map(s => s.trim());
      setFilterSize(size);
      setFilterColor("All");
    }
  }, [focusChildSku, isSlashVariants, variants]);

  const visibleVariants = useMemo(() => {
    if (!isSlashVariants) return variants;
    return variants.filter(v => {
      const [color, size] = v.variant_name.split(" / ").map(s => s.trim());
      return (filterColor === "All" || color === filterColor) &&
             (filterSize  === "All" || size  === filterSize);
    });
  }, [variants, isSlashVariants, filterColor, filterSize]);

  // Auto-scroll ref for focused variant (from SKU search)
  const focusRef = useCallback(node => {
    if (node) node.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusChildSku]);

  // Qty calc — skips break=1 (duplicate sentinel), uses break=0 as floor
  const calcTier = selTier === "All" ? "Wholesale" : selTier;
  function resolveCalcPrice(qty) {
    const prices = matrix[cvSku]?.[calcTier];
    if (!prices) return null;
    const applicable = Object.keys(prices).map(Number).filter(b => b !== 1 && b > 0 && qty >= b);
    const qb = applicable.length ? Math.max(...applicable) : 0;
    return prices[qb] ?? null;
  }
  const qNum  = parseInt(calcQty) || 0;
  const uPrice = qNum > 0 ? resolveCalcPrice(qNum) : null;
  const uPriceRounded = uPrice != null ? Math.round(uPrice * 100) / 100 : null;
  const tPrice = uPrice != null && qNum > 0 ? Math.round(uPrice * qNum * 100) / 100 : null;

  const tiersToShow = selTier === "All" ? visibleTiers : (visibleTiers.includes(selTier) ? [selTier] : visibleTiers);

  // Dynamic qty breaks derived from real data, suppressing break=1
  function qtyBreaksAllTiers(childId) {
    const breaks = new Set();
    tiersToShow.forEach(tier => {
      Object.keys(matrix[childId]?.[tier] || {}).map(Number).filter(b => b !== 1).forEach(b => breaks.add(b));
    });
    return [...breaks].sort((a,b) => a - b);
  }

  function qtyBreaksSingleTier(childId, tier) {
    return Object.keys(matrix[childId]?.[tier] || {}).map(Number).filter(b => b !== 1).sort((a,b) => a - b);
  }
  function handleCSV() {
    const rows = allData.filter(r => r.parent_id === product.parent_id && visibleTiers.includes(r.tier));
    downloadCSV(`${product.parent_sku}-prices.csv`,
      ["parent_sku","child_sku","variant_name","tier","qty_break","price","category","last_updated"],
      rows.map(r => [r.parent_sku,r.child_sku,r.variant_name,r.tier,r.qty_break,r.price,r.category,r.last_updated])
    );
  }
  function handleJSON() {
    const rows = allData.filter(r => r.parent_id === product.parent_id && visibleTiers.includes(r.tier));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:"application/json"}));
    a.download = `${product.parent_sku}-prices.json`; a.click();
  }

  return (
    <div className="detail fade">
      {/* Header */}
      <div className="det-hdr">
        <img className="det-img" src={product.image_url} alt="" onError={e=>e.target.style.display="none"}/>
        <div className="det-info">
          <div className="det-cat">{product.category}</div>
          <div className="det-name">{product.parent_name}</div>
          <div className="det-sku">SKU: {product.parent_sku}</div>
        </div>
        <button className="det-close" onClick={onClose}>×</button>
      </div>

      {/* Actions */}
      <div className="det-acts">
        <button className="btn btn-a" onClick={()=>window.print()}>⊞ Print / PDF</button>
        {caps.canExportCSV && <button className="btn btn-o" onClick={handleCSV}>↓ CSV</button>}
        {caps.canExportJSON && <button className="btn btn-o" onClick={handleJSON}>↓ JSON</button>}
        <span className="row-count">
          {allData.filter(r=>r.parent_id===product.parent_id&&visibleTiers.includes(r.tier)).length} rows
        </span>
      </div>

      {/* Variant dimension filters — only for color/size products */}
      {isSlashVariants && (
        <div className="det-acts" style={{background:"var(--s1)",gap:6}}>
          <span style={{fontFamily:"var(--fm)",fontSize:9,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".1em"}}>Filter</span>
          <select className="calc-var" value={filterColor} onChange={e=>setFilterColor(e.target.value)}>
            {colorOptions.map(c=><option key={c} value={c}>{c==="All"?"All Colors":c}</option>)}
          </select>
          <select className="calc-var" value={filterSize} onChange={e=>setFilterSize(e.target.value)}>
            {sizeOptions.map(s=><option key={s} value={s}>{s==="All"?"All Sizes":s}</option>)}
          </select>
          <span style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--t3)",marginLeft:"auto"}}>
            {visibleVariants.length} of {variants.length} variants
          </span>
        </div>
      )}
      <div className="calc">
        <span className="calc-lbl">QTY CALC</span>
        <select className="calc-var" value={cvSku} onChange={e=>setCalcVar(e.target.value)}>
          {variants.map(v=><option key={v.child_id} value={v.child_id}>{v.variant_name} · {v.child_sku}</option>)}
        </select>
        <span className="calc-lbl">×</span>
        <input className="calc-qty" type="number" min="1" placeholder="qty" value={calcQty} onChange={e=>setCalcQty(e.target.value)}/>
        {tPrice != null ? (
          <>
            <span className="calc-arrow">→</span>
            <span className="calc-total">{fmt(tPrice)}</span>
            <span className="calc-unit">{fmt(uPriceRounded)} × {qNum}</span>
          </>
        ) : calcQty ? (
          <span className="calc-unit" style={{color:"var(--t3)"}}>enter qty</span>
        ) : null}
      </div>

      {/* Tier tabs */}
      <div className="ttabs">
        <button className={`ttab ${selTier==="All"?"on":""}`} onClick={()=>setSelTier("All")}>All Tiers</button>
        {visibleTiers.map(t=>(
          <button key={t} className={`ttab ${selTier===t?"on":""}`}
            style={selTier===t?{color:TIER_COLORS[t],borderTopColor:TIER_COLORS[t]}:{}}
            onClick={()=>setSelTier(t)}>{t}</button>
        ))}
      </div>

      {/* Matrix */}
      <div className="det-body">
        {selTier !== "All" ? (
          /* Single tier: variants × qty breaks */
          visibleVariants.map(v => {
            const breaks = qtyBreaksSingleTier(v.child_id, selTier);
            const isFocus = focusChildSku && v.child_sku === focusChildSku;
            return (
              <div key={v.child_id} ref={isFocus ? focusRef : null} className="ptw" style={{marginBottom:12,outline: isFocus?"2px solid var(--brand)":"none",borderRadius:7}}>
                <table className="pt">
                  <thead>
                    <tr>
                      <th>Variant / SKU</th>
                      {breaks.map(q=><th key={q} className="r">{q===0?"Regular":`${q}+`}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <span className="vbadge" style={{marginRight:5}}>{v.variant_name}</span>
                        <span className="skubadge">{v.child_sku}</span>
                      </td>
                      {breaks.map(q=>{
                        const price   = matrix[v.child_id]?.[selTier]?.[q];
                        const wsPrice = matrix[v.child_id]?.Wholesale?.[q];
                        const isWs    = selTier === "Wholesale";
                        const isBase  = q === 0;
                        const priceClass = isWs ? "pc-ws" :
                          pctVsWholesale(price, wsPrice) > 0 ? "pc-above" : "pc-below";
                        return (
                          <td key={q} className="r">
                            {price != null ? (
                              <>
                                <span className={isBase ? priceClass : "pc-qty"}>{fmt(price)}</span>
                                {isBase && <PctBadge price={price} wsPrice={wsPrice}/>}
                              </>
                            ) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })
        ) : (
          /* All tiers: one section per variant, dynamic breaks */
          visibleVariants.map(v => {
            const breaks = qtyBreaksAllTiers(v.child_id);
            const isFocus = focusChildSku && v.child_sku === focusChildSku;
            return (
              <div key={v.child_id} ref={isFocus ? focusRef : null} className="msec" style={{outline: isFocus?"2px solid var(--brand)":"none",borderRadius:7,padding: isFocus?4:0}}>
                <div className="msec-hdr">
                  {v.variant_name} <span className="vbadge">{v.child_sku}</span>
                </div>
                <div className="ptw">
                  <table className="pt">
                    <thead>
                      <tr>
                        <th>Tier</th>
                        {breaks.map(q=><th key={q} className="r">{q===0?"Regular":`${q}+`}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {tiersToShow.map(tier=>{
                        const isWs = tier === "Wholesale";
                        return (
                          <tr key={tier}>
                            <td>
                              <span style={{display:"flex",alignItems:"center",gap:6}}>
                                <span className="tdot" style={{background:TIER_COLORS[tier]}}/>
                                <span style={{color:TIER_COLORS[tier],fontSize:11}}>{tier}</span>
                              </span>
                            </td>
                            {breaks.map(q=>{
                              const price   = matrix[v.child_id]?.[tier]?.[q];
                              const wsPrice = matrix[v.child_id]?.Wholesale?.[q];
                              return (
                                <td key={q} className="r">
                                  {price != null ? (
                                    <>
                                      <span style={{color: q===0 ? (isWs?"var(--ws)":TIER_COLORS[tier]) : "var(--text)"}}>{fmt(price)}</span>
                                      {q===0 && !isWs && <PctBadge price={price} wsPrice={wsPrice}/>}
                                    </>
                                  ) : "—"}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── SHEET VIEW ───────────────────────────────────────────────────────────────
function SheetView({ category, visibleTiers, allData, caps }) {
  const [tier,   setTier]   = useState(visibleTiers[0] || "Wholesale");
  const [search, setSearch] = useState("");
  const activeTier = visibleTiers.includes(tier) ? tier : visibleTiers[0];

  const data = useMemo(()=>getTierFlat(allData, activeTier), [allData, activeTier]);

  // Search is global — ignore category filter when searching
  const effectiveCat = search ? "All" : category;

  const rows = useMemo(()=>{
    let entries = Object.entries(data);
    if (effectiveCat !== "All") entries = entries.filter(([,v])=>v.category===effectiveCat);
    if (search) { const q=search.toLowerCase(); entries=entries.filter(([sku,v])=>v.parent_name.toLowerCase().includes(q)||sku.toLowerCase().includes(q)||v.parent_sku.toLowerCase().includes(q)); }
    return entries.sort((a,b)=>{
      if(a[1].category!==b[1].category) return a[1].category.localeCompare(b[1].category);
      return a[1].parent_name.localeCompare(b[1].parent_name);
    });
  },[data, effectiveCat, search]);

  const color = TIER_COLORS[activeTier];
  let lastCat = null;

  // Derive qty break columns from the FILTERED rows only (not all data), suppress break=1
  const sheetBreaks = useMemo(() => {
    const breaks = new Set();
    rows.forEach(([,v]) => {
      Object.keys(v).filter(k => !isNaN(k)).map(Number).filter(b => b !== 1).forEach(b => {
        if (v[b] != null) breaks.add(b);
      });
    });
    return [...breaks].sort((a,b) => a - b);
  }, [rows]);

  return (
    <div className="sheet">
      <div className="sheet-bar">
        <div className="tier-pills">
          {visibleTiers.map(t=>(
            <button key={t} className="tier-pill"
              style={activeTier===t ? {
                borderColor: TIER_COLORS[t],
                color: TIER_COLORS[t],
                background: `${TIER_COLORS[t]}18`,
              } : {}}
              onClick={()=>setTier(t)}>{t}</button>
          ))}
        </div>
        <input className="inp" style={{width:180}} placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}/>
        <span className="sheet-cnt" style={{marginLeft:"auto"}}><span>{rows.length}</span> variants</span>

        {/* Crosstab CSV — human readable */}
        {caps.canExportCSV && <button className="btn" onClick={()=>downloadCSV(
          `${activeTier}-prices${effectiveCat!=="All"?"-"+effectiveCat:""}.csv`,
          ["child_sku","parent_sku","parent_name","variant_name","category",...sheetBreaks.map(q=>q===0?"regular_price":`qty_${q}_plus`)],
          rows.map(([sku,v])=>[sku,v.parent_sku,v.parent_name,v.variant_name,v.category,...sheetBreaks.map(q=>v[q]??"")])
        )}>↓ CSV</button>}

        {/* JSON — normalized, machine readable */}
        {caps.canExportJSON && <button className="btn" onClick={()=>{
          const payload = rows.map(([sku,v])=>({
            child_sku: sku, parent_sku: v.parent_sku, parent_name: v.parent_name,
            variant_name: v.variant_name, category: v.category, tier: activeTier,
            prices: Object.fromEntries(sheetBreaks.filter(q=>v[q]!=null).map(q=>[q,v[q]])),
          }));
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));
          a.download = `${activeTier}-prices${effectiveCat!=="All"?"-"+effectiveCat:""}.json`;
          a.click();
        }}>↓ JSON</button>}

        {/* Sage 50 — parent SKU stub, admin only */}
        {caps.canExportSage && <button className="btn" style={{
          borderColor:"var(--gold)", color:"var(--gold)",
          opacity:0.6, cursor:"not-allowed",
          display:"flex", alignItems:"center", gap:5,
        }} onClick={()=>{
          const sageRows = buildSageExport(allData);
          const filtered = effectiveCat!=="All" ? sageRows.filter(r=>r.category===effectiveCat) : sageRows;
          downloadCSV(
            `sage-prices${effectiveCat!=="All"?"-"+effectiveCat:""}.csv`,
            ["Item ID","Price Level 1","Price Level 2","Price Level 3","Price Level 4","Price Level 5","Price Level 6","Price Level 7","Price Level 8","Price Level 9","Price Level 10"],
            filtered.map(r=>[r.item_id,r.price_level_1,r.price_level_2,r.price_level_3,r.price_level_4,r.price_level_5,r.price_level_6,r.price_level_7,r.price_level_8,r.price_level_9,r.price_level_10])
          );
        }} title="Sage 50 price file export — item ID mapping in progress">
          ↓ Export Sage 50 Price File
          <span style={{
            fontSize:8, padding:"1px 5px", borderRadius:3,
            background:"var(--gold-bg)", color:"var(--gold)",
            fontFamily:"var(--fm)", letterSpacing:".05em",
          }}>IN PROGRESS</span>
        </button>}
      </div>

      <div className="sheet-wrap">
        <table className="st">
          <thead>
            <tr>
              <th style={{minWidth:200,maxWidth:260,position:"sticky",left:0,zIndex:11,background:"var(--s1)"}}>Product / Variant</th>
              <th style={{minWidth:90,position:"sticky",left:200,zIndex:11,background:"var(--s1)",boxShadow:"2px 0 4px rgba(0,0,0,.06)"}}>SKU</th>
              {sheetBreaks.map(q=>(
                <th key={q} className="r" style={{color: q===0 ? color : undefined, width:"1px", whiteSpace:"nowrap"}}>
                  {q===0?"Price":`${q}+`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([sku,v])=>{
              const showCat = v.category !== lastCat;
              lastCat = v.category;
              return [
                showCat && (
                  <tr key={`ch-${v.category}`} className="cat-hdr">
                    <td colSpan={2+sheetBreaks.length} style={{position:"sticky",left:0}}>{v.category}</td>
                  </tr>
                ),
                <tr key={sku}>
                  <td style={{minWidth:200,maxWidth:260,whiteSpace:"normal",position:"sticky",left:0,background:"var(--s1)",zIndex:1}}>
                    <div className="s-name">{v.parent_name}</div>
                    {v.variant_name!=="Simple" && <div className="s-var">{v.variant_name}</div>}
                  </td>
                  <td style={{position:"sticky",left:200,background:"var(--s1)",zIndex:1,boxShadow:"2px 0 4px rgba(0,0,0,.06)"}}><span className="s-sku">{sku}</span></td>
                  {sheetBreaks.map(q=>{
                    const p = v[q];
                    return (
                      <td key={q} className="r">
                        {p != null
                          ? <span className={q===0?"s-price-base":"s-price-qty"}>{fmt(p)}</span>
                          : <span style={{color:"var(--t4)"}}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              ].filter(Boolean);
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CUSTOMER VIEW ────────────────────────────────────────────────────────────
function CustomerView({ allData, caps }) {
  const [custId,      setCustId]      = useState(MOCK_CUSTOMERS[0].id);
  const [search,      setSearch]      = useState("");
  const [category,    setCategory]    = useState("All");
  const [specialFilter, setSpecialFilter] = useState("all"); // "all" | "special" | "standard"
  const cust = MOCK_CUSTOMERS.find(c=>c.id===custId);

  // Derive qty breaks from real data for this customer's tier, suppress break=1
  const custBreaks = useMemo(()=>{
    const breaks = new Set([0]);
    allData.filter(r => r.tier === cust.tier && r.qty_break !== 1).forEach(r => breaks.add(r.qty_break));
    return [...breaks].sort((a,b)=>a-b);
  },[allData, cust]);

  // All categories from real data
  const categories = useMemo(()=>{
    const s = new Set();
    allData.forEach(r => { if(r.category) s.add(decodeEntities(r.category)); });
    return [...s].sort();
  },[allData]);

  const rows = useMemo(()=>{
    const allVariants = [];
    PRODUCTS_DEF.forEach((p, pi) => {
      const parentId = 1000 + pi*10;
      p.variants.forEach((variant, vi) => {
        const childSku = `${p.sku}-${String(vi+1).padStart(3,"0")}`;
        const prices = {};
        custBreaks.forEach(qty => {
          const { price, isSpecial } = resolveCustomerPrice(allData, cust, childSku, qty);
          prices[qty] = { price, isSpecial };
        });
        allVariants.push({
          child_sku: childSku, parent_sku: p.sku, parent_name: p.name,
          variant_name: variant, category: p.cat,
          hasSpecial: !!cust.special[childSku],
          prices,
        });
      });
    });
    // Sort: special first, then by category, then by name
    return allVariants.sort((a,b)=>{
      if(a.hasSpecial !== b.hasSpecial) return b.hasSpecial ? 1 : -1;
      if(a.category !== b.category) return a.category.localeCompare(b.category);
      return a.parent_name.localeCompare(b.parent_name);
    });
  },[cust, allData, custBreaks]);

  // Effective category — search resets category filter
  const effectiveCat = search ? "All" : category;

  const filtered = useMemo(()=>{
    let list = rows;
    if(effectiveCat !== "All") list = list.filter(r=>r.category===effectiveCat);
    if(specialFilter === "special")  list = list.filter(r=>r.hasSpecial);
    if(specialFilter === "standard") list = list.filter(r=>!r.hasSpecial);
    if(search){ const q=search.toLowerCase(); list=list.filter(r=>r.parent_name.toLowerCase().includes(q)||r.child_sku.toLowerCase().includes(q)||r.category.toLowerCase().includes(q)); }
    return list;
  },[rows, effectiveCat, specialFilter, search]);

  let lastCat = null;
  const today = new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });

  function handlePDF() { window.print(); }

  function handleCSV() {
    downloadCSV(
      `${cust.name.replace(/\s+/g,"-")}-prices.csv`,
      ["sku","product","variant","category",...custBreaks.map(q=>q===0?"price":`qty_${q}_plus`)],
      filtered.map(r=>[
        r.child_sku, r.parent_name, r.variant_name, r.category,
        ...custBreaks.map(q=>r.prices[q]?.price??"")
      ])
    );
  }

  function handleJSON() {
    const payload = filtered.map(r=>({
      child_sku: r.child_sku, parent_sku: r.parent_sku,
      parent_name: r.parent_name, variant_name: r.variant_name,
      category: r.category, tier: cust.tier,
      prices: Object.fromEntries(custBreaks.filter(q=>r.prices[q]?.price!=null).map(q=>[q,r.prices[q].price])),
    }));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));
    a.download = `${cust.name.replace(/\s+/g,"-")}-prices.json`;
    a.click();
  }

  const tierColor = TIER_COLORS[cust.tier] || "var(--brand)";

  return (
    <div className="custv">
      {/* Print-only header */}
      <div className="print-cust-hdr">
        <h1>Price List — {cust.name}</h1>
        <p>Prepared {today} · Prices valid as of this date · Subject to change without notice</p>
      </div>

      {/* Demo data banner */}
      <div className="no-print" style={{
        padding:"7px 14px",background:"var(--gold-bg)",borderBottom:"1px solid var(--b1)",
        display:"flex",alignItems:"center",gap:8,
        fontFamily:"var(--fm)",fontSize:10,color:"var(--gold)",
      }}>
        ⚠ Demo data — customer-specific pricing not yet connected. This view shows the feature structure only.
      </div>

      <div className="cust-bar">
        <span style={{fontFamily:"var(--fm)",fontSize:9,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".1em"}}>Customer</span>
        <select className="cust-sel" value={custId} onChange={e=>{ setCustId(e.target.value); setSearch(""); setCategory("All"); setSpecialFilter("all"); }}>
          {MOCK_CUSTOMERS.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {/* Tier badge — screen only */}
        <span className="no-print" style={{
          padding:"3px 10px",borderRadius:20,fontSize:10,fontFamily:"var(--fm)",
          background:`${tierColor}18`,color:tierColor,border:`1px solid ${tierColor}40`,
          whiteSpace:"nowrap",
        }}>{cust.tier}</span>

        <div className="divider no-print"/>

        {/* Category filter */}
        <select className="cust-sel no-print" value={category} onChange={e=>setCategory(e.target.value)}>
          <option value="All">All Categories</option>
          {categories.map(c=><option key={c} value={c}>{c}</option>)}
        </select>

        {/* Special filter */}
        <select className="cust-sel no-print" value={specialFilter} onChange={e=>setSpecialFilter(e.target.value)}>
          <option value="all">All Pricing</option>
          <option value="special">Special Only</option>
          <option value="standard">Standard Only</option>
        </select>

        <input className="inp no-print" style={{width:180}} placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}/>
        <span style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--t3)",whiteSpace:"nowrap"}} className="no-print">
          {filtered.length} variants
        </span>
        <button className="btn btn-a no-print" onClick={handlePDF}>⊞ Print / PDF</button>
        {caps.canExportCSV && <button className="btn btn-o no-print" onClick={handleCSV}>↓ CSV</button>}
        {caps.canExportJSON && <button className="btn btn-o no-print" onClick={handleJSON}>↓ JSON</button>}
      </div>

      <div className="cust-wrap">
        <table className="ct" style={{width:"auto"}}>
          <thead>
            <tr>
              <th style={{minWidth:200,maxWidth:260,position:"sticky",left:0,zIndex:11,background:"var(--s1)"}}>Product / Variant</th>
              <th style={{position:"sticky",left:200,zIndex:11,background:"var(--s1)",boxShadow:"2px 0 4px rgba(0,0,0,.06)",minWidth:90}}>SKU</th>
              {custBreaks.map(q=><th key={q} className="r" style={{width:"1px",whiteSpace:"nowrap",color:q===0?"var(--brand)":undefined}}>{q===0?"Price":`${q}+`}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.map(row=>{
              const showCat = row.category !== lastCat;
              lastCat = row.category;
              const rowBg = row.hasSpecial ? "rgba(255,95,132,.05)" : undefined;
              return [
                showCat && (
                  <tr key={`ch-${row.category}`} className="cat-hdr">
                    <td colSpan={2+custBreaks.length} style={{position:"sticky",left:0}}>{row.category}</td>
                  </tr>
                ),
                <tr key={row.child_sku} style={{background:rowBg}}>
                  <td style={{minWidth:200,maxWidth:260,whiteSpace:"normal",position:"sticky",left:0,zIndex:1,background:row.hasSpecial?"rgba(255,95,132,.05)":"var(--s1)"}}>
                    <span style={{display:"flex",alignItems:"center",gap:5}}>
                      <span style={{fontFamily:"var(--fd)",fontWeight:600,fontSize:11}}>{row.parent_name}</span>
                      {row.hasSpecial && <span className="spec-flag no-print">★ special</span>}
                    </span>
                    {row.variant_name!=="Simple" && <div style={{fontSize:10,color:"var(--t2)",marginTop:1}}>{row.variant_name}</div>}
                  </td>
                  <td style={{position:"sticky",left:200,zIndex:1,background:row.hasSpecial?"rgba(255,95,132,.05)":"var(--s1)",boxShadow:"2px 0 4px rgba(0,0,0,.06)"}}><span className="s-sku">{row.child_sku}</span></td>
                  {custBreaks.map(q=>{
                    const {price, isSpecial} = row.prices[q] || {};
                    return (
                      <td key={q} className="r" style={{whiteSpace:"nowrap"}}>
                        {price != null
                          ? <span style={{color: q===0 ? (isSpecial?"var(--coral)":"var(--brand)") : isSpecial?"var(--coral)":"var(--text)"}}>{fmt(price)}</span>
                          : <span className="c-price-nil">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ].filter(Boolean);
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── AUTH GATE ────────────────────────────────────────────────────────────────
// Shown briefly while Netlify Identity initialises. Once the widget fires
// its 'init' or 'login' event this component is never seen again.
function AuthGate() {
  return (
    <div className="auth-wrap fade">
      <div className="auth-card">
        <img
          src="https://www.patioproducts.com/wp-content/uploads/2025/03/logo-3.png"
          alt="Patio Products"
          className="logo-img"
          style={{height:48,width:"auto",objectFit:"contain"}}
          onError={e=>{ e.target.style.display="none"; e.target.nextSibling.style.display="flex"; }}
        />
        <div className="auth-logo" style={{display:"none"}}>W</div>
        <div className="auth-title">PriceMatrix</div>
        <p className="auth-sub">Sign in with your Patio Products account to access pricing.</p>
        <button className="auth-btn" onClick={()=>{
          const ni = window.netlifyIdentity;
          if (ni) ni.open();
          else setTimeout(()=>window.netlifyIdentity?.open(), 500);
        }}>
          Sign In
        </button>
        <p className="auth-note">Access is restricted by role. Contact your administrator if you need an invitation.</p>
      </div>
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user,        setUser]       = useState(null);
  const [authReady,   setAuthReady]  = useState(false);
  const [dark,        setDark]       = useState(false);
  const [showImages,  setShowImages] = useState(true);
  const [view,        setView]       = useState("browse");
  const [search,      setSearch]     = useState("");
  const [category,    setCategory]   = useState("All");
  const [sortBy,      setSortBy]     = useState("name");
  const [selectedProd,setSelectedProd] = useState(null);
  const [focusChildSku,setFocusChildSku] = useState(null);

  // ── NETLIFY IDENTITY ──
  useEffect(() => {
    function initIdentity() {
      const ni = window.netlifyIdentity;
      if (!ni) { setAuthReady(true); return; }

      function toUser(u) {
        const role = u?.app_metadata?.roles?.[0] ?? "viewer";
        return { id: u.id, name: u.user_metadata?.full_name ?? u.email, email: u.email, role };
      }

      ni.on("init", u => {
        if (u) setUser(toUser(u));
        setAuthReady(true);
      });
      ni.on("login", u => {
        setUser(toUser(u));
        setView("browse");
        ni.close();
      });
      ni.on("logout", () => setUser(null));

      // If already initialized (script was cached), init may have already fired
      if (ni.currentUser()) {
        setUser(toUser(ni.currentUser()));
        setAuthReady(true);
      } else {
        // Restore hash if it was stripped before widget loaded
        if (INITIAL_HASH && (
          INITIAL_HASH.includes("invite_token") ||
          INITIAL_HASH.includes("recovery_token") ||
          INITIAL_HASH.includes("confirmation_token")
        )) {
          window.location.hash = INITIAL_HASH;
        }
        ni.init();
        // Auto-open widget for token flows
        if (INITIAL_HASH && (
          INITIAL_HASH.includes("invite_token") ||
          INITIAL_HASH.includes("recovery_token") ||
          INITIAL_HASH.includes("confirmation_token")
        )) {
          setTimeout(() => ni.open(), 800);
        }
      }
    }

    // Load the Identity widget script programmatically
    if (!window.netlifyIdentity) {
      const script = document.createElement("script");
      script.src = "https://identity.netlify.com/v1/netlify-identity-widget.js";
      script.onload = () => initIdentity();
      document.head.appendChild(script);
    } else {
      initIdentity();
    }

    return () => {
      const ni = window.netlifyIdentity;
      if (ni) { ni.off("init"); ni.off("login"); ni.off("logout"); }
    };
  }, []);

  // ── LIVE DATA ──
  const [allData,    setAllData]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState(null);

  useEffect(() => {
    fetch("/.netlify/functions/sheet-data")
      .then(r => r.json())
      .then(rows => {
        setAllData(rows);
        setLoading(false);
      })
      .catch(err => {
        setLoadError(err.message);
        setLoading(false);
      });
  }, []);

  const caps = user ? getRoleCapabilities(user.role) : null;

  const allProducts = useMemo(() => getProducts(allData), [allData]);

  const categories = useMemo(()=>{
    const m={};
    allProducts.forEach(p=>{ m[p.category]=(m[p.category]||0)+1; });
    return Object.keys(m).sort();
  },[allProducts]);

  // Build map of parent_id -> child SKUs for variant SKU search
  const childSkuMap = useMemo(()=>{
    const m = {};
    allData.forEach(r => {
      if (!m[r.parent_id]) m[r.parent_id] = new Set();
      m[r.parent_id].add(r.child_sku);
    });
    return m;
  }, [allData]);

  const filtered = useMemo(()=>{
    let list = allProducts;
    // Search is global — resets category filter
    const effectiveCat = search ? "All" : category;
    if(effectiveCat!=="All") list=list.filter(p=>p.category===effectiveCat);
    if(search){
      const q=search.toLowerCase();
      list=list.filter(p=>
        p.parent_name.toLowerCase().includes(q) ||
        p.parent_sku.toLowerCase().includes(q) ||
        [...(childSkuMap[p.parent_id]||[])].some(sku=>sku.toLowerCase().includes(q))
      );
    }
    return [...list].sort((a,b)=>{
      if(sortBy==="name") return a.parent_name.localeCompare(b.parent_name);
      if(sortBy==="sku")  return a.parent_sku.localeCompare(b.parent_sku);
      if(sortBy==="cat")  return a.category.localeCompare(b.category);
      return 0;
    });
  },[allProducts,childSkuMap,category,search,sortBy]);

  // When search yields exactly one result and matches a child SKU, auto-select it
  useEffect(()=>{
    if(search && filtered.length === 1) {
      const q = search.toLowerCase();
      setSelectedProd(filtered[0]);
      // Find the matching child SKU
      const matchingSku = [...(childSkuMap[filtered[0].parent_id]||[])].find(sku=>sku.toLowerCase().includes(q));
      setFocusChildSku(matchingSku || null);
    } else if(!search) {
      setFocusChildSku(null);
    }
  },[search, filtered]);

  function getWsPrice(pid) {
    return allData.find(r=>r.parent_id===pid&&r.tier==="Wholesale"&&r.qty_break===0)?.price;
  }

  if (!authReady) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--t3)"}}>
        <div style={{fontFamily:"var(--fd)",fontSize:16}}>Loading…</div>
      </div>
    </div>
  );

  if (!user) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <AuthGate/>
    </div>
  );

  if (loading) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
        <img
          src="https://www.patioproducts.com/wp-content/uploads/2025/03/logo-3.png"
          alt="Patio Products"
          style={{height:48,width:"auto",objectFit:"contain",mixBlendMode:"multiply",opacity:.7}}
          onError={e=>e.target.style.display="none"}
        />
        <div style={{
          width:36,height:36,borderRadius:"50%",
          border:"3px solid var(--b2)",borderTopColor:"var(--brand)",
          animation:"spin .7s linear infinite",
        }}/>
        <div style={{textAlign:"center",display:"flex",flexDirection:"column",gap:4}}>
          <div style={{fontFamily:"var(--fd)",fontSize:15,color:"var(--text)"}}>Loading pricing data…</div>
          <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--t3)"}}>Fetching from Google Sheets</div>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (loadError) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,color:"var(--coral)"}}>
        <div style={{fontFamily:"var(--fd)",fontSize:18}}>Failed to load pricing data</div>
        <div style={{fontFamily:"var(--fm)",fontSize:11,color:"var(--t3)"}}>{loadError}</div>
      </div>
    </div>
  );

  const showSidebar = view==="browse" || view==="sheet";

  return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>

      {/* TOPBAR */}
      <header className="topbar">
        <img
          src="https://www.patioproducts.com/wp-content/uploads/2025/03/logo-3.png"
          alt="Patio Products"
          className="logo-img"
          style={{height:32,width:"auto",objectFit:"contain",flexShrink:0}}
          onError={e=>{ e.target.style.display="none"; e.target.nextSibling.style.display="flex"; }}
        />
        <div className="logo" style={{display:"none"}}>W</div>
        <span className="brand">PriceMatrix</span>
        <div className="divider"/>
        <nav className="nav">
          <button className={`nav-btn ${view==="browse"?"active":""}`} onClick={()=>setView("browse")}>⊞ Products</button>
          {caps.canViewSheet && (
            <button className={`nav-btn ${view==="sheet"?"active":""}`} onClick={()=>setView("sheet")}>⋮ Sheet View</button>
          )}
          {caps.canViewCustomers && (
            <button className={`nav-btn ${view==="customer"?"active cust-active":""}`} onClick={()=>setView("customer")}>👤 Customer View</button>
          )}
        </nav>
        <div className="topbar-end">
          {caps.canSync && (
            <button
              className="btn no-print"
              title="Coming soon — will trigger n8n to pull latest pricing from the website"
              style={{
                opacity:0.5, cursor:"not-allowed",
                borderColor:"var(--brand)", color:"var(--brand)",
                fontSize:11, display:"flex", alignItems:"center", gap:5,
              }}
              onClick={e=>e.preventDefault()}
            >
              ↻ Update Prices from Website
              <span style={{
                fontSize:8, padding:"1px 5px", borderRadius:3,
                background:"var(--brand-dim)", color:"var(--brand)",
                fontFamily:"var(--fm)", letterSpacing:".05em",
              }}>COMING SOON</span>
            </button>
          )}
          <button className="theme-btn" onClick={()=>setDark(d=>!d)} title={dark?"Switch to light mode":"Switch to dark mode"}>
            {dark ? "☀" : "◑"}
          </button>
          <button className="theme-btn" onClick={()=>setShowImages(s=>!s)} title={showImages?"Hide images":"Show images"}
            style={!showImages?{color:"var(--t4)"}:{}}>
            ⊟
          </button>
          <div className="user-chip" onClick={()=>window.netlifyIdentity?.logout()} title="Click to sign out">
            <div className="user-avatar">{user.name[0]}</div>
            {user.name}
            <span className="role-badge">{user.role}</span>
          </div>
        </div>
      </header>

      <div className="body">
        {/* SIDEBAR */}
        {showSidebar && (
          <aside className="sidebar">
            {view==="browse" && (
              <div className="sb-sec">
                <div className="sb-lbl">Search</div>
                <input className="inp" placeholder="Name or SKU…" value={search} onChange={e=>setSearch(e.target.value)}/>
              </div>
            )}
            <div className="sb-sec">
              <div className="sb-lbl">Category</div>
              <div className="cat-list">
                <button className={`cat-btn ${category==="All"?"on":""}`} onClick={()=>{ setCategory("All"); setSelectedProd(null); }}>
                  All <span className="cat-cnt">{allProducts.length}</span>
                </button>
                {categories.map(cat=>(
                  <button key={cat} className={`cat-btn ${category===cat?"on":""}`} onClick={()=>{ setCategory(cat); setSelectedProd(null); }}>
                    {cat} <span className="cat-cnt">{allProducts.filter(p=>p.category===cat).length}</span>
                  </button>
                ))}
              </div>
            </div>
            {view==="browse" && (
              <div className="sb-sec">
                <div className="sb-lbl">Sort</div>
                <select className="sel" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
                  <option value="name">Name A→Z</option>
                  <option value="sku">SKU</option>
                  <option value="cat">Category</option>
                </select>
              </div>
            )}
            <div className="sb-sec" style={{flex:1}}>
              <div className="sb-lbl">Tiers (your access)</div>
              <div className="tier-legend">
                {caps.tiers.map(t=>(
                  <div key={t} className="tleg-row">
                    <span className="tdot" style={{background:TIER_COLORS[t]}}/>
                    <span style={{color:t==="Wholesale"?"var(--ws)":undefined}}>{t}</span>
                    {t==="Wholesale"&&<span className="ws-tag">BASE</span>}
                  </div>
                ))}
              </div>
              {user.role==="admin"&&(
                <p className="oem-note">OEM tier hidden.<br/>Replaced by customer‑specific pricing.</p>
              )}
            </div>
          </aside>
        )}

        {/* MAIN */}
        <div className="main">
          {/* BROWSE */}
          {view==="browse" && (
            <>
              <div className="grid">
                {filtered.length===0 && <div className="empty"><h3>No products found</h3><p>Adjust search or category</p></div>}
                {filtered.map(p=>{
                  const wsPrice = getWsPrice(p.parent_id);
                  const vars = getVariants(allData, p.parent_id);
                  const isSimple = vars.length===1&&vars[0].variant_name==="Simple";
                  return (
                    <div key={p.parent_id} className={`pcard ${selectedProd?.parent_id===p.parent_id?"on":""}`}
                      onClick={()=>setSelectedProd(p)}>
                      {showImages && (
                        <div className="pcard-img-wrap">
                          <img
                            className="pcard-img"
                            src={p.image_url}
                            alt={p.parent_name}
                            onError={e=>{ e.target.style.display="none"; e.target.nextSibling.style.display="flex"; }}
                          />
                          <div className="pcard-img-ph" style={{display:"none"}}>
                            <span>{p.category[0]}</span>
                          </div>
                        </div>
                      )}
                      <div className="pcard-body">
                        <div className="pcard-cat">{p.category}</div>
                        <div className="pcard-name">{p.parent_name}</div>
                        <div className="pcard-sku">{p.parent_sku}</div>
                        {!isSimple&&<div className="pcard-vars">{vars.map(v=><span key={v.child_id} className="vtag">{v.variant_name}</span>)}</div>}
                        <div className="pcard-price-row">
                          {wsPrice&&<span className="pcard-price">{fmt(wsPrice)}</span>}
                          <span className="pcard-plbl">wholesale</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {selectedProd ? (
                <DetailPanel key={selectedProd.parent_id} product={selectedProd} visibleTiers={caps.tiers} onClose={()=>{setSelectedProd(null);setFocusChildSku(null);}} allData={allData} focusChildSku={focusChildSku} caps={caps}/>
              ) : (
                <div className="detail" style={{display:"flex"}}>
                  <div className="nosel">
                    <div className="nosel-icon">◫</div>
                    <div className="nosel-title">Select a product</div>
                    <div className="nosel-sub">Click any card to view the full price matrix with % vs Wholesale</div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* SHEET VIEW */}
          {view==="sheet" && caps.canViewSheet && (
            <SheetView category={category} visibleTiers={caps.tiers} allData={allData} caps={caps}/>
          )}

          {/* CUSTOMER VIEW */}
          {view==="customer" && caps.canViewCustomers && (
            <CustomerView allData={allData} caps={caps}/>
          )}
        </div>
      </div>
    </div>
  );
}
