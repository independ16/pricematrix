import { useState, useMemo, useCallback, useEffect, useRef } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TIERS = ["Retail", "Commercial", "Wholesale", "Wholesale_L2", "Wholesale_L3"];
const ALL_TIERS = [...TIERS, "OEM"];

const TIER_COLORS = {
  Retail:       "#c94040",
  Commercial:   "#b87020",
  Wholesale:    "#3a7d58",
  Wholesale_L2: "#2271a8",
  Wholesale_L3: "#5a5aaa",
  OEM:          "#888888",
};

// ─── SUPABASE AUTH ────────────────────────────────────────────────────────────
const SB_URL      = "https://lhtkmuvfiqbnkppwvsjj.supabase.co";
const SB_ANON_KEY = "sb_publishable_H3M7RiA4omp-KvMy2s3plg_ce4wO0BV";

// Helpers — call Supabase REST auth endpoints directly (no SDK)
async function sbSignIn(email, password) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "apikey": SB_ANON_KEY },
    body:    JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Sign-in failed");
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function sbRefresh(refreshToken) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "apikey": SB_ANON_KEY },
    body:    JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Token refresh failed");
  return data;
}

async function sbSendPasswordReset(email) {
  const res = await fetch(`${SB_URL}/auth/v1/recover`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "apikey": SB_ANON_KEY },
    body:    JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error_description || data.msg || "Reset request failed");
  }
}

async function sbUpdatePassword(accessToken, newPassword) {
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    method:  "PUT",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SB_ANON_KEY,
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error_description || data.msg || "Password update failed");
  }
}

// Persist session to localStorage
function saveSession(session) {
  localStorage.setItem("pm_session", JSON.stringify({
    access_token:  session.access_token,
    refresh_token: session.refresh_token,
    expires_at:    Date.now() + (session.expires_in || 3600) * 1000,
  }));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem("pm_session") || "null"); } catch { return null; }
}
function clearSession() { localStorage.removeItem("pm_session"); }

// ─── CATEGORIES TO EXCLUDE FROM SHEET VIEW / PRINT BY DEFAULT ────────────────
// Edit this list to control which categories are hidden from Sheet View.
// Users can still reveal them by toggling in the filter UI.
const DEFAULT_EXCLUDED_CATEGORIES = [
  "Ottoman",
  "Double Layer Sling",
  "Padded Sling",
  "Standard Sling",
  "Uncategorized",
];

// ─── ROLE CAPABILITIES ────────────────────────────────────────────────────────
function getRoleCapabilities(role) {
  switch(role) {
    case "admin":      return { tiers:TIERS, canViewCustomers:true,  canViewSheet:true,  canExportCSV:true,  canExportJSON:true,  canExportSage:true,  canSync:true  };
    case "manager":    return { tiers:TIERS, canViewCustomers:true,  canViewSheet:true,  canExportCSV:true,  canExportJSON:false, canExportSage:false, canSync:false };
    case "viewer":     return { tiers:TIERS, canViewCustomers:false, canViewSheet:true,  canExportCSV:false, canExportJSON:false, canExportSage:false, canSync:false };
    case "commercial": return { tiers:["Commercial"], canViewCustomers:false, canViewSheet:true,  canExportCSV:false, canExportJSON:false, canExportSage:false, canSync:false };
    case "wholesale":  return { tiers:["Wholesale","Wholesale_L2","Wholesale_L3"], canViewCustomers:false, canViewSheet:true, canExportCSV:false, canExportJSON:false, canExportSage:false, canSync:false };
    case "retail":     return { tiers:["Retail"], canViewCustomers:false, canViewSheet:true, canExportCSV:false, canExportJSON:false, canExportSage:false, canSync:false };
    default:           return { tiers:[], canViewCustomers:false, canViewSheet:false, canExportCSV:false, canExportJSON:false, canExportSage:false, canSync:false };
  }
}

// ─── CUSTOMER PRICING ────────────────────────────────────────────────────────
// Price source constants — used for badges and filtering in Customer View
const PRICE_SOURCE = { SPECIFIC: "specific", RATIO: "ratio", WL3: "wl3" };

// Human-readable customer names keyed by customer_id (string)
// Add entries here as new customers are onboarded
const CUSTOMER_NAMES = {
  "425":  "PAVCO Furniture, Inc.",
  "483":  "A&K Enterprise of Manatee",
  "418":  "Florida Patio / Alumatech",
  "441":  "Leisure Furniture",
  "601":  "Alumatech",
};

// Customers who receive generic ratio pricing (blank customer_id staging rows)
// for SKUs without a hand-set specific price. All others fall through to WL3.
const RATIO_CUSTOMERS = new Set(["483"]);

// ─── PASSWORD SET GATE ───────────────────────────────────────────────────────
// Shown when the app is opened via a Supabase recovery/invite link.
// The URL hash contains an access_token with type=recovery or type=invite.
function PasswordSetGate({ dark, accessToken, onDone }) {
  const [password,   setPassword]   = useState("");
  const [confirm,    setConfirm]    = useState("");
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);
  const [done,       setDone]       = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm)  { setError("Passwords do not match."); return; }
    setError(""); setLoading(true);
    try {
      await sbUpdatePassword(accessToken, password);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div className="auth-wrap">
        <div className="auth-card">
          <LogoImg size={56} className="auth-logo"/>
          <div className="auth-title">PriceMatrix</div>
          <div className="auth-sub">Patio Products, Inc. · Set your password</div>
          {done ? (
            <>
              <div className="auth-reset-msg" style={{marginBottom:16}}>
                ✓ Password set successfully!<br/>You can now sign in with your new password.
              </div>
              <button className="auth-btn" onClick={onDone}>Go to sign in</button>
            </>
          ) : (
            <form className="auth-form" onSubmit={handleSubmit}>
              {error && <div className="auth-err">{error}</div>}
              <div className="auth-field">
                <label className="auth-label">New Password</label>
                <input className="auth-inp" type="password" placeholder="Minimum 8 characters"
                  value={password} onChange={e=>setPassword(e.target.value)} autoFocus required/>
              </div>
              <div className="auth-field">
                <label className="auth-label">Confirm Password</label>
                <input className="auth-inp" type="password" placeholder="Re-enter your password"
                  value={confirm} onChange={e=>setConfirm(e.target.value)} required/>
              </div>
              <button className="auth-btn" type="submit" disabled={loading}>
                {loading ? "Setting password…" : "Set password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DATA HELPERS ─────────────────────────────────────────────────────────────
const fmt  = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
const fmtP = n => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

function decodeEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
            .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g," ");
}

function getProducts(data) {
  const map = new Map();
  data.forEach(r => {
    if (!map.has(r.parent_id)) map.set(r.parent_id, {
      parent_id: r.parent_id, parent_sku: r.parent_sku,
      parent_name: decodeEntities(r.parent_name),
      category: decodeEntities(r.category),
      image_url: r.image_url, slug: r.slug,
    });
  });
  return [...map.values()];
}

function getVariants(data, parentId) {
  const map = new Map();
  data.filter(r => r.parent_id === parentId).forEach(r => {
    if (!map.has(r.child_id))
      map.set(r.child_id, { child_id:r.child_id, child_sku:r.child_sku, variant_name:decodeEntities(r.variant_name) });
  });
  return [...map.values()];
}

function buildMatrix(data, parentId) {
  const m = {};
  data.filter(r => r.parent_id === parentId).forEach(r => {
    m[r.child_id] ??= {};
    m[r.child_id][r.tier] ??= {};
    m[r.child_id][r.tier][Number(r.qty_break)] = r.price;
  });
  return m;
}

// For sheet view: { [childSku]: { parent_sku, parent_name, variant_name, category, slug, [qty]: price } }
// For WL2/WL3, missing or zero qty_break prices are silently filled from Wholesale.
function getTierFlat(data, tier) {
  const m = {};
  data.filter(r => r.tier === tier).forEach(r => {
    m[r.child_sku] ??= {
      parent_sku: r.parent_sku,
      parent_name: decodeEntities(r.parent_name),
      variant_name: decodeEntities(r.variant_name),
      category: decodeEntities(r.category),
      slug: r.slug,
    };
    m[r.child_sku][r.qty_break] = r.price;
  });
  // For WL2/WL3: fill missing/zero breaks from Wholesale rows
  if (tier === "Wholesale_L2" || tier === "Wholesale_L3") {
    const wsFlat = {};
    data.filter(r => r.tier === "Wholesale").forEach(r => {
      wsFlat[r.child_sku] ??= {};
      wsFlat[r.child_sku][r.qty_break] = r.price;
    });
    Object.keys(m).forEach(sku => {
      const ws = wsFlat[sku] || {};
      const maxOwn = Math.max(0, ...Object.keys(m[sku]).map(Number).filter(b => b !== 1));
      Object.keys(ws).filter(k => !isNaN(k)).map(Number).filter(b => b !== 1 && b <= maxOwn).forEach(b => {
        if (!m[sku][b] && ws[b]) {
          m[sku][b] = ws[b];
        }
      });
    });
  }
  return m;
}

// Resolve a WL2 or WL3 price for display: use actual data if present (and non-zero),
// otherwise fall back silently to the Wholesale price at the same qty_break.
function resolveWLPrice(matrix, childId, tier, qb) {
  const actual = matrix[childId]?.[tier]?.[qb];
  if (actual) return actual;
  // For WL3: don't fill beyond WL3's own highest break
  if (tier === "Wholesale_L3") {
    const ownBreaks = Object.keys(matrix[childId]?.[tier] || {}).map(Number).filter(b => b !== 1);
    const maxOwn = ownBreaks.length ? Math.max(...ownBreaks) : 0;
    if (qb > maxOwn) return null;
  }
  return matrix[childId]?.Wholesale?.[qb] ?? null;
}

function buildSageExport(data) {
  const map = {};
  data.forEach(r => {
    if (r.qty_break !== 0) return;
    map[r.parent_sku] ??= {
      item_id:r.parent_sku, parent_name:decodeEntities(r.parent_name), category:decodeEntities(r.category),
      price_level_1:0,price_level_2:0,price_level_3:0,price_level_4:0,price_level_5:0,
      price_level_6:0,price_level_7:0,price_level_8:0,price_level_9:0,price_level_10:0,
    };
    if (r.tier==="Wholesale")  map[r.parent_sku].price_level_1 = r.price;
    if (r.tier==="Commercial") map[r.parent_sku].price_level_8 = r.price;
    if (r.tier==="Retail")     map[r.parent_sku].price_level_10 = r.price;
  });
  return Object.values(map).sort((a,b) => a.item_id.localeCompare(b.item_id));
}

function pctVsWholesale(price, wsPrice) {
  if (!wsPrice) return null;
  return ((price - wsPrice) / wsPrice) * 100;
}

// Build a tier-price index for fast Customer View lookups:
// index[child_sku][tier] = sorted array of {qty_break, price}
function buildCustomerIndex(data) {
  // Index structure:
  //   idx[child_id] = {
  //     specific:  { [customer_id]: [{ qty_break, price }, ...] },  // Customer_Specific_Pricing rows (hand-set unit prices)
  //     custRatio: { [customer_id]: [{ qty_break, price }, ...] },  // Staging rows with a customer_id (e.g. FL Patio 418)
  //     ratio:     [{ qty_break, price }, ...],                      // Staging rows, customer_id blank (generic ratio)
  //     wl3:       [{ qty_break, price }, ...],                      // Wholesale_L3 fallback
  //   }
  const idx = {};
  data.forEach(r => {
    if (Number(r.qty_break) === 1 && r.tier !== "Customer") return; // skip sentinel (preserve col M customer rows)
    const cid = String(r.child_id);
    idx[cid] ??= { specific: {}, custRatio: {}, ratio: [], wl3: [] };
    if (r.tier === "Customer") {
      const custId = String(r.customer_id ?? "").trim();
      if (custId !== "") {
        if (r._src === "ratio") {
          // Staging row with a customer_id — treat as ratio pricing, not a hand-set specific price
          idx[cid].custRatio[custId] ??= [];
          idx[cid].custRatio[custId].push({ qty_break: Number(r.qty_break), price: Number(r.price) });
        } else {
          // Customer_Specific_Pricing row — genuine hand-set unit price
          idx[cid].specific[custId] ??= [];
          idx[cid].specific[custId].push({ qty_break: Number(r.qty_break), price: Number(r.price) });
        }
      } else {
        idx[cid].ratio.push({ qty_break: Number(r.qty_break), price: Number(r.price) });
      }
    } else if (r.tier === "Wholesale_L3") {
      idx[cid].wl3.push({ qty_break: Number(r.qty_break), price: Number(r.price) });
    }
  });
  // Sort all break arrays descending for lookup
  Object.values(idx).forEach(entry => {
    Object.values(entry.specific).forEach(arr => arr.sort((a,b) => b.qty_break - a.qty_break));
    Object.values(entry.custRatio).forEach(arr => arr.sort((a,b) => b.qty_break - a.qty_break));
    entry.ratio.sort((a,b) => b.qty_break - a.qty_break);
    entry.wl3.sort((a,b) => b.qty_break - a.qty_break);
  });
  return idx;
}

function resolveCustomerPrice(idx, childId, customerId, qty) {
  // Three-level lookup: specific → ratio → wl3 fallback
  // Returns { price, source } where source is a PRICE_SOURCE constant
  const entry = idx[String(childId)];
  if (!entry) return { price: null, source: null };
  // Treat price=0 as missing — zero prices are sentinel/unfilled rows
  const resolve = (arr) => {
    const match = arr.find(r => qty >= r.qty_break && r.price > 0);
    return match?.price ?? arr.find(r => r.qty_break === 0 && r.price > 0)?.price ?? null;
  };
  // 1. Customer-specific override (col M / Customer_Specific_Pricing tab)
  const specArr = entry.specific[String(customerId)];
  if (specArr?.length) {
    const price = resolve(specArr);
    if (price != null) return { price, source: PRICE_SOURCE.SPECIFIC };
  }
  // 2. Customer ratio (staging rows with this customer's ID, e.g. FL Patio 418)
  const custRatioArr = entry.custRatio[String(customerId)];
  if (custRatioArr?.length) {
    const price = resolve(custRatioArr);
    if (price != null) return { price, source: PRICE_SOURCE.RATIO };
  }
  // 3. Generic ratio fallback — only for customers who receive ratio pricing
  if (RATIO_CUSTOMERS.has(String(customerId)) && entry.ratio.length) {
    const price = resolve(entry.ratio);
    if (price != null) return { price, source: PRICE_SOURCE.RATIO };
  }
  // 3. WL3 fallback (no customer pricing exists for this SKU)
  if (entry.wl3.length) {
    const price = resolve(entry.wl3);
    if (price != null) return { price, source: PRICE_SOURCE.WL3 };
  }
  return { price: null, source: null };
}

function downloadCSV(filename, headers, rows) {
  const WATERMARK = "CONFIDENTIAL — Property of Patio Products, Inc. Not for distribution.";
  const csv = [
    `# ${WATERMARK}`,
    headers.join(","),
    ...rows.map(r => r.map(v =>
      typeof v==="string"&&(v.includes(",")||v.includes('"'))
        ? `"${v.replace(/"/g,'""')}"` : v??""
    ).join(","))
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download = filename; a.click();
}

function downloadJSON(filename, payload) {
  const wrapped = {
    _watermark: "CONFIDENTIAL — Property of Patio Products, Inc. Not for distribution.",
    generated: new Date().toISOString(),
    data: payload,
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(wrapped,null,2)],{type:"application/json"}));
  a.download = filename; a.click();
}

// ─── RED FLAG ANALYSIS ────────────────────────────────────────────────────────
function computeRedFlags(data) {
  // Build lookup structures
  const byParent = {};   // parent_id → [rows]
  const byChild  = {};   // child_id → [rows]
  const parentChildCount = {}; // parent_id → Set of child_ids

  data.forEach(r => {
    (byParent[r.parent_id] ??= []).push(r);
    (byChild[r.child_id]  ??= []).push(r);
    (parentChildCount[r.parent_id] ??= new Set()).add(r.child_id);
  });

  const flags = {}; // parent_id → [flag strings]

  const addFlag = (parentId, msg) => {
    (flags[parentId] ??= []).push(msg);
  };

  // Build a product map for metadata
  const productMeta = {};
  data.forEach(r => {
    if (!productMeta[r.parent_id]) productMeta[r.parent_id] = {
      parent_sku: r.parent_sku,
      parent_name: decodeEntities(r.parent_name),
      category: decodeEntities(r.category),
      image_url: r.image_url,
      slug: r.slug,
    };
  });

  Object.entries(byParent).forEach(([parentId, rows]) => {
    const childIds = [...(parentChildCount[parentId] || [])];

    // Flag 1: Wholesale regular price is 0 or missing
    const wsBase = rows.find(r => r.tier==="Wholesale" && r.qty_break===0);
    if (!wsBase || !wsBase.price || wsBase.price === 0) {
      addFlag(parentId, "Missing or zero Wholesale base price");
    }

    // Flag 2: qty_break 0 price ≠ qty_break 1 price for same product+tier+child
    const tierChildCombos = new Map();
    rows.forEach(r => {
      const key = `${r.child_id}__${r.tier}`;
      if (!tierChildCombos.has(key)) tierChildCombos.set(key, { variantName: decodeEntities(r.variant_name), childId: r.child_id });
      const entry = tierChildCombos.get(key);
      entry[r.qty_break] = r.price;
    });
    tierChildCombos.forEach((entry, key) => {
      if (entry[0] != null && entry[1] != null && entry[0] !== entry[1]) {
        const tier = key.split("__")[1];
        const variantLabel = childIds.length > 1 && entry.variantName && entry.variantName !== "Simple"
          ? ` [${entry.variantName}]` : "";
        addFlag(parentId, `qty_break 0 ≠ qty_break 1${variantLabel} (${tier}) — sentinel mismatch`);
      }
    });

    // Flag 5: No quantity discounts — check across all tiers, consolidate into one flag
    const tierBreaks = {};
    rows.forEach(r => {
      if (r.qty_break === 1) return; // skip sentinel
      (tierBreaks[r.tier] ??= new Set()).add(r.qty_break);
    });
    const tiersWithNoDiscounts = TIERS.filter(tier => {
      const breaks = [...(tierBreaks[tier]||[])].filter(b=>b!==0);
      return breaks.length === 0 && tierBreaks[tier]?.has(0);
    });
    if (tiersWithNoDiscounts.length === TIERS.length) {
      addFlag(parentId, "No quantity discounts on any tier");
    } else if (tiersWithNoDiscounts.length > 0) {
      addFlag(parentId, `No quantity discounts for: ${tiersWithNoDiscounts.join(", ")}`);
    }

    // Flag 6: Variable product with only 1 variant (parent_id ≠ child_id, not Simple, and no siblings)
    const isSimpleProduct = childIds.length === 1 && (
      childIds[0] === parentId ||
      rows.some(r => r.child_id === childIds[0] && decodeEntities(r.variant_name) === "Simple")
    );
    if (childIds.length === 1 && !isSimpleProduct) {
      addFlag(parentId, "Variable product with only 1 variant");
    }

    // Flag 7: Retail > Commercial > Wholesale price order violated
    const ret = rows.find(r=>r.tier==="Retail"&&r.qty_break===0)?.price;
    const com = rows.find(r=>r.tier==="Commercial"&&r.qty_break===0)?.price;
    const ws  = rows.find(r=>r.tier==="Wholesale"&&r.qty_break===0)?.price;
    if (ret!=null && com!=null && ws!=null) {
      if (!(ret > com && com > ws)) {
        addFlag(parentId, `Price tier order violated: Retail(${fmt(ret)}) > Commercial(${fmt(com)}) > Wholesale(${fmt(ws)}) not satisfied`);
      }
    }

    // Flag 8: Statistical outlier — price deviates >40% from median within product+tier qty ladder
    childIds.forEach(childId => {
      const variantLabel = childIds.length > 1
        ? (() => { const r = rows.find(rr=>rr.child_id===childId); return r ? ` [${decodeEntities(r.variant_name)||r.child_sku}]` : ""; })()
        : "";
      TIERS.forEach(tier => {
        const priceRows = rows.filter(r => r.child_id===childId && r.tier===tier && r.qty_break!==1 && r.price!=null && r.price > 0);
        if (priceRows.length < 3) return;
        const prices = priceRows.map(r=>r.price).sort((a,b)=>a-b);
        const mid = Math.floor(prices.length/2);
        const median = prices.length%2===0 ? (prices[mid-1]+prices[mid])/2 : prices[mid];
        priceRows.forEach(r => {
          const dev = Math.abs(r.price - median) / median;
          if (dev > 0.40) {
            addFlag(parentId, `Possible price typo${variantLabel}: ${tier} qty ${r.qty_break} = ${fmt(r.price)} (median ${fmt(median)}, ${(dev*100).toFixed(0)}% off)`);
          }
        });
      });
    });

    // Flag 9: Image URL missing
    const meta = productMeta[parentId];
    if (!meta?.image_url || meta.image_url.trim()==="") {
      addFlag(parentId, "Missing image URL");
    }

    // Flag 10: Price does not decrease as qty increases (within same tier+child)
    childIds.forEach(childId => {
      const variantLabel = childIds.length > 1
        ? (() => { const r = rows.find(rr=>rr.child_id===childId); return r ? ` [${decodeEntities(r.variant_name)||r.child_sku}]` : ""; })()
        : "";
      TIERS.forEach(tier => {
        const priceRows = rows
          .filter(r=>r.child_id===childId && r.tier===tier && r.qty_break!==1 && r.price!=null)
          .sort((a,b)=>a.qty_break-b.qty_break);
        for (let i=1; i<priceRows.length; i++) {
          if (priceRows[i].price > priceRows[i-1].price) {
            addFlag(parentId, `${tier}${variantLabel}: price increases at qty ${priceRows[i].qty_break} vs ${priceRows[i-1].qty_break}`);
            break;
          }
        }
      });
    });

    // Flag 11: Duplicate child SKUs across different parents (detected per-row in a global pass below)
    // Flag 12: Category is Uncategorized
    if (!productMeta[parentId]?.category || productMeta[parentId].category.toLowerCase()==="uncategorized") {
      addFlag(parentId, "Category is Uncategorized");
    }

    // Flag 13: Variant name is blank on a multi-variant product
    const blankVariant = rows.find(r => !r.variant_name || r.variant_name.trim()==="");
    if (blankVariant && childIds.length > 1) {
      addFlag(parentId, "Blank variant name on multi-variant product");
    }
  });

  // Flag 11 (global): child SKU appears under multiple parent IDs
  const skuParents = {};
  data.forEach(r => {
    (skuParents[r.child_sku] ??= new Set()).add(r.parent_id);
  });
  Object.entries(skuParents).forEach(([sku, parents]) => {
    if (parents.size > 1) {
      [...parents].forEach(pid => {
        addFlag(pid, `Child SKU ${sku} appears in ${parents.size} different parent products`);
      });
    }
  });

  // Return as array of {parent_id, flags[], ...meta}
  return Object.entries(flags).map(([parentId, flagList]) => ({
    parent_id: parentId,
    ...productMeta[parentId],
    flags: [...new Set(flagList)], // deduplicate
  })).sort((a,b) => (b.flags.length - a.flags.length));
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,400;0,500;1,400&family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── LIGHT MODE ── */
:root{
  --bg:#e8ecf0;--s1:#f0f3f6;--s2:#e2e7ec;--s3:#d4dbe3;--s4:#c6d0da;
  --b1:#c0cad5;--b2:#aab6c4;--b3:#8fa0b2;
  --brand:#3a7d58;--brand-lt:#489367;--brand-dim:rgba(72,147,103,.12);
  --coral:#ff5f84;--coral-dim:rgba(255,95,132,.12);
  --text:#1a2530;--t2:#4a5f70;--t3:#7a8fa0;--t4:#b0bfcc;
  --ws:#2d6e47;--ws-bg:rgba(72,147,103,.1);
  --above:#c94040;--above-bg:rgba(201,64,64,.1);
  --below:#2d7a5a;--below-bg:rgba(45,122,90,.1);
  --gold:#8a6800;--gold-bg:rgba(138,104,0,.08);
  --err:#c94040;--err-bg:rgba(201,64,64,.08);
  --warn:#c97a00;--warn-bg:rgba(201,122,0,.08);
  --fd:'Syne',sans-serif;--fm:'DM Mono',monospace;--fb:'DM Sans',sans-serif;
  --r:7px;--shadow:0 1px 4px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06);
}

/* ── DARK MODE ── */
.dark{
  --bg:#0d1117;--s1:#161c24;--s2:#1c2430;--s3:#212c3a;--s4:#283444;
  --b1:#2a3a4a;--b2:#344a5e;--b3:#3d5870;
  --brand:#489367;--brand-lt:#5aad7a;--brand-dim:rgba(72,147,103,.15);
  --coral:#ff5f84;--coral-dim:rgba(255,95,132,.15);
  --text:#dce6f0;--t2:#7a9ab0;--t3:#4a6478;--t4:#2a3c4e;
  --ws:#5aad7a;--ws-bg:rgba(90,173,122,.1);
  --above:#ff7a7a;--above-bg:rgba(255,122,122,.1);
  --below:#4cc9f0;--below-bg:rgba(76,201,240,.1);
  --gold:#f0c040;--gold-bg:rgba(240,192,64,.1);
  --err:#ff7a7a;--err-bg:rgba(255,122,122,.1);
  --warn:#f0a040;--warn-bg:rgba(240,160,64,.1);
  --shadow:0 2px 8px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.2);
}

body{background:var(--bg);color:var(--text);font-family:var(--fb);font-size:13px;line-height:1.5;overflow:hidden;transition:background .2s,color .2s}
.app{display:flex;flex-direction:column;height:100vh}

/* ── TOPBAR ── */
.topbar{height:52px;padding:0 20px;background:var(--s1);border-bottom:1px solid var(--b1);display:flex;align-items:center;gap:16px;flex-shrink:0;z-index:100;box-shadow:var(--shadow);}
.logo{width:30px;height:30px;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--brand);}
.logo img{width:30px;height:30px;object-fit:contain;mix-blend-mode:multiply;}
.dark .logo img{mix-blend-mode:normal;opacity:.85;}
.logo-fallback{font-family:var(--fd);font-weight:800;font-size:13px;color:#fff;letter-spacing:-.5px;}
.brand{font-family:var(--fd);font-weight:700;font-size:16px;letter-spacing:-.3px;white-space:nowrap;flex-shrink:0;color:var(--text)}
.divider{width:1px;height:20px;background:var(--b1);flex-shrink:0}
.nav{display:flex;gap:2px}
.nav-btn{padding:5px 13px;border-radius:6px;border:none;background:transparent;color:var(--t3);font-size:12px;font-family:var(--fb);cursor:pointer;transition:all .15s;white-space:nowrap;}
.nav-btn:hover{color:var(--t2);background:var(--s3)}
.nav-btn.active{background:var(--brand-dim);color:var(--brand);border:1px solid rgba(72,147,103,.25)}
.topbar-end{margin-left:auto;display:flex;align-items:center;gap:8px;flex-shrink:0}
.data-stats{display:flex;align-items:center;gap:10px;padding:4px 11px;border-radius:20px;background:var(--s3);border:1px solid var(--b2);font-family:var(--fm);font-size:10px;color:var(--t3);white-space:nowrap;flex-shrink:0;}
.data-stats .ds-val{color:var(--text);font-weight:500;}
.data-stats .ds-sep{opacity:.4;}
.data-stats.aging .ds-date{color:#b87020;}
.data-stats.stale .ds-date{color:#c94040;}
.theme-btn{width:32px;height:32px;border-radius:6px;border:1px solid var(--b2);background:var(--s3);color:var(--t2);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}
.theme-btn:hover{background:var(--s4);color:var(--text)}

/* ── BODY LAYOUT ── */
.body{flex:1;display:flex;overflow:hidden}
.sidebar{width:200px;min-width:200px;background:var(--s1);border-right:1px solid var(--b1);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;}
.sb-sec{padding:12px 14px;border-bottom:1px solid var(--b1)}
.sb-lbl{font-family:var(--fm);font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px}
.inp{width:100%;padding:7px 10px;background:var(--s2);border:1px solid var(--b1);border-radius:6px;color:var(--text);font-family:var(--fb);font-size:12px;outline:none;transition:border-color .2s;}
.inp:focus{border-color:var(--brand)}
.inp::placeholder{color:var(--t3)}
.cat-list{display:flex;flex-direction:column;gap:1px;overflow-y:auto;max-height:300px}
.cat-btn{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-radius:5px;border:none;background:transparent;color:var(--t2);font-size:12px;font-family:var(--fb);cursor:pointer;transition:all .12s;width:100%;text-align:left;}
.cat-btn:hover{background:var(--s3);color:var(--text)}
.cat-btn.on{background:var(--brand-dim);color:var(--brand);font-weight:500}
.cat-cnt{font-family:var(--fm);font-size:10px;color:var(--t3)}
.sel{width:100%;padding:6px 10px;background:var(--s2);border:1px solid var(--b1);border-radius:6px;color:var(--text);font-size:12px;font-family:var(--fb);outline:none;cursor:pointer;}
.sel option{background:var(--s2)}
.tier-legend{display:flex;flex-direction:column;gap:5px}
.tleg-row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--t2)}
.tdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.ws-tag{font-family:var(--fm);font-size:8px;color:var(--brand);margin-left:auto}

/* ── MAIN AREA ── */
.main{flex:1;display:flex;overflow:hidden}

/* ── CARD GRID ── */
.grid{flex:1;overflow-y:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;align-content:start;}
.pcard{background:var(--s1);border:1px solid var(--b1);border-radius:var(--r);overflow:hidden;cursor:pointer;transition:border-color .18s,box-shadow .18s,transform .18s;box-shadow:var(--shadow);min-height:80px;}
.pcard:hover{border-color:var(--brand);transform:translateY(-1px);box-shadow:0 4px 16px rgba(72,147,103,.18)}
.pcard.on{border-color:var(--brand);box-shadow:0 0 0 2px rgba(72,147,103,.35),0 2px 12px rgba(72,147,103,.2);background:var(--brand-dim)}
.pcard-flag{position:absolute;top:6px;right:6px;background:var(--err);color:#fff;font-size:8px;font-family:var(--fm);padding:2px 5px;border-radius:3px;z-index:2;}
.pcard-img-wrap{width:100%;height:110px;overflow:hidden;background:var(--s3);position:relative;flex-shrink:0}
.pcard-img{width:100%;height:110px;object-fit:cover;display:block}
.pcard-img-ph{width:100%;height:110px;position:absolute;top:0;left:0;display:none;align-items:center;justify-content:center;background:var(--s3);font-family:var(--fd);font-size:32px;font-weight:800;color:var(--brand);opacity:.25;letter-spacing:-1px;}
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
.detail{width:560px;min-width:560px;background:var(--s1);border-left:1px solid var(--b1);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;box-shadow:-2px 0 12px rgba(0,0,0,.05);}
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
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-a{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:500}
.btn-a:hover{background:var(--brand-lt);border-color:var(--brand-lt)}
.btn-o{background:transparent;border-color:rgba(72,147,103,.4);color:var(--brand)}
.btn-o:hover{background:var(--brand-dim)}
.btn-warn{background:transparent;border-color:rgba(201,64,64,.4);color:var(--err)}
.btn-warn.on{background:var(--err-bg)}
.btn-xs{padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--b2);font-family:var(--fm);cursor:pointer;background:var(--s2);color:var(--t2)}
.btn-xs:hover{background:var(--s3);color:var(--text)}
.row-count{font-family:var(--fm);font-size:10px;color:var(--t3);margin-left:auto}

/* CALC */
.calc{padding:9px 18px;border-bottom:1px solid var(--b1);background:var(--s2);display:flex;align-items:center;gap:9px;flex-shrink:0;flex-wrap:wrap;}
.calc-lbl{font-family:var(--fm);font-size:10px;color:var(--t3);white-space:nowrap}
.calc-var{padding:5px 8px;background:var(--s1);border:1px solid var(--b1);border-radius:6px;color:var(--text);font-family:var(--fm);font-size:11px;outline:none;cursor:pointer;}
.calc-var option{background:var(--s1)}
.calc-qty{width:72px;padding:5px 8px;background:var(--s1);border:1px solid var(--b1);border-radius:6px;color:var(--text);font-family:var(--fm);font-size:12px;outline:none;transition:border-color .2s;}
.calc-qty:focus{border-color:var(--brand)}
.calc-arrow{color:var(--b3);font-size:12px}
.calc-total{font-family:var(--fm);font-size:14px;font-weight:500;color:var(--brand)}
.calc-unit{font-family:var(--fm);font-size:10px;color:var(--t3)}

/* TIER TABS */
.ttabs{padding:10px 18px 0;border-bottom:1px solid var(--b1);display:flex;gap:3px;overflow-x:auto;flex-shrink:0;background:var(--s2)}
.ttab{padding:5px 11px;border-radius:6px 6px 0 0;border:1px solid transparent;font-size:11px;font-family:var(--fm);cursor:pointer;transition:all .15s;background:transparent;color:var(--t3);white-space:nowrap;border-bottom:none;}
.ttab:hover{color:var(--t2)}
.ttab.on{background:var(--s1);border-color:var(--b1);color:var(--text);margin-bottom:-1px;padding-bottom:6px}
.det-body{flex:1;overflow-y:auto;padding:14px 18px;background:var(--bg)}

/* PRICE TABLE */
.ptw{border-radius:7px;border:1px solid var(--b1);overflow:hidden;margin-bottom:16px;background:var(--s1)}
.pt{width:100%;border-collapse:collapse;font-family:var(--fm);font-size:11px}
.pt th{padding:7px 11px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);background:var(--s2);border-bottom:1px solid var(--b1);white-space:nowrap;}
.pt th.r{text-align:right}
.pt td{padding:7px 11px;border-bottom:1px solid var(--b1);vertical-align:middle}
.pt tr:last-child td{border-bottom:none}
.pt tbody tr:hover td{background:var(--s2)}
.pt td.r{text-align:right}
.pc-ws{color:var(--ws);font-weight:500}
.pc-above{color:var(--above)}
.pc-below{color:var(--below)}
.pc-qty{color:var(--text)}
.pct{display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;margin-left:4px;vertical-align:middle;font-family:var(--fm)}
.pct-up{background:var(--above-bg);color:var(--above)}
.pct-ws{background:var(--ws-bg);color:var(--ws)}
.pct-down{background:var(--below-bg);color:var(--below)}
.msec{margin-bottom:18px}
.msec-hdr{font-family:var(--fd);font-weight:600;font-size:11px;color:var(--t2);display:flex;align-items:center;gap:7px;margin-bottom:7px}
.msec-hdr::after{content:'';flex:1;height:1px;background:var(--b1)}
.vbadge{padding:2px 7px;border-radius:20px;font-size:9px;background:var(--s3);color:var(--t2);font-family:var(--fm);border:1px solid var(--b1)}
.skubadge{font-size:9px;color:var(--t3);font-family:var(--fm)}

/* ── FLAGS ── */
.flag-panel{padding:10px 18px;border-bottom:1px solid var(--b1);background:var(--err-bg);flex-shrink:0}
.flag-list{display:flex;flex-direction:column;gap:3px;margin-top:6px;max-height:120px;overflow-y:auto}
.flag-item{font-family:var(--fm);font-size:10px;color:var(--err);display:flex;gap:5px;align-items:flex-start}
.flag-item::before{content:"▲";font-size:8px;margin-top:2px;flex-shrink:0}
.flag-badge{display:inline-flex;align-items:center;justify-content:center;background:var(--err);color:#fff;font-family:var(--fm);font-size:9px;font-weight:700;padding:1px 5px;border-radius:20px;min-width:18px;}
.flag-row-badge{background:var(--err-bg);border:1px solid rgba(201,64,64,.3);color:var(--err);font-family:var(--fm);font-size:8px;padding:1px 5px;border-radius:3px;white-space:nowrap;}

/* NO SELECTION */
.nosel{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--t3)}
.nosel-icon{font-size:36px;opacity:.2}
.nosel-title{font-family:var(--fd);font-size:14px}
.nosel-sub{font-size:11px;text-align:center;line-height:1.6;max-width:200px}

/* ── SHEET VIEW ── */
.sheet{flex:1;display:flex;flex-direction:column;overflow:hidden}
.sheet-bar{padding:9px 14px;border-bottom:1px solid var(--b1);background:var(--s1);display:flex;align-items:center;gap:9px;flex-shrink:0;flex-wrap:wrap;box-shadow:0 1px 0 var(--b1);}
.tier-pills{display:flex;gap:4px;flex-wrap:wrap}
.tier-pill{padding:4px 11px;border-radius:20px;border:1px solid var(--b2);font-size:11px;font-family:var(--fm);cursor:pointer;background:transparent;color:var(--t3);transition:all .15s;white-space:nowrap;}
.tier-pill:hover{color:var(--t2);background:var(--s3)}
.sheet-cnt{font-family:var(--fm);font-size:10px;color:var(--t3);white-space:nowrap}
.sheet-cnt span{color:var(--brand);font-weight:500}
.sheet-wrap{flex:1;overflow:auto;background:var(--bg)}
.st{border-collapse:collapse;font-family:var(--fm);font-size:11px;white-space:nowrap;width:auto}
.st th{padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);background:var(--s1);border-bottom:2px solid var(--b2);position:sticky;top:0;z-index:10;}
.st th.r{text-align:right}
.st td{padding:7px 12px;border-bottom:1px solid var(--b1);vertical-align:middle;background:var(--s1)}
.st td.r{text-align:right}
.st tbody tr:hover td{background:var(--s2)}
.s-name{font-family:var(--fd);font-weight:600;font-size:11px;color:var(--text)}
.s-var{font-size:10px;color:var(--t2);margin-top:1px}
.s-sku{font-size:9px;color:var(--t3)}
.s-price-base{color:var(--text);font-weight:500}
.s-price-qty{color:var(--t2)}
.cat-hdr td{padding:5px 12px;background:var(--s3);border-bottom:1px solid var(--b2);border-top:1px solid var(--b2);font-family:var(--fd);font-size:9px;color:var(--brand);font-weight:700;letter-spacing:.1em;text-transform:uppercase;}

/* ── CUSTOMER VIEW ── */
.custv{flex:1;display:flex;flex-direction:column;overflow:hidden}
.cust-bar{padding:9px 14px;border-bottom:1px solid var(--b1);background:var(--s1);display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap;}
.cust-sel{padding:6px 12px;border-radius:6px;border:1px solid var(--b2);background:var(--s2);color:var(--text);font-family:var(--fm);font-size:12px;outline:none;cursor:pointer;}
.cust-sel option{background:var(--s2)}
.cust-wrap{flex:1;overflow:auto;background:var(--bg)}
.ct{border-collapse:collapse;font-family:var(--fm);font-size:11px;white-space:nowrap}
.ct th{padding:7px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);background:var(--s1);border-bottom:2px solid var(--b2);position:sticky;top:0;z-index:10;}
.ct th.r{text-align:right}
.ct td{padding:7px 12px;border-bottom:1px solid var(--b1);vertical-align:middle;background:var(--s1)}
.ct td.r{text-align:right;font-family:var(--fm)}
.ct tbody tr:hover td{background:var(--s2)}
.spec-flag{font-size:8px;padding:1px 5px;border-radius:3px;background:var(--coral-dim);color:var(--coral);margin-left:5px;border:1px solid rgba(255,95,132,.2)}
.src-badge-specific{font-size:8px;padding:1px 5px;border-radius:3px;background:var(--coral-dim);color:var(--coral);margin-left:5px;border:1px solid rgba(255,95,132,.2);white-space:nowrap}
.src-badge-wl3{font-size:8px;padding:1px 5px;border-radius:3px;background:rgba(34,113,168,.12);color:#2271a8;margin-left:5px;border:1px solid rgba(34,113,168,.2);white-space:nowrap}
.src-badge-ratio{font-size:8px;padding:1px 5px;border-radius:3px;background:rgba(72,147,103,.12);color:var(--brand);margin-left:5px;border:1px solid rgba(72,147,103,.2);white-space:nowrap}
.c-price-base{color:var(--brand);font-weight:500}
.c-price-qty{color:var(--text)}
.c-price-nil{color:var(--t4)}

/* ── LOADING ── */
.loading-wrap{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;}
.spinner{width:36px;height:36px;border-radius:50%;border:3px solid var(--b2);border-top-color:var(--brand);animation:spin .7s linear infinite;}

/* ── BADGE PILLS ── */
.badge-soon{font-size:8px;font-family:var(--fm);padding:1px 5px;border-radius:3px;background:var(--gold-bg);color:var(--gold);border:1px solid rgba(138,104,0,.2);margin-left:5px;white-space:nowrap;}
.badge-wip{font-size:8px;font-family:var(--fm);padding:1px 5px;border-radius:3px;background:var(--brand-dim);color:var(--brand);border:1px solid rgba(72,147,103,.25);margin-left:5px;white-space:nowrap;}

/* ── SCROLLBARS ── */
::-webkit-scrollbar{width:7px;height:7px}
::-webkit-scrollbar-track{background:var(--s2)}
::-webkit-scrollbar-thumb{background:var(--b3);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--t3)}

.fade{animation:fi .15s ease}
@keyframes fi{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── WATERMARK ── */
.watermark-bar{
  background:rgba(201,64,64,.06);border-bottom:1px solid rgba(201,64,64,.15);
  padding:4px 14px;display:flex;align-items:center;gap:8px;
  font-family:var(--fm);font-size:9px;color:var(--err);letter-spacing:.04em;
  flex-shrink:0;
}
.dark .watermark-bar{background:rgba(201,64,64,.08)}

/* ── PRINT STYLES ── */
@media print{
  .topbar,.sidebar,.det-acts,.det-close,.ttabs,.calc,.theme-btn,
  .sheet-bar,.cust-bar,.no-print,.watermark-bar{display:none!important}
  .body,.main{display:block!important;height:auto!important;overflow:visible!important}
  .detail{width:100%!important;border:none!important}
  .grid{display:none!important}
  body{background:#fff!important;color:#000!important;font-size:10px}
  @page{
    size:landscape;
    margin:12mm 10mm 20mm 10mm;
    @bottom-left{
      content:url;
      font-size:6pt;color:#bbb;font-family:'DM Mono',monospace;
    }
    @bottom-center{
      content:"CONFIDENTIAL — Property of Patio Products, Inc.  ·  Internal use only  ·  Do not distribute";
      font-size:6.5pt;color:#bbb;font-family:'DM Mono',monospace;letter-spacing:.03em;
      border-top:0.5pt solid #ddd;padding-top:2mm;
    }
    @bottom-right{
      content:counter(page) " / " counter(pages);
      font-size:6pt;color:#bbb;font-family:'DM Mono',monospace;
    }
  }
  .pt th,.pt td{border-color:#ddd!important}
  .pc-ws,.pc-above,.pc-below,.pc-qty{color:#000!important}
  .pct{display:none!important}
  .custv{display:block!important;height:auto!important}
  .cust-wrap,.sheet-wrap{overflow:visible!important;height:auto!important}
  .ct th,.ct td,.st th,.st td{border-color:#ddd!important;color:#000!important;background:#fff!important}
  .cat-hdr td{background:#f0f0f0!important;color:#333!important}
  .sheet{display:block!important;height:auto!important}
  .sheet-wrap{display:none!important}
  .print-only{display:block!important}
  .ptw,.msec{page-break-inside:avoid!important}
}
.print-only{display:none}
.print-hdr{display:none;padding:0 0 14px 0}
.print-hdr h1{font-family:'Syne',sans-serif;font-size:18px;color:#000;margin-bottom:3px}
.print-hdr p{font-size:11px;color:#555;font-family:'DM Sans',sans-serif}

/* Per-category print sections */
.print-cat-section{page-break-before:always;padding-bottom:16mm}
.print-cat-section:first-of-type{page-break-before:avoid}
.print-cat-title{font-family:'Syne',sans-serif;font-weight:700;font-size:13pt;color:#1a2530;
  border-bottom:2px solid #3a7d58;padding-bottom:4px;margin-bottom:8px;margin-top:14px;
  text-transform:uppercase;letter-spacing:.05em}
.print-table{width:100%;border-collapse:collapse;font-family:'DM Mono',monospace;font-size:8.5pt}
.print-table th{padding:4px 8px;text-align:left;background:#f4f6f8;border-bottom:1px solid #ccd4dc;
  font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:#555;white-space:nowrap}
.print-th-price{text-align:right!important}
.print-table td{padding:3px 8px;border-bottom:1px solid #e8ecf0;vertical-align:top}
.print-td-price{text-align:right;font-variant-numeric:tabular-nums}
.print-td-sku{color:#666;font-size:7.5pt;white-space:nowrap}
.print-pname{font-family:'DM Sans',sans-serif;font-weight:600;font-size:9pt;color:#1a2530}
.print-pvar{font-family:'DM Sans',sans-serif;font-size:7.5pt;color:#4a5f70;margin-top:1px}
.print-tr{page-break-inside:avoid}

.print-watermark{display:none}
.print-cust-hdr{display:none;padding:0 0 18px 0}
.print-cust-hdr h1{font-family:'Syne',sans-serif;font-size:20px;color:#000;margin-bottom:4px}
.print-cust-hdr p{font-size:12px;color:#666;font-family:'DM Sans',sans-serif}

/* ── AUTH GATE ── */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px;}
.auth-card{background:var(--s1);border:1px solid var(--b1);border-radius:14px;padding:40px 36px;width:100%;max-width:380px;box-shadow:var(--shadow);display:flex;flex-direction:column;align-items:center;gap:0;}
.auth-logo{width:56px;height:56px;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--brand);margin-bottom:18px;flex-shrink:0;}
.auth-logo img{width:56px;height:56px;object-fit:contain;mix-blend-mode:multiply;}
.dark .auth-logo img{mix-blend-mode:normal;opacity:.85;}
.auth-logo-fallback{font-family:var(--fd);font-weight:800;font-size:22px;color:#fff;}
.auth-title{font-family:var(--fd);font-weight:700;font-size:22px;color:var(--text);margin-bottom:4px;text-align:center;}
.auth-sub{font-size:12px;color:var(--t3);margin-bottom:28px;text-align:center;}
.auth-form{width:100%;display:flex;flex-direction:column;gap:12px;}
.auth-field{display:flex;flex-direction:column;gap:5px;}
.auth-label{font-family:var(--fm);font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;}
.auth-inp{width:100%;padding:10px 13px;background:var(--s2);border:1px solid var(--b1);border-radius:7px;color:var(--text);font-family:var(--fb);font-size:13px;outline:none;transition:border-color .2s;}
.auth-inp:focus{border-color:var(--brand);}
.auth-inp::placeholder{color:var(--t4);}
.auth-err{font-size:11px;color:var(--err);background:var(--err-bg);border:1px solid rgba(201,64,64,.2);border-radius:6px;padding:8px 11px;text-align:center;}
.auth-btn{width:100%;padding:11px;background:var(--brand);border:none;border-radius:7px;color:#fff;font-family:var(--fb);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s;margin-top:4px;}
.auth-btn:hover{background:var(--brand-lt);}
.auth-btn:disabled{opacity:.6;cursor:not-allowed;}
.auth-link{font-size:11px;color:var(--brand);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px;}
.auth-link:hover{color:var(--brand-lt);}
.auth-forgot{width:100%;text-align:right;margin-top:-4px;}
.auth-reset-msg{font-size:11px;color:var(--below);background:var(--below-bg);border:1px solid rgba(45,122,90,.2);border-radius:6px;padding:8px 11px;text-align:center;width:100%;}

/* ── USER MANAGEMENT MODAL ── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px;}
.modal{background:var(--s1);border:1px solid var(--b1);border-radius:14px;width:100%;max-width:440px;box-shadow:0 8px 40px rgba(0,0,0,.18);display:flex;flex-direction:column;max-height:90vh;overflow:hidden;}
.modal-hdr{padding:18px 20px;border-bottom:1px solid var(--b1);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.modal-title{font-family:var(--fd);font-weight:700;font-size:15px;color:var(--text);}
.modal-body{padding:20px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;}
.modal-field{display:flex;flex-direction:column;gap:5px;}
.modal-label{font-family:var(--fm);font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;}
.modal-inp{width:100%;padding:9px 12px;background:var(--s2);border:1px solid var(--b1);border-radius:7px;color:var(--text);font-family:var(--fb);font-size:13px;outline:none;transition:border-color .2s;}
.modal-inp:focus{border-color:var(--brand);}
.modal-sel{width:100%;padding:9px 12px;background:var(--s2);border:1px solid var(--b1);border-radius:7px;color:var(--text);font-family:var(--fb);font-size:13px;outline:none;cursor:pointer;}
.modal-sel option{background:var(--s2);}
.modal-footer{padding:14px 20px;border-top:1px solid var(--b1);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;}
.user-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:7px;background:var(--s2);border:1px solid var(--b1);}
.user-row-info{flex:1;min-width:0;}
.user-row-name{font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.user-row-email{font-family:var(--fm);font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.user-role-badge{font-family:var(--fm);font-size:9px;padding:2px 7px;border-radius:20px;flex-shrink:0;background:var(--brand-dim);color:var(--brand);border:1px solid rgba(72,147,103,.25);}
.user-mgmt-btn{font-family:var(--fm);font-size:9px;cursor:pointer;border-radius:4px;padding:3px 8px;transition:all .15s;background:transparent;border:1px solid var(--b2);color:var(--t3);}
.user-mgmt-btn:hover{color:var(--text);background:var(--s3);}
.user-mgmt-btn.danger{border-color:rgba(201,64,64,.3);color:var(--err);}
.user-mgmt-btn.danger:hover{background:var(--err-bg);}
.user-acct-btn{background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;color:var(--t2);font-size:12px;font-family:var(--fb);transition:all .15s;}
.user-acct-btn:hover{background:var(--s3);color:var(--text);}
`;


// ─── LOGO ─────────────────────────────────────────────────────────────────────
const LOGO_URL = "https://www.patioproducts.com/wp-content/uploads/2025/03/logo-3.png";

function LogoImg({ size=30, className="logo" }) {
  const [err, setErr] = useState(false);
  return (
    <div className={className} style={size!==30?{width:size,height:size}:{}}>
      {!err
        ? <img src={LOGO_URL} alt="Patio Products" onError={()=>setErr(true)}/>
        : <span className={className==="auth-logo"?"auth-logo-fallback":"logo-fallback"}>W</span>
      }
    </div>
  );
}

// ─── AUTH GATE ────────────────────────────────────────────────────────────────
function AuthGate({ dark, onAuth }) {
  const [email,      setEmail]      = useState("");
  const [password,   setPassword]   = useState("");
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);
  const [resetMode,  setResetMode]  = useState(false);
  const [resetSent,  setResetSent]  = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const session = await sbSignIn(email.trim(), password);
      saveSession(session);
      // Fetch role + name from user_profiles via serverless function
      const profileRes = await fetch("/.netlify/functions/get-profile", {
        headers: { "Authorization": `Bearer ${session.access_token}` },
      });
      const profile = await profileRes.json();
      if (!profileRes.ok) throw new Error(profile.error || "Could not load user profile");
      onAuth({ ...profile, accessToken: session.access_token, refreshToken: session.refresh_token });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    if (!email.trim()) { setError("Enter your email address first"); return; }
    setError(""); setLoading(true);
    try {
      await sbSendPasswordReset(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div className="auth-wrap">
        <div className="auth-card">
          <LogoImg size={56} className="auth-logo"/>
          <div className="auth-title">PriceMatrix</div>
          <div className="auth-sub">Patio Products, Inc. · Internal pricing tool</div>

          {resetMode ? (
            resetSent ? (
              <>
                <div className="auth-reset-msg" style={{marginBottom:16}}>
                  ✓ Password reset email sent to {email}.<br/>Check your inbox and follow the link.
                </div>
                <button className="auth-link" onClick={()=>{setResetMode(false);setResetSent(false);}}>
                  Back to sign in
                </button>
              </>
            ) : (
              <form className="auth-form" onSubmit={handleReset}>
                {error && <div className="auth-err">{error}</div>}
                <div className="auth-field">
                  <label className="auth-label">Email</label>
                  <input className="auth-inp" type="email" placeholder="you@patioproducts.com"
                    value={email} onChange={e=>setEmail(e.target.value)} autoFocus required/>
                </div>
                <button className="auth-btn" type="submit" disabled={loading}>
                  {loading ? "Sending…" : "Send reset email"}
                </button>
                <div style={{textAlign:"center",marginTop:4}}>
                  <button type="button" className="auth-link" onClick={()=>{setResetMode(false);setError("");}}>
                    Back to sign in
                  </button>
                </div>
              </form>
            )
          ) : (
            <form className="auth-form" onSubmit={handleLogin}>
              {error && <div className="auth-err">{error}</div>}
              <div className="auth-field">
                <label className="auth-label">Email</label>
                <input className="auth-inp" type="email" placeholder="you@patioproducts.com"
                  value={email} onChange={e=>setEmail(e.target.value)} autoFocus required/>
              </div>
              <div className="auth-field">
                <label className="auth-label">Password</label>
                <input className="auth-inp" type="password" placeholder="••••••••"
                  value={password} onChange={e=>setPassword(e.target.value)} required/>
              </div>
              <div className="auth-forgot">
                <button type="button" className="auth-link"
                  onClick={()=>{setResetMode(true);setError("");}}>
                  Forgot password?
                </button>
              </div>
              <button className="auth-btn" type="submit" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── USER MANAGEMENT MODAL ────────────────────────────────────────────────────
const MANAGED_USERS_KEY = "pm_managed_users"; // local cache of invited users for display

function UserManagementModal({ onClose, currentUser }) {
  const [tab,         setTab]        = useState("users"); // "users" | "invite"
  const [users,       setUsers]      = useState([]);
  const [loadingUsers,setLoadingUsers]= useState(true);
  const [invEmail,    setInvEmail]   = useState("");
  const [invName,     setInvName]    = useState("");
  const [invRole,     setInvRole]    = useState("viewer");
  const [invStatus,   setInvStatus]  = useState(""); // "", "sending", "ok", "err"
  const [invErr,      setInvErr]     = useState("");
  const [resetTarget, setResetTarget]= useState(null); // email being reset
  const [resetStatus, setResetStatus]= useState(""); // "" | "sending" | "ok" | "err"

  // Load cached user list from localStorage (we don't have a list endpoint
  // without exposing the service role key to the client, so we maintain a
  // local cache of who admin has invited/confirmed)
  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(MANAGED_USERS_KEY) || "[]");
      setUsers(cached);
    } catch {}
    setLoadingUsers(false);
  }, []);

  function saveUsers(list) {
    setUsers(list);
    localStorage.setItem(MANAGED_USERS_KEY, JSON.stringify(list));
  }

  async function handleInvite(e) {
    e.preventDefault();
    setInvStatus("sending"); setInvErr("");
    try {
      const res = await fetch("/.netlify/functions/invite-user", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${currentUser.accessToken}`,
        },
        body: JSON.stringify({ email: invEmail.trim(), name: invName.trim(), role: invRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Invite failed");
      // Add to local cache
      const sentTo = invEmail.trim().toLowerCase();
      const newUser = { email: sentTo, name: invName.trim(), role: invRole };
      saveUsers([...users.filter(u=>u.email!==newUser.email), newUser]);
      setInvEmail(""); setInvName(""); setInvRole("viewer");
      setInvStatus(sentTo); // store email as status so success message can show it
    } catch (err) {
      setInvErr(err.message); setInvStatus("err");
    }
  }

  async function handleSendReset(email) {
    setResetTarget(email); setResetStatus("sending");
    try {
      await sbSendPasswordReset(email);
      setResetStatus("ok");
    } catch {
      setResetStatus("err");
    }
  }

  const ROLE_LABELS = { admin:"Admin", manager:"Manager", viewer:"Viewer" };

  return (
    <div className="modal-overlay" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-hdr">
          <div className="modal-title">👤 User Management</div>
          <button className="det-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab bar */}
        <div style={{display:"flex",borderBottom:"1px solid var(--b1)",padding:"0 20px",gap:2,flexShrink:0}}>
          {[["users","Users"],["invite","+ Invite User"]].map(([id,label])=>(
            <button key={id} onClick={()=>{setTab(id);setInvStatus("");}}
              style={{padding:"9px 14px",background:"none",border:"none",borderBottom:tab===id?"2px solid var(--brand)":"2px solid transparent",
                color:tab===id?"var(--brand)":"var(--t3)",fontFamily:"var(--fm)",fontSize:11,cursor:"pointer",marginBottom:-1,transition:"all .15s"}}>
              {label}
            </button>
          ))}
        </div>

        {tab === "users" && (
          <div className="modal-body">
            {/* Always show the current admin user */}
            <div className="user-row">
              <div className="user-row-info">
                <div className="user-row-name">{currentUser.name} (you)</div>
                <div className="user-row-email">{currentUser.email}</div>
              </div>
              <span className="user-role-badge">{ROLE_LABELS[currentUser.role]||currentUser.role}</span>
            </div>

            {loadingUsers ? (
              <div style={{color:"var(--t3)",fontSize:11,textAlign:"center",padding:"12px 0"}}>Loading…</div>
            ) : users.length === 0 ? (
              <div style={{color:"var(--t3)",fontSize:11,textAlign:"center",padding:"12px 0"}}>
                No invited users yet. Use the Invite tab to add team members.
              </div>
            ) : (
              users.filter(u=>u.email!==currentUser.email).map(u=>(
                <div key={u.email} className="user-row">
                  <div className="user-row-info">
                    <div className="user-row-name">{u.name}</div>
                    <div className="user-row-email">{u.email}</div>
                  </div>
                  <span className="user-role-badge">{ROLE_LABELS[u.role]||u.role}</span>
                  <div style={{display:"flex",gap:4,flexShrink:0}}>
                    {resetTarget===u.email ? (
                      <span style={{fontSize:10,color:resetStatus==="ok"?"var(--below)":resetStatus==="err"?"var(--err)":"var(--t3)",fontFamily:"var(--fm)"}}>
                        {resetStatus==="sending"?"Sending…":resetStatus==="ok"?"Reset sent ✓":resetStatus==="err"?"Failed":""}
                      </span>
                    ) : (
                      <button className="user-mgmt-btn" title="Send password reset email"
                        onClick={()=>handleSendReset(u.email)}>
                        Reset pwd
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
            <div style={{fontSize:10,color:"var(--t3)",fontFamily:"var(--fm)",lineHeight:1.6,marginTop:4}}>
              To remove a user or change their role, visit the{" "}
              <a href="https://supabase.com/dashboard/project/lhtkmuvfiqbnkppwvsjj/auth/users"
                target="_blank" rel="noopener noreferrer" style={{color:"var(--brand)"}}>
                Supabase dashboard
              </a>.
            </div>
          </div>
        )}

        {tab === "invite" && (
          <form className="modal-body" onSubmit={handleInvite}>
            {invStatus && invStatus!=="sending" && invStatus!=="err" && (
              <div className="auth-reset-msg">✓ Invite sent! {invStatus} will receive an email to set their password.</div>
            )}
            {invStatus==="err" && (
              <div className="auth-err">{invErr}</div>
            )}
            <div className="modal-field">
              <label className="modal-label">Full Name</label>
              <input className="modal-inp" type="text" placeholder="Jane Smith"
                value={invName} onChange={e=>setInvName(e.target.value)} required/>
            </div>
            <div className="modal-field">
              <label className="modal-label">Email Address</label>
              <input className="modal-inp" type="email" placeholder="jane@patioproducts.com"
                value={invEmail} onChange={e=>setInvEmail(e.target.value)} required/>
            </div>
            <div className="modal-field">
              <label className="modal-label">Role</label>
              <select className="modal-sel" value={invRole} onChange={e=>setInvRole(e.target.value)}>
                <option value="admin">Admin — full access + user management</option>
                <option value="manager">Manager — all tiers, export CSV, read customer view</option>
                <option value="viewer">Viewer — all tiers, sheet view only</option>
              </select>
            </div>
            <div style={{fontSize:10,color:"var(--t3)",fontFamily:"var(--fm)",lineHeight:1.6,background:"var(--s2)",borderRadius:6,padding:"8px 10px",border:"1px solid var(--b1)"}}>
              Supabase will email {invEmail||"the user"} a magic link to set their password. They will be signed in automatically when they click it.
            </div>
            <div className="modal-footer" style={{padding:0,border:"none"}}>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-a" disabled={invStatus==="sending"}>
                {invStatus==="sending" ? "Sending…" : "Send Invite"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── PCT BADGE ────────────────────────────────────────────────────────────────
function PctBadge({ price, wsPrice }) {
  if (wsPrice==null||wsPrice===0) return null;
  const p = ((price-wsPrice)/wsPrice)*100;
  if (!isFinite(p)||isNaN(p)) return null;
  if (Math.abs(p)<0.05) return <span className="pct pct-ws">WS</span>;
  return <span className={`pct ${p>0?"pct-up":"pct-down"}`}>{fmtP(p)}</span>;
}

// ─── WATERMARK BAR ────────────────────────────────────────────────────────────
function WatermarkBar() {
  return (
    <div className="watermark-bar no-print">
      🔒 CONFIDENTIAL — Property of Patio Products, Inc. · Internal use only · Do not distribute
    </div>
  );
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────
function DetailPanel({ product, visibleTiers, onClose, allData, focusChildSku, caps, flagMap }) {
  const [selTier,     setSelTier]     = useState("All");
  const [calcVar,     setCalcVar]     = useState(null);
  const [calcQty,     setCalcQty]     = useState("");
  const [filterColor, setFilterColor] = useState("All");
  const [filterSize,  setFilterSize]  = useState("All");
  const [showFlags,   setShowFlags]   = useState(false);
  const focusRef = useRef(null);

  const variants = useMemo(()=>getVariants(allData,product.parent_id),[allData,product.parent_id]);
  const matrix   = useMemo(()=>buildMatrix(allData,product.parent_id),[allData,product.parent_id]);
  const firstSku = variants[0]?.child_id;
  const cvSku    = calcVar||firstSku;

  const isSlashVariants = useMemo(()=>
    variants.length>1&&variants.every(v=>v.variant_name.includes(" / ")),
  [variants]);

  const colorOptions = useMemo(()=>{
    if(!isSlashVariants) return [];
    const s = new Set(["All"]);
    variants.forEach(v=>s.add(v.variant_name.split(" / ")[0]));
    return [...s];
  },[variants,isSlashVariants]);

  const sizeOptions = useMemo(()=>{
    if(!isSlashVariants) return [];
    const s = new Set(["All"]);
    variants.forEach(v=>{ const p=v.variant_name.split(" / "); if(p[1]) s.add(p[1]); });
    return [...s];
  },[variants,isSlashVariants]);

  const visibleVariants = useMemo(()=>{
    if(!isSlashVariants) return variants;
    return variants.filter(v=>{
      const [c,s]=v.variant_name.split(" / ");
      return (filterColor==="All"||c===filterColor)&&(filterSize==="All"||s===filterSize);
    });
  },[variants,isSlashVariants,filterColor,filterSize]);

  useEffect(()=>{
    if(focusRef.current) focusRef.current.scrollIntoView({behavior:"smooth",block:"center"});
  },[focusChildSku]);

  // Qty calculator
  const qNum = parseInt(calcQty,10);
  const uPriceRaw = (cvSku&&qNum>0) ? (() => {
    const breaks = Object.keys(matrix[cvSku]?.Wholesale||{}).map(Number)
      .filter(b=>b!==1).filter(b=>b<=qNum).sort((a,b)=>b-a);
    const qb = breaks.length?breaks[0]:0;
    return matrix[cvSku]?.Wholesale?.[qb]??null;
  })() : null;
  const uPriceRounded = uPriceRaw!=null?Math.round(uPriceRaw*100)/100:null;
  const tPrice = uPriceRounded!=null&&qNum>0?Math.round(uPriceRounded*qNum*100)/100:null;

  const tiersToShow = selTier==="All"?visibleTiers:(visibleTiers.includes(selTier)?[selTier]:visibleTiers);

  function qtyBreaksAllTiers(childId) {
    const breaks = new Set();
    tiersToShow.forEach(tier=>{
      Object.keys(matrix[childId]?.[tier]||{}).map(Number).filter(b=>b!==1).forEach(b=>breaks.add(b));
    });
    return [...breaks].sort((a,b)=>a-b);
  }
  function qtyBreaksSingleTier(childId,tier) {
    return Object.keys(matrix[childId]?.[tier]||{}).map(Number).filter(b=>b!==1).sort((a,b)=>a-b);
  }

  function handleCSV() {
    const rows = allData.filter(r=>r.parent_id===product.parent_id&&visibleTiers.includes(r.tier));
    downloadCSV(`${product.parent_sku}-prices.csv`,
      ["parent_sku","child_sku","variant_name","tier","qty_break","price","category","last_updated"],
      rows.map(r=>[r.parent_sku,r.child_sku,r.variant_name,r.tier,r.qty_break,r.price,r.category,r.last_updated])
    );
  }
  function handleJSON() {
    const rows = allData.filter(r=>r.parent_id===product.parent_id&&visibleTiers.includes(r.tier));
    downloadJSON(`${product.parent_sku}-prices.json`, rows);
  }

  const myFlags = flagMap?.[product.parent_id] || [];
  const websiteUrl = product.slug ? `https://www.patioproducts.com/product/${product.slug}/` : null;

  return (
    <div className="detail fade">
      <div className="det-hdr">
        <img className="det-img" src={product.image_url} alt="" onError={e=>e.target.style.display="none"}/>
        <div className="det-info">
          <div className="det-cat">{product.category}</div>
          <div className="det-name">{product.parent_name}</div>
          <div className="det-sku">
            SKU: {product.parent_sku}
            {websiteUrl && (
              <a href={websiteUrl} target="_blank" rel="noreferrer"
                style={{marginLeft:8,fontFamily:"var(--fm)",fontSize:9,color:"var(--brand)",textDecoration:"none",
                  padding:"1px 6px",border:"1px solid rgba(72,147,103,.35)",borderRadius:3,
                  background:"var(--brand-dim)",verticalAlign:"middle"}}
                title="View on website">
                ↗ website
              </a>
            )}
          </div>
        </div>
        <button className="det-close" onClick={onClose}>×</button>
      </div>

      <div className="det-acts">
        <button className="btn btn-a" onClick={()=>window.print()}>⊞ Print / PDF</button>
        {caps.canExportCSV  && <button className="btn btn-o" onClick={handleCSV}>↓ CSV</button>}
        {caps.canExportJSON && <button className="btn btn-o" onClick={handleJSON}>↓ JSON</button>}
        {myFlags.length>0 && (
          <button className={`btn btn-warn ${showFlags?"on":""}`} onClick={()=>setShowFlags(f=>!f)}>
            ▲ {myFlags.length} flag{myFlags.length!==1?"s":""}
          </button>
        )}
        <span className="row-count">
          {allData.filter(r=>r.parent_id===product.parent_id&&visibleTiers.includes(r.tier)).length} rows
        </span>
      </div>

      {showFlags && myFlags.length>0 && (
        <div className="flag-panel">
          <div style={{fontFamily:"var(--fm)",fontSize:9,color:"var(--err)",textTransform:"uppercase",letterSpacing:".1em"}}>
            Data flags — {myFlags.length} issue{myFlags.length!==1?"s":""}
          </div>
          <div className="flag-list">
            {myFlags.map((f,i)=><div key={i} className="flag-item">{f}</div>)}
          </div>
        </div>
      )}

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
            {visibleVariants.length} of {variants.length} prices
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
        {tPrice!=null ? (
          <>
            <span className="calc-arrow">→</span>
            <span className="calc-total">{fmt(tPrice)}</span>
            <span className="calc-unit">{fmt(uPriceRounded)} × {qNum}</span>
          </>
        ) : calcQty ? <span className="calc-unit" style={{color:"var(--t3)"}}>enter qty</span> : null}
      </div>

      <div className="ttabs">
        <button className={`ttab ${selTier==="All"?"on":""}`} onClick={()=>setSelTier("All")}>All Tiers</button>
        {visibleTiers.map(t=>(
          <button key={t} className={`ttab ${selTier===t?"on":""}`}
            style={selTier===t?{color:TIER_COLORS[t],borderTopColor:TIER_COLORS[t]}:{}}
            onClick={()=>setSelTier(t)}>{t}</button>
        ))}
      </div>

      <div className="det-body">
        {selTier!=="All" ? (
          visibleVariants.map(v=>{
            const breaks  = qtyBreaksSingleTier(v.child_id,selTier);
            const isFocus = focusChildSku&&v.child_sku===focusChildSku;
            return (
              <div key={v.child_id} ref={isFocus?focusRef:null} className="ptw"
                style={{marginBottom:12,outline:isFocus?"2px solid var(--brand)":"none",borderRadius:7}}>
                <table className="pt">
                  <thead><tr>
                    <th>Variant / SKU</th>
                    {breaks.map(q=><th key={q} className="r">{q===0?"Regular":`${q}+`}</th>)}
                  </tr></thead>
                  <tbody><tr>
                    <td>
                      <span className="vbadge" style={{marginRight:5}}>{v.variant_name}</span>
                      <span className="skubadge">{v.child_sku}</span>
                    </td>
                    {breaks.map(q=>{
                      const isWL = selTier==="Wholesale_L2"||selTier==="Wholesale_L3";
                      const price = isWL
                        ? resolveWLPrice(matrix,v.child_id,selTier,q)
                        : matrix[v.child_id]?.[selTier]?.[q];
                      const wsPrice = matrix[v.child_id]?.Wholesale?.[q];
                      const isWs    = selTier==="Wholesale";
                      const isBase  = q===0;
                      const priceClass = isWs?"pc-ws":pctVsWholesale(price,wsPrice)>0?"pc-above":"pc-below";
                      return (
                        <td key={q} className="r">
                          {price!=null ? (
                            <>
                              <span className={isBase?priceClass:"pc-qty"}>{fmt(price)}</span>
                              {isBase&&<PctBadge price={price} wsPrice={wsPrice}/>}
                            </>
                          ) : "—"}
                        </td>
                      );
                    })}
                  </tr></tbody>
                </table>
              </div>
            );
          })
        ) : (
          visibleVariants.map(v=>{
            const breaks  = qtyBreaksAllTiers(v.child_id);
            const isFocus = focusChildSku&&v.child_sku===focusChildSku;
            return (
              <div key={v.child_id} ref={isFocus?focusRef:null} className="msec"
                style={{outline:isFocus?"2px solid var(--brand)":"none",borderRadius:7,padding:isFocus?4:0}}>
                <div className="msec-hdr">
                  {v.variant_name} <span className="vbadge">{v.child_sku}</span>
                </div>
                <div className="ptw">
                  <table className="pt">
                    <thead><tr>
                      <th>Tier</th>
                      {breaks.map(q=><th key={q} className="r">{q===0?"Regular":`${q}+`}</th>)}
                    </tr></thead>
                    <tbody>
                      {tiersToShow.map(tier=>{
                        const isWs = tier==="Wholesale";
                        return (
                          <tr key={tier}>
                            <td>
                              <span style={{display:"flex",alignItems:"center",gap:6}}>
                                <span className="tdot" style={{background:TIER_COLORS[tier]}}/>
                                <span style={{color:TIER_COLORS[tier],fontSize:11}}>{tier}</span>
                              </span>
                            </td>
                            {breaks.map(q=>{
                              const isWL = tier==="Wholesale_L2"||tier==="Wholesale_L3";
                              const price = isWL
                                ? resolveWLPrice(matrix,v.child_id,tier,q)
                                : matrix[v.child_id]?.[tier]?.[q];
                              const wsPrice = matrix[v.child_id]?.Wholesale?.[q];
                              return (
                                <td key={q} className="r">
                                  {price!=null ? (
                                    <>
                                      <span style={{color:q===0?(isWs?"var(--ws)":TIER_COLORS[tier]):"var(--text)"}}>{fmt(price)}</span>
                                      {q===0&&!isWs&&<PctBadge price={price} wsPrice={wsPrice}/>}
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

// ─── SEARCH HELPER ────────────────────────────────────────────────────────────
// Supports: plain substring, * (any chars), ? (single char), implicit AND
// (space-separated tokens all must match), explicit OR with |.
// Special regex chars in the query are escaped before glob expansion.
function buildSearchMatcher(query) {
  if (!query) return null;
  const escape = s => s.replace(/[.+^${}()\[\]\\]/g, "\\$&");
  const globToRegex = token =>
    new RegExp(token.split("*").map(p => p.split("?").map(escape).join(".")).join(".*"), "i");
  // Space-separated → AND; pipe-separated within a token → OR
  const andTokens = query.trim().split(/\s+/);
  const matchers = andTokens.map(tok => {
    const orParts = tok.split("|").map(globToRegex);
    return str => orParts.some(re => re.test(str));
  });
  return fields => matchers.every(m => fields.some(f => m(f)));
}

// ─── SHEET VIEW ───────────────────────────────────────────────────────────────
function SheetView({ visibleTiers, allData, caps, excluded, setExcluded, allCategories }) {
  const [tier,   setTier]   = useState(visibleTiers[0]||"Wholesale");
  const [search, setSearch] = useState("");
  const activeTier = visibleTiers.includes(tier)?tier:visibleTiers[0];

  const data = useMemo(()=>getTierFlat(allData,activeTier),[allData,activeTier]);
  const color = TIER_COLORS[activeTier];
  const today = new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});

  const rows = useMemo(()=>{
    let entries = Object.entries(data);
    if (!search) entries = entries.filter(([,v])=>!excluded.has(v.category));
    if (search) {
      const match = buildSearchMatcher(search);
      entries=entries.filter(([sku,v])=>match([v.parent_name,sku,v.parent_sku]));
    }
    return entries.sort((a,b)=>{
      if(a[1].category!==b[1].category) return a[1].category.localeCompare(b[1].category);
      return a[1].parent_name.localeCompare(b[1].parent_name);
    });
  },[data,excluded,search]);

  // Per-category qty breaks
  const catBreaksMap = useMemo(()=>{
    const m = {};
    rows.forEach(([,v])=>{
      const cat = v.category;
      if (!m[cat]) m[cat] = new Set();
      Object.keys(v).filter(k=>!isNaN(k)).map(Number).filter(b=>b!==1).forEach(b=>{
        if(v[b]!=null) m[cat].add(b);
      });
    });
    Object.keys(m).forEach(cat=>{ m[cat]=[...m[cat]].sort((a,b)=>a-b); });
    return m;
  },[rows]);

  // Global breaks for CSV/header
  const allBreaks = useMemo(()=>{
    const s = new Set();
    rows.forEach(([,v])=>Object.keys(v).filter(k=>!isNaN(k)).map(Number).filter(b=>b!==1).forEach(b=>{ if(v[b]!=null) s.add(b); }));
    return [...s].sort((a,b)=>a-b);
  },[rows]);

  // Group rows by category for per-category print tables
  const rowsByCategory = useMemo(()=>{
    const m = new Map();
    rows.forEach(([sku,v])=>{
      if(!m.has(v.category)) m.set(v.category,[]);
      m.get(v.category).push([sku,v]);
    });
    return m;
  },[rows]);

  function handleCSV() {
    downloadCSV(
      `${activeTier}-prices.csv`,
      ["child_sku","parent_sku","parent_name","variant_name","category",...allBreaks.map(q=>q===0?"regular_price":`qty_${q}_plus`)],
      rows.map(([sku,v])=>[sku,v.parent_sku,v.parent_name,v.variant_name,v.category,...allBreaks.map(q=>v[q]??"")])
    );
  }

  function handleJSON() {
    const payload = rows.map(([sku,v])=>({
      child_sku:sku, parent_sku:v.parent_sku, parent_name:v.parent_name,
      variant_name:v.variant_name, category:v.category, tier:activeTier,
      prices:Object.fromEntries(allBreaks.filter(q=>v[q]!=null).map(q=>[q,v[q]])),
    }));
    downloadJSON(`${activeTier}-prices.json`, payload);
  }

  function handleXLSX() {
    if (!window.XLSX) {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload = () => buildXLSX();
      document.head.appendChild(s);
    } else { buildXLSX(); }

    function buildXLSX() {
      const wb = window.XLSX.utils.book_new();
      wb.Props = { Title:"PriceMatrix Export", Author:"Patio Products, Inc." };
      rowsByCategory.forEach((catRows, cat)=>{
        const catBreaks = catBreaksMap[cat]||allBreaks;
        const headers = ["SKU","Parent SKU","Product","Variant","Category",...catBreaks.map(q=>q===0?"Regular Price":`Qty ${q}+`)];
        const dataRows = catRows.map(([sku,v])=>[sku,v.parent_sku,v.parent_name,v.variant_name,v.category,...catBreaks.map(q=>v[q]??null)]);
        const sheetName = cat.replace(/[:\\/?*[\]]/g,"").slice(0,31);
        const ws = window.XLSX.utils.aoa_to_sheet([
          [`CONFIDENTIAL — Property of Patio Products, Inc. Not for distribution.`],
          [`${activeTier} Pricing — ${cat} — ${today}`],
          [],
          headers,
          ...dataRows,
        ]);
        ws["!cols"] = [{wch:16},{wch:14},{wch:36},{wch:20},{wch:18},...catBreaks.map(()=>({wch:12}))];
        window.XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });
      const summaryWs = window.XLSX.utils.aoa_to_sheet([
        ["CONFIDENTIAL — Property of Patio Products, Inc."],
        [`Export: ${activeTier} pricing`],
        [`Generated: ${today}`],
        [`Categories included: ${[...rowsByCategory.keys()].join(", ")}`],
        [],["For pricing questions contact Patio Products, Inc."],
      ]);
      window.XLSX.utils.book_append_sheet(wb, summaryWs, "Summary");
      window.XLSX.writeFile(wb, `${activeTier}-prices.xlsx`);
    }
  }

  return (
    <div className="sheet">
      {/* ── PRINT-ONLY LAYOUT: one section per category, each starts new page ── */}
      <div className="print-only">
        <div className="print-hdr">
          <h1>Price List — {activeTier}</h1>
          <p>Patio Products, Inc. · Prepared {today} · Prices subject to change without notice</p>
        </div>
        {[...rowsByCategory.entries()].map(([cat, catRows])=>{
          const catBreaks = catBreaksMap[cat]||allBreaks;
          return (
            <div key={cat} className="print-cat-section">
              <div className="print-cat-title">{cat}</div>
              <table className="print-table">
                <thead>
                  <tr>
                    <th className="print-th-name">Product / Variant</th>
                    <th className="print-th-sku">SKU</th>
                    {catBreaks.map(q=><th key={q} className="print-th-price">{q===0?"Price":`${q}+`}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {catRows.map(([sku,v])=>(
                    <tr key={sku} className="print-tr">
                      <td className="print-td-name">
                        <div className="print-pname">{v.parent_name}</div>
                        {v.variant_name!=="Simple"&&<div className="print-pvar">{v.variant_name}</div>}
                      </td>
                      <td className="print-td-sku">{sku}</td>
                      {catBreaks.map(q=>(
                        <td key={q} className="print-td-price">
                          {v[q]!=null ? fmt(v[q]) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      {/* ── SCREEN TOOLBAR ── */}
      <div className="sheet-bar no-print">
        <div className="tier-pills">
          {visibleTiers.map(t=>(
            <button key={t} className="tier-pill"
              style={activeTier===t?{borderColor:TIER_COLORS[t],color:TIER_COLORS[t],background:`${TIER_COLORS[t]}18`}:{}}
              onClick={()=>setTier(t)}>{t}</button>
          ))}
        </div>
        <input className="inp" style={{width:160}} placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}/>
        <span className="sheet-cnt" style={{marginLeft:"auto"}}><span>{rows.length}</span> prices</span>
        <button className="btn btn-a no-print" onClick={()=>window.print()} title="Print or save as PDF">⊞ Print / PDF</button>
        {caps.canExportCSV  && <button className="btn btn-o" onClick={handleCSV}>↓ CSV</button>}
        {caps.canExportCSV  && <button className="btn btn-o" onClick={handleXLSX}>↓ XLSX</button>}
        {caps.canExportJSON && <button className="btn btn-o" onClick={handleJSON}>↓ JSON</button>}
        {caps.canExportSage && (
          <button className="btn" style={{borderColor:"var(--gold)",color:"var(--gold)",opacity:0.6,cursor:"not-allowed",display:"flex",alignItems:"center",gap:5}}
            title="Sage 50 price file export — item ID mapping in progress">
            ↓ Sage 50 <span className="badge-wip">IN PROGRESS</span>
          </button>
        )}
      </div>

      <WatermarkBar/>

      {/* ── SCREEN TABLE ── */}
      <div className="sheet-wrap no-print">
        <table className="st">
          <thead>
            <tr>
              <th style={{minWidth:200,maxWidth:260,position:"sticky",left:0,zIndex:11,background:"var(--s1)"}}>Product / Variant</th>
              <th style={{minWidth:90,position:"sticky",left:200,zIndex:11,background:"var(--s1)",boxShadow:"2px 0 4px rgba(0,0,0,.06)"}}>SKU</th>
              {allBreaks.map(q=>(
                <th key={q} className="r" style={{color:q===0?color:undefined,width:"1px",whiteSpace:"nowrap"}}>
                  {q===0?"Price":`${q}+`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(()=>{ let lastCat=null; return rows.map(([sku,v])=>{
              const showCat = v.category!==lastCat;
              lastCat = v.category;
              const catBreaks = catBreaksMap[v.category]||allBreaks;
              return [
                showCat && (
                  <tr key={`ch-${v.category}`} className="cat-hdr">
                    <td colSpan={2+allBreaks.length} style={{position:"sticky",left:0}}>{v.category}</td>
                  </tr>
                ),
                <tr key={sku}>
                  <td style={{minWidth:200,maxWidth:260,whiteSpace:"normal",position:"sticky",left:0,background:"var(--s1)",zIndex:1}}>
                    <div className="s-name">{v.parent_name}</div>
                    {v.variant_name!=="Simple"&&<div className="s-var">{v.variant_name}</div>}
                  </td>
                  <td style={{position:"sticky",left:200,background:"var(--s1)",zIndex:1,boxShadow:"2px 0 4px rgba(0,0,0,.06)"}}><span className="s-sku">{sku}</span></td>
                  {allBreaks.map(q=>{
                    const p = v[q];
                    const inCat = catBreaks.includes(q);
                    return (
                      <td key={q} className="r">
                        {p!=null
                          ? <span className={q===0?"s-price-base":"s-price-qty"}>{fmt(p)}</span>
                          : <span style={{color:inCat?"var(--t4)":"var(--s1)"}}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              ].filter(Boolean);
            });})()}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CUSTOMER PRICING FLAGS ───────────────────────────────────────────────────
function computeCustomerFlags(rows, allData) {
  // Build reference prices per child_id from master tier rows
  const ref = {};
  allData.forEach(r => {
    if (r.qty_break !== 0 || r.customer_id != null) return;
    if (r.tier === "Retail")     (ref[r.child_id] ??= {}).retail    = r.price;
    if (r.tier === "Wholesale")  (ref[r.child_id] ??= {}).wholesale = r.price;
  });

  const flagMap = {};
  rows.forEach(row => {
    const flags = [];
    const rp = ref[row.child_id] || {};
    const breaks = Object.keys(row.prices).map(Number).sort((a, b) => a - b);
    if (breaks.length === 0) return;

    const basePrice = row.prices[breaks[0]]?.price ?? 0;
    if (basePrice === 0) {
      flags.push("Missing price");
    } else {
      if (rp.retail > 0 && basePrice > rp.retail) {
        flags.push(`Above retail (${fmt(rp.retail)})`);
      } else if (rp.wholesale > 0 && basePrice > rp.wholesale) {
        flags.push(`Above wholesale (${fmt(rp.wholesale)})`);
      }
    }

    // Qty ladder: price should not rise with qty
    for (let i = 1; i < breaks.length; i++) {
      const p0 = row.prices[breaks[i - 1]]?.price;
      const p1 = row.prices[breaks[i]]?.price;
      if (p0 != null && p1 != null && p1 > p0) {
        flags.push(`Qty ladder: price rises at qty ${breaks[i]}`);
        break;
      }
    }

    // Price outlier: any break >40% from median (requires 3+ data points)
    const positivePrices = breaks.map(q => row.prices[q]?.price).filter(p => p > 0);
    if (positivePrices.length >= 3) {
      const sorted = [...positivePrices].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0 ? (sorted[mid-1] + sorted[mid]) / 2 : sorted[mid];
      breaks.forEach(q => {
        const p = row.prices[q]?.price;
        if (p > 0 && Math.abs(p - median) / median > 0.40) {
          flags.push(`Price outlier at qty ${q}: ${fmt(p)} (median ${fmt(median)})`);
        }
      });
    }

    if (flags.length > 0) flagMap[row.child_id] = flags;
  });
  return flagMap;
}

// ─── CUSTOMER VIEW ────────────────────────────────────────────────────────────
function CustomerView({ allData, caps }) {
  // Derive customer list dynamically from Customer-tier rows with a real customer_id
  const customers = useMemo(()=>{
    const map = new Map();
    allData.forEach(r=>{
      if (r.tier !== "Customer") return;
      const cid = String(r.customer_id ?? "").trim();
      if (cid === "") return;
      if (!map.has(cid)) map.set(cid, { id: cid, name: CUSTOMER_NAMES[cid] || `Customer ${cid}` });
    });
    return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
  },[allData]);

  const [custId,      setCustId]      = useState("");
  const [search,      setSearch]      = useState("");
  const [selCats,     setSelCats]     = useState(new Set(["All"]));
  const [srcFilter,   setSrcFilter]   = useState("all");
  const [showFlagged, setShowFlagged] = useState(false);
  const [catOpen,     setCatOpen]     = useState(false);

  // Set initial customer once data loads
  useEffect(()=>{
    if (custId==="" && customers.length>0) setCustId(customers[0].id);
  },[customers]);

  const cust = customers.find(c=>c.id===custId) || customers[0];

  // Pre-build index once across all data
  const custIdx = useMemo(()=>buildCustomerIndex(allData),[allData]);

  // Derive qty breaks from Customer-tier + WL3 rows
  const custBreaks = useMemo(()=>{
    const breaks = new Set([0]);
    Object.values(custIdx).forEach(entry=>{
      entry.ratio.forEach(r=>breaks.add(r.qty_break));
      if (custId) (entry.specific[String(custId)]||[]).forEach(r=>breaks.add(r.qty_break));
      entry.wl3.forEach(r=>breaks.add(r.qty_break));
    });
    return [...breaks].filter(b=>b!==1).sort((a,b)=>a-b);
  },[custIdx,custId]);

  // Categories from Customer + WL3 tier rows
  const categories = useMemo(()=>{
    const s = new Set();
    allData.forEach(r=>{
      if ((r.tier==="Customer"||r.tier==="Wholesale_L3") && r.category)
        s.add(decodeEntities(r.category));
    });
    return [...s].sort();
  },[allData]);

  const allCatsSelected = selCats.has("All");
  const catLabel = allCatsSelected ? "All Categories" : selCats.size===1 ? [...selCats][0] : `${selCats.size} Categories`;

  function toggleCat(cat) {
    setSelCats(prev=>{
      if (cat==="All") return new Set(["All"]);
      // If currently "All selected", switch to "all except this one"
      if (prev.has("All")) {
        const next = new Set(categories);
        next.delete(cat);
        return next.size===0 ? new Set(["All"]) : next;
      }
      const next = new Set(prev);
      if (next.has(cat)) { next.delete(cat); if(next.size===0) return new Set(["All"]); }
      else next.add(cat);
      return next;
    });
  }

  // Build variant rows keyed by child_id — Sheet View style:
  // prices stored as row[qty_break]=price ONLY for real source entries (no fallback-filling).
  const rows = useMemo(()=>{
    if (!custId) return [];
    const EXCLUDED_FABRIC_BRANDS = ["sunbrella", "tempotest", "revolution"];
    const variantMeta = new Map();

    allData.forEach(r=>{
      if (r.tier !== "Customer" && r.tier !== "Wholesale_L3") return;
      const cid = String(r.child_id);
      if (!variantMeta.has(cid)) variantMeta.set(cid,{
        child_id: cid,
        child_sku: r.child_sku, parent_sku: r.parent_sku,
        parent_name: decodeEntities(r.parent_name),
        variant_name: decodeEntities(r.variant_name),
        category: decodeEntities(r.category),
      });
    });

    const allVariants = [];
    variantMeta.forEach((v, childId)=>{
      const entry = custIdx[childId];
      if (!entry) return;

      const hasSpecific  = (entry.specific[String(custId)]||[]).some(x=>x.price>0);
      const hasCustRatio = (entry.custRatio[String(custId)]||[]).some(x=>x.price>0);
      const hasRatio     = RATIO_CUSTOMERS.has(String(custId)) && entry.ratio.some(x=>x.price>0);
      const hasWl3       = entry.wl3.some(x=>x.price>0);
      let topSource = null;
      if (hasSpecific)       topSource = PRICE_SOURCE.SPECIFIC;
      else if (hasCustRatio) topSource = PRICE_SOURCE.RATIO;
      else if (hasRatio)     topSource = PRICE_SOURCE.RATIO;
      else if (hasWl3)       topSource = PRICE_SOURCE.WL3;
      if (topSource === null) return;
      if (topSource === PRICE_SOURCE.WL3) {
        const nameLower = v.parent_name.toLowerCase();
        if (EXCLUDED_FABRIC_BRANDS.some(b => nameLower.includes(b))) return;
      }

      const prices = {};
      if (topSource === PRICE_SOURCE.SPECIFIC) {
        const specArr = entry.specific[String(custId)] || [];
        specArr.forEach(x => {
          if (x.price > 0) {
            const qb = x.qty_break === 1 ? 0 : x.qty_break;
            prices[qb] ??= { price: x.price, source: PRICE_SOURCE.SPECIFIC };
          }
        });
      } else {
        const srcArr = topSource === PRICE_SOURCE.RATIO
          ? ((entry.custRatio[String(custId)]||[]).length ? entry.custRatio[String(custId)] : entry.ratio)
          : entry.wl3;
        const srcLabel = topSource === PRICE_SOURCE.RATIO ? PRICE_SOURCE.RATIO : PRICE_SOURCE.WL3;
        srcArr.forEach(x=>{
          if (x.price > 0 && x.qty_break !== 1) {
            prices[x.qty_break] = { price: x.price, source: srcLabel };
          }
        });
      }

      if (Object.keys(prices).length === 0) return;
      allVariants.push({...v, prices, topSource});
    });

    return allVariants.sort((a,b)=>{
      if(a.category!==b.category) return a.category.localeCompare(b.category);
      return a.parent_name.localeCompare(b.parent_name);
    });
  },[custId,custIdx,allData]);

  const custFlagMap   = useMemo(()=>computeCustomerFlags(rows, allData),[rows, allData]);
  const flaggedCount  = useMemo(()=>rows.filter(r=>custFlagMap[r.child_id]?.length>0).length,[rows,custFlagMap]);

  const filtered = useMemo(()=>{
    let list=rows;
    if (!allCatsSelected) list=list.filter(r=>selCats.has(r.category));
    if (srcFilter==="specific") list=list.filter(r=>r.topSource===PRICE_SOURCE.SPECIFIC);
    if (srcFilter==="ratio")    list=list.filter(r=>r.topSource===PRICE_SOURCE.RATIO);
    if (srcFilter==="wl3")      list=list.filter(r=>r.topSource===PRICE_SOURCE.WL3);
    if (search){ const match=buildSearchMatcher(search); list=list.filter(r=>match([r.parent_name,r.child_sku,r.category])); }
    if (showFlagged) list=list.filter(r=>custFlagMap[r.child_id]?.length>0);
    return list;
  },[rows,allCatsSelected,selCats,srcFilter,search,showFlagged,custFlagMap]);

  // Derive visible breaks from Object.keys — only real entries exist in prices now
  const visibleBreaks = useMemo(()=>{
    const s = new Set();
    filtered.forEach(r=>{ Object.keys(r.prices).map(Number).forEach(q=>s.add(q)); });
    return [...s].sort((a,b)=>a-b);
  },[filtered]);

  let lastCat=null;
  const today=new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});

  function handleCSV() {
    if (!cust) return;
    downloadCSV(`${cust.name.replace(/\s+/g,"-")}-prices.csv`,
      ["sku","product","variant","category","price_source",...visibleBreaks.map(q=>q===0?"price":`${q}+`)],
      filtered.map(r=>[r.child_sku,r.parent_name,r.variant_name,r.category,r.topSource||"",...visibleBreaks.map(q=>r.prices[q]?.price??"")])
    );
  }
  function handleJSON() {
    if (!cust) return;
    const payload=filtered.map(r=>({
      child_sku:r.child_sku,parent_sku:r.parent_sku,parent_name:r.parent_name,
      variant_name:r.variant_name,category:r.category,price_source:r.topSource,
      prices:Object.fromEntries(Object.keys(r.prices).map(Number).map(q=>[q,r.prices[q].price])),
    }));
    downloadJSON(`${cust.name.replace(/\s+/g,"-")}-prices.json`, payload);
  }

  if (!cust) return <div style={{padding:40,fontFamily:"var(--fm)",color:"var(--t3)"}}>Loading customer data…</div>;

  return (
    <div className="custv" onClick={()=>catOpen&&setCatOpen(false)}>
      <div className="print-cust-hdr">
        <h1>Price List — {cust.name}</h1>
        <p>Prepared {today} · Prices valid as of this date · Subject to change without notice</p>
      </div>
      <div className="print-watermark" style={{display:"none"}}>
        CONFIDENTIAL — Property of Patio Products, Inc. · Internal use only · Do not distribute
      </div>
      <div className="cust-bar">
        <span style={{fontFamily:"var(--fm)",fontSize:9,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".1em"}}>Customer</span>
        <select className="cust-sel" value={custId} onChange={e=>{setCustId(e.target.value);setSearch("");setSelCats(new Set(["All"]));setSrcFilter("all");}}>
          {customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="divider no-print"/>
        <div className="no-print" style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
          <button className="cust-sel" style={{cursor:"pointer"}} onClick={()=>setCatOpen(p=>!p)}>
            {catLabel} <span style={{fontSize:9,opacity:.5}}>▾</span>
          </button>
          {catOpen&&(
            <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:200,background:"var(--s1)",border:"1px solid var(--b2)",borderRadius:8,padding:"6px 0",minWidth:230,maxHeight:320,overflowY:"auto",boxShadow:"0 4px 16px rgba(0,0,0,.14)"}}>
              <div style={{display:"flex",gap:6,padding:"4px 10px 8px",borderBottom:"1px solid var(--b1)"}}>
                <button className="btn btn-xs" onClick={()=>{setSelCats(new Set(["All"]));setCatOpen(false);}}>All</button>
                <button className="btn btn-xs" onClick={()=>setSelCats(new Set())}>None</button>
              </div>
              {categories.map(cat=>(
                <label key={cat} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 12px",cursor:"pointer",fontSize:11,fontFamily:"var(--fm)",color:"var(--text)"}}>
                  <input type="checkbox" checked={allCatsSelected||selCats.has(cat)} onChange={()=>toggleCat(cat)} style={{accentColor:"var(--brand)"}}/>
                  {cat}
                </label>
              ))}
            </div>
          )}
        </div>
        <select className="cust-sel no-print" value={srcFilter} onChange={e=>setSrcFilter(e.target.value)}>
          <option value="all">All Pricing</option>
          <option value="specific">Specific Unit Price</option>
          <option value="ratio">Tier-Based Price</option>
          <option value="wl3">Standard WL3 Price</option>
        </select>
        <input className="inp no-print" style={{width:160}} placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}/>
        {flaggedCount>0&&(
          <button className="btn no-print" onClick={()=>setShowFlagged(p=>!p)}
            style={showFlagged?{borderColor:"var(--err)",color:"var(--err)",background:"var(--err-bg)"}:{}}>
            ▲ {flaggedCount} flagged
          </button>
        )}
        <span style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--t3)",whiteSpace:"nowrap"}} className="no-print">{filtered.length} prices</span>
        <button className="btn btn-a no-print" onClick={e=>{e.stopPropagation();window.print();}}>⊞ Print / PDF</button>
        {caps.canExportCSV  && <button className="btn btn-o no-print" onClick={handleCSV}>↓ CSV</button>}
        {caps.canExportJSON && <button className="btn btn-o no-print" onClick={handleJSON}>↓ JSON</button>}
      </div>
      <WatermarkBar/>
      <div className="cust-wrap">
        <table className="ct" style={{width:"auto"}}>
          <thead>
            <tr>
              <th style={{minWidth:200,maxWidth:280,position:"sticky",left:0,zIndex:11,background:"var(--s1)"}}>Product / Variant</th>
              <th style={{position:"sticky",left:200,zIndex:11,background:"var(--s1)",boxShadow:"2px 0 4px rgba(0,0,0,.06)",minWidth:100}}>SKU</th>
              {visibleBreaks.map(q=>(
                <th key={q} style={{width:"1px",whiteSpace:"nowrap",paddingLeft:16}}>
                  {q===0?"Price":`${q}+`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(r=>{
              const showCat=r.category!==lastCat;
              lastCat=r.category;
              return [
                showCat&&(
                  <tr key={`ch-${r.category}`} className="cat-hdr">
                    <td colSpan={2+visibleBreaks.length} style={{position:"sticky",left:0}}>{r.category}</td>
                  </tr>
                ),
                <tr key={r.child_id}>
                  <td style={{minWidth:200,maxWidth:280,whiteSpace:"normal",position:"sticky",left:0,background:"var(--s1)",zIndex:1}}>
                    <div className="s-name">
                      {r.parent_name}
                      {r.topSource===PRICE_SOURCE.SPECIFIC&&<span className="src-badge-specific">CUSTOM</span>}
                      {r.topSource===PRICE_SOURCE.RATIO&&<span className="src-badge-ratio">TIER</span>}
                      {r.topSource===PRICE_SOURCE.WL3&&<span className="src-badge-wl3">WL3</span>}
                      {custFlagMap[r.child_id]?.length>0&&(
                        <span className="flag-row-badge no-print" title={custFlagMap[r.child_id].join("\n")}>
                          ▲{custFlagMap[r.child_id].length}
                        </span>
                      )}
                    </div>
                    {r.variant_name!=="Simple"&&<div className="s-var">{r.variant_name}</div>}
                  </td>
                  <td style={{position:"sticky",left:200,background:"var(--s1)",zIndex:1,boxShadow:"2px 0 4px rgba(0,0,0,.06)"}}><span className="s-sku">{r.child_sku}</span></td>
                  {visibleBreaks.map(q=>{
                    const pd=r.prices[q];
                    const price=pd?.price;
                    const src=pd?.source;
                    // For col M (SPECIFIC) rows: flat price — show only at qty=0, dash elsewhere
                    const isSpecificNonBase = r.topSource===PRICE_SOURCE.SPECIFIC && q!==0;
                    return (
                      <td key={q} style={{paddingLeft:16}}>
                        {!isSpecificNonBase && price!=null
                          ? <span style={{color:src===PRICE_SOURCE.SPECIFIC?"var(--coral)":src===PRICE_SOURCE.WL3?"#2271a8":"var(--brand)"}}>{fmt(price)}</span>
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


// ─── FLAG INFO TOOLTIP ────────────────────────────────────────────────────────
const FLAG_DESCRIPTIONS = [
  { id:"price_zero",  label:"Missing price",       desc:"Wholesale base price (qty 0) is zero or absent. Wholesale is the reference tier — a zero here likely means the data was never populated in the sheet." },
  { id:"tier_order",  label:"Tier order",           desc:"Prices must follow Retail > Commercial > Wholesale at the base qty break. If a lower tier costs more than a higher tier, something was entered incorrectly." },
  { id:"qty_ladder",  label:"Qty ladder",           desc:"Price should decrease (or stay flat) as quantity increases. A price that goes up at a higher qty break is almost always a data entry error." },
  { id:"sentinel",    label:"Sentinel mismatch",    desc:"qty_break=0 and qty_break=1 are meant to be identical duplicates (sentinel rows). If they differ for the same variant+tier, the sheet has inconsistent data for that row." },
  { id:"outlier",     label:"Price outlier",        desc:"A price deviates more than 40% from the median of other qty breaks for the same variant+tier. Calculated as: |price − median| / median. Flags likely typos (e.g. $12 instead of $120)." },
  { id:"image",       label:"Missing image",        desc:"The image_url column is blank for this product. Product cards and the detail panel will show a placeholder instead of a photo." },
  { id:"category",    label:"Uncategorized",        desc:'The category field is blank or set to "Uncategorized". Products without a category are excluded from Sheet View by default and may be missed in exports.' },
  { id:"variant",     label:"Variant issue",        desc:"Either: (a) a variable product has only one variant, which suggests the WooCommerce sync didn't attach sibling variants, or (b) a variant name is blank on a multi-variant product." },
  { id:"sku_dupe",    label:"Duplicate SKU",        desc:"The same child SKU appears under more than one parent product. Since pricing is keyed by child_id (not SKU), this won't break lookups, but it indicates a data integrity problem in the source catalog." },
  { id:"no_qty",      label:"No qty discounts",     desc:"The product has only a base price (qty_break=0) and no quantity break tiers. This may be intentional for some products, but warrants review if quantity pricing is expected." },
];

function FlagInfoTooltip() {
  const [open, setOpen] = useState(false);
  const [pos,  setPos]  = useState({top:0, left:0});
  const btnRef = useRef(null);
  const popRef = useRef(null);

  useEffect(()=>{
    function handler(e){
      if(btnRef.current && btnRef.current.contains(e.target)) return;
      if(popRef.current && popRef.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return ()=>document.removeEventListener("mousedown", handler);
  },[]);

  function handleOpen() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.top, left: r.right + 8 });
    }
    setOpen(o=>!o);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        style={{
          width:15,height:15,borderRadius:"50%",border:"1px solid var(--b3)",
          background:"var(--s3)",color:"var(--t3)",fontSize:9,fontFamily:"var(--fm)",
          cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
          lineHeight:1,flexShrink:0,
        }}
        title="Flag definitions">
        ?
      </button>
      {open && (
        <div ref={popRef} style={{
          position:"fixed", top:pos.top, left:pos.left, zIndex:9999,
          width:290, background:"var(--s1)", border:"1px solid var(--b2)",
          borderRadius:8, boxShadow:"0 4px 24px rgba(0,0,0,.18)", overflow:"hidden",
          maxHeight:"min(420px, 80vh)",
        }}>
          <div style={{padding:"8px 10px",borderBottom:"1px solid var(--b1)",
            fontFamily:"var(--fm)",fontSize:9,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".1em"}}>
            Flag definitions
          </div>
          <div style={{overflowY:"auto", maxHeight:"calc(min(420px,80vh) - 32px)"}}>
            {FLAG_DESCRIPTIONS.map(f=>(
              <div key={f.id} style={{padding:"7px 10px",borderBottom:"1px solid var(--b1)"}}>
                <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--err)",marginBottom:3,fontWeight:500}}>
                  ▲ {f.label}
                </div>
                <div style={{fontSize:11,color:"var(--t2)",lineHeight:1.5,fontFamily:"var(--fb)"}}>
                  {f.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [dark,         setDark]         = useState(false);
  const [showImages,   setShowImages]   = useState(true);
  const [view,         setView]         = useState("browse");
  const [search,       setSearch]       = useState("");
  const [category,     setCategory]     = useState("All");
  const [sortBy,       setSortBy]       = useState("name");
  const [selectedProd, setSelectedProd] = useState(null);
  const [focusChildSku,setFocusChildSku]= useState(null);
  // "none" = no flag filter, or one of the FLAG_TYPE ids
  const [flagTypeFilter, setFlagTypeFilter] = useState("none");
  const selectedCardRef = useRef(null);
  const [sheetExcluded, setSheetExcluded] = useState(()=>new Set(DEFAULT_EXCLUDED_CATEGORIES));

  const [user,        setUser]       = useState(null);  // null = not logged in
  const [authReady,   setAuthReady]  = useState(false); // true once session restore attempted
  const [showUserMgmt,setShowUserMgmt] = useState(false);
  // recoverySession: set when opened via a password-reset / invite link in the URL hash
  const [recoverySession, setRecoverySession] = useState(null); // { accessToken }

  const caps = getRoleCapabilities(user?.role);

  // ── Restore session on mount ──────────────────────────────────────────────
  useEffect(()=>{
    async function restoreSession() {
      // ── Detect Supabase recovery / invite link in URL hash ──────────────────
      // Supabase emails redirect to: https://app.url/#access_token=...&type=recovery
      // We intercept that here so the user sees a "Set password" form instead of login.
      const hash = window.location.hash;
      if (hash && hash.includes("access_token=")) {
        const params = new URLSearchParams(hash.replace(/^#/, ""));
        const tokenType = params.get("type"); // "recovery" or "invite"
        const accessToken = params.get("access_token");
        if (accessToken && (tokenType === "recovery" || tokenType === "invite")) {
          // Clear the hash from the URL so a page refresh doesn't re-trigger this
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          setRecoverySession({ accessToken });
          setAuthReady(true);
          return;
        }
      }
      // ── Normal session restore ───────────────────────────────────────────────
      const session = loadSession();
      if (!session) { setAuthReady(true); return; }
      // Refresh token if expired or within 5 min of expiry
      const needsRefresh = !session.expires_at || Date.now() > session.expires_at - 5 * 60 * 1000;
      try {
        let active = session;
        if (needsRefresh) { active = await sbRefresh(session.refresh_token); saveSession(active); }
        const profileRes = await fetch("/.netlify/functions/get-profile", {
          headers: { "Authorization": `Bearer ${active.access_token}` },
        });
        const profile = await profileRes.json();
        if (profileRes.ok) {
          setUser({ ...profile, accessToken: active.access_token, refreshToken: active.refresh_token });
        } else { clearSession(); }
      } catch { clearSession(); }
      finally  { setAuthReady(true); }
    }
    restoreSession();
  },[]);

  const [allData,   setAllData]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState(null);

  function handleSignOut() {
    clearSession();
    setUser(null);
    setAllData([]);
    setLoading(true);
    setLoadError(null);
  }

  useEffect(()=>{
    if (!user) return; // don't fetch until authenticated
    setLoading(true);
    setLoadError(null);
    fetch("/.netlify/functions/sheet-data")
      .then(r=>r.json())
      .then(rows=>{ setAllData(rows); setLoading(false); })
      .catch(err=>{ setLoadError(err.message); setLoading(false); });
  },[user]);

  // Compute red flags (memoized — expensive)
  const flagMap = useMemo(()=>{
    if (!allData.length) return {};
    const results = computeRedFlags(allData);
    const m = {};
    results.forEach(r=>{ m[r.parent_id]=r.flags; });
    return m;
  },[allData]);

  const flaggedParentIds = useMemo(()=>new Set(Object.keys(flagMap)),[flagMap]);
  const totalFlaggedCount = flaggedParentIds.size;

  const allProducts = useMemo(()=>getProducts(allData),[allData]);

  // ── DATA STATS (row count + freshness) ──
  const dataStats = useMemo(() => {
    if (!allData.length) return null;
    const variantCount = allData.length;
    const timestamps = allData
      .map(r => r.last_updated ? new Date(r.last_updated).getTime() : 0)
      .filter(t => t > 0);
    const lastUpdated = timestamps.length ? new Date(Math.max(...timestamps)) : null;
    const ageMs = lastUpdated ? Date.now() - lastUpdated.getTime() : null;
    const stale = ageMs !== null && ageMs > 48 * 3600 * 1000;
    const aging = ageMs !== null && ageMs > 24 * 3600 * 1000;
    return { variantCount, lastUpdated, stale, aging };
  }, [allData]);

  const allCategories = useMemo(()=>{
    const s = new Set();
    allData.forEach(r=>{ if(r.category) s.add(decodeEntities(r.category)); });
    return [...s].sort();
  },[allData]);

  const categories = useMemo(()=>{
    const m={};
    allProducts.forEach(p=>{ m[p.category]=(m[p.category]||0)+1; });
    return Object.keys(m).sort();
  },[allProducts]);

  const childSkuMap = useMemo(()=>{
    const m={};
    allData.forEach(r=>{ if(!m[r.parent_id]) m[r.parent_id]=new Set(); m[r.parent_id].add(r.child_sku); });
    return m;
  },[allData]);

  // Flag type filter definitions (used in sidebar dropdown + product filtering)
  const FLAG_FILTER_OPTIONS = [
    { id:"none",       label:"No flag filter" },
    { id:"any",        label:"▲ Any flag" },
    { id:"price_zero", label:"▲ Missing price" },
    { id:"tier_order", label:"▲ Tier order" },
    { id:"qty_ladder", label:"▲ Qty ladder" },
    { id:"sentinel",   label:"▲ Sentinel mismatch" },
    { id:"outlier",    label:"▲ Price outlier" },
    { id:"image",      label:"▲ Missing image" },
    { id:"category",   label:"▲ Uncategorized" },
    { id:"variant",    label:"▲ Variant issue" },
    { id:"sku_dupe",   label:"▲ Duplicate SKU" },
    { id:"no_qty",     label:"▲ No qty discounts" },
  ];
  const FLAG_FILTER_MATCH = {
    any:        f => true,
    price_zero: f => f.includes("Missing or zero"),
    tier_order: f => f.includes("tier order violated"),
    qty_ladder: f => f.includes("price increases at qty"),
    sentinel:   f => f.includes("sentinel"),
    outlier:    f => f.includes("Possible price typo"),
    image:      f => f.includes("Missing image"),
    category:   f => f.includes("Uncategorized"),
    variant:    f => f.includes("variant"),
    sku_dupe:   f => f.includes("child SKU"),
    no_qty:     f => f.includes("No quantity discounts"),
  };

  const filtered = useMemo(()=>{
    let list = allProducts;
    const effectiveCat = search?"All":category;
    if(effectiveCat!=="All") list=list.filter(p=>p.category===effectiveCat);
    if(search){
      const match=buildSearchMatcher(search);
      list=list.filter(p=>match([p.parent_name,p.parent_sku,...(childSkuMap[p.parent_id]||[])]));
    }
    if(flagTypeFilter!=="none") {
      const matchFn = FLAG_FILTER_MATCH[flagTypeFilter];
      list=list.filter(p=>{
        const pFlags = flagMap[p.parent_id]||[];
        return pFlags.some(matchFn);
      });
    }
    return [...list].sort((a,b)=>{
      if(sortBy==="name") return a.parent_name.localeCompare(b.parent_name);
      if(sortBy==="sku")  return a.parent_sku.localeCompare(b.parent_sku);
      if(sortBy==="cat")  return a.category.localeCompare(b.category);
      return 0;
    });
  },[allProducts,childSkuMap,category,search,sortBy,flagTypeFilter,flaggedParentIds,flagMap]);

  useEffect(()=>{
    if(search&&filtered.length===1){
      const match=buildSearchMatcher(search);
      setSelectedProd(filtered[0]);
      const matchingSku=[...(childSkuMap[filtered[0].parent_id]||[])].find(sku=>match([sku]));
      setFocusChildSku(matchingSku||null);
    } else if(!search){ setFocusChildSku(null); }
  },[search,filtered]);

  // Scroll selected card into view when selection changes
  useEffect(()=>{
    if(selectedCardRef.current){
      selectedCardRef.current.scrollIntoView({behavior:"smooth",block:"nearest"});
    }
  },[selectedProd]);

  function getWsPrice(pid) {
    return allData.find(r=>r.parent_id===pid&&r.tier==="Wholesale"&&r.qty_break===0)?.price;
  }

  // ── Auth gate: wait for session restore, show login if no user ─────────────
  if (!authReady) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div className="loading-wrap">
        <LogoImg size={48} className="auth-logo"/>
        <div className="spinner"/>
      </div>
    </div>
  );

  // Show password-set form when opened via recovery/invite link
  if (recoverySession) return (
    <PasswordSetGate
      dark={dark}
      accessToken={recoverySession.accessToken}
      onDone={()=>setRecoverySession(null)}
    />
  );

  if (!user) return <AuthGate dark={dark} onAuth={u=>setUser(u)} />;

  if (loading) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div className="loading-wrap">
        <LogoImg size={48} className="auth-logo"/>
        <div className="spinner"/>
        <div style={{textAlign:"center",display:"flex",flexDirection:"column",gap:4}}>
          <div style={{fontFamily:"var(--fd)",fontSize:15,color:"var(--text)"}}>Loading pricing data…</div>
          <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--t3)"}}>Fetching from Google Sheets</div>
        </div>
      </div>
    </div>
  );

  if (loadError) return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>
      <div className="loading-wrap">
        <div style={{fontFamily:"var(--fd)",fontSize:18,color:"var(--err)"}}>Failed to load pricing data</div>
        <div style={{fontFamily:"var(--fm)",fontSize:11,color:"var(--t3)"}}>{loadError}</div>
        <button className="btn btn-a" onClick={()=>{
          setLoading(true);setLoadError(null);
          fetch("/.netlify/functions/sheet-data")
            .then(r=>r.json()).then(rows=>{setAllData(rows);setLoading(false);})
            .catch(err=>{setLoadError(err.message);setLoading(false);});
        }}>Retry</button>
      </div>
    </div>
  );

  const showSidebar = view==="browse" || view==="sheet";

  return (
    <div className={`app${dark?" dark":""}`}>
      <style>{CSS}</style>

      <header className="topbar">
        <LogoImg size={30} className="logo"/>
        <span className="brand">PriceMatrix</span>
        <div className="divider"/>
        <nav className="nav">
          <button className={`nav-btn ${view==="browse"?"active":""}`} onClick={()=>setView("browse")}>⊞ Products</button>
          {caps.canViewSheet && (
            <button className={`nav-btn ${view==="sheet"?"active":""}`} onClick={()=>setView("sheet")}>⋮ Sheet View</button>
          )}
          {caps.canViewCustomers && (
            <button className={`nav-btn ${view==="customer"?"active":""}`} onClick={()=>setView("customer")}>👤 Customer View</button>
          )}
        </nav>
        {dataStats && (() => {
          const fmt = new Intl.DateTimeFormat("en-US", {month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
          const staleCls = dataStats.stale ? " stale" : dataStats.aging ? " aging" : "";
          return (
            <div className={`data-stats no-print${staleCls}`}
              title={dataStats.lastUpdated ? `Last updated: ${fmt.format(dataStats.lastUpdated)}` : ""}>
              <span><span className="ds-val">{dataStats.variantCount.toLocaleString()}</span> prices</span>
              {dataStats.lastUpdated && <>
                <span className="ds-sep"> · </span>
                <span className="ds-date">Updated <span className="ds-val">{fmt.format(dataStats.lastUpdated)}</span></span>
              </>}
            </div>
          );
        })()}
        <div className="topbar-end">
          {caps.canSync && (
            <button className="btn no-print"
              style={{opacity:.5,cursor:"not-allowed",borderColor:"var(--brand)",color:"var(--brand)",fontSize:11,display:"flex",alignItems:"center",gap:5}}
              onClick={e=>e.preventDefault()}
              title="Coming soon — will trigger n8n to pull latest pricing from the website">
              ↻ Update Prices from Website
              <span className="badge-soon">COMING SOON</span>
            </button>
          )}
          <button className="theme-btn" onClick={()=>setDark(d=>!d)} title={dark?"Switch to light mode":"Switch to dark mode"}>
            {dark?"☀":"◑"}
          </button>
          <button className="theme-btn" onClick={()=>setShowImages(s=>!s)} title={showImages?"Hide images":"Show images"}
            style={!showImages?{color:"var(--t4)"}:{}}>
            ⊟
          </button>
          {/* User account button */}
          <div style={{width:1,height:20,background:"var(--b1)",flexShrink:0,marginLeft:2}}/>
          <button className="user-acct-btn no-print" title={user.email}
            onClick={()=>{ if(user?.role==="admin") setShowUserMgmt(true); }}>
            <span style={{width:26,height:26,borderRadius:"50%",background:"var(--brand-dim)",border:"1px solid rgba(72,147,103,.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"var(--brand)",fontWeight:600,flexShrink:0}}>
              {(user.name||user.email)[0].toUpperCase()}
            </span>
            <span style={{fontSize:11,color:"var(--t2)",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {user.name||user.email}
            </span>
          </button>
          <button className="btn no-print" style={{fontSize:11,color:"var(--t3)"}}
            onClick={handleSignOut} title="Sign out">
            Sign out
          </button>
        </div>
      </header>
      {showUserMgmt && user?.role === "admin" && (
        <UserManagementModal currentUser={user} onClose={()=>setShowUserMgmt(false)}/>
      )}

      <div className="body">
        {showSidebar && (
          <aside className="sidebar">
            {view==="browse" && (
              <div className="sb-sec">
                <div className="sb-lbl">Search</div>
                <input className="inp" placeholder="Name or SKU…" value={search} onChange={e=>setSearch(e.target.value)}/>
              </div>
            )}

            {/* Category list — single-select for Browse, checkbox-toggle for Sheet */}
            <div className="sb-sec" style={{
              flex: view==="sheet" ? 1 : undefined,
              overflow: "hidden",
              display:"flex", flexDirection:"column",
            }}>
              {view==="sheet" ? (
                <>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <div className="sb-lbl" style={{marginBottom:0}}>Categories</div>
                    <div style={{display:"flex",gap:3}}>
                      <button className="btn" style={{fontSize:8,padding:"1px 5px"}} title="Reset to default exclusions"
                        onClick={()=>setSheetExcluded(new Set(DEFAULT_EXCLUDED_CATEGORIES.filter(c=>allCategories.includes(c))))}>
                        Reset
                      </button>
                      <button className="btn" style={{fontSize:8,padding:"1px 5px"}} title="Show all categories"
                        onClick={()=>setSheetExcluded(new Set())}>
                        All
                      </button>
                      <button className="btn" style={{fontSize:8,padding:"1px 5px"}} title="Hide all (select none)"
                        onClick={()=>setSheetExcluded(new Set(allCategories))}>
                        None
                      </button>
                    </div>
                  </div>
                  <div className="cat-list" style={{flex:1,maxHeight:"none"}}>
                    {allCategories.map(cat=>{
                      const isVisible = !sheetExcluded.has(cat);
                      return (
                        <button key={cat} className="cat-btn"
                          style={isVisible?{}:{color:"var(--t4)"}}
                          onClick={()=>{
                            const next = new Set(sheetExcluded);
                            isVisible ? next.add(cat) : next.delete(cat);
                            setSheetExcluded(next);
                          }}>
                          <span style={{fontSize:11,marginRight:5,flexShrink:0,color:isVisible?"var(--brand)":"var(--t4)"}}>{isVisible?"☑":"☐"}</span>
                          <span style={{flex:1,textAlign:"left",fontSize:11,textDecoration:isVisible?"none":"line-through"}}>{cat}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div className="sb-lbl">Category</div>
                  <div className="cat-list">
                    <button className={`cat-btn ${category==="All"?"on":""}`} onClick={()=>{setCategory("All");setSelectedProd(null);}}>
                      All <span className="cat-cnt">{allProducts.length}</span>
                    </button>
                    {categories.map(cat=>(
                      <button key={cat} className={`cat-btn ${category===cat?"on":""}`} onClick={()=>{setCategory(cat);setSelectedProd(null);}}>
                        {cat} <span className="cat-cnt">{allProducts.filter(p=>p.category===cat).length}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {view==="browse" && (
              <>
                <div className="sb-sec">
                  <div className="sb-lbl">Sort</div>
                  <select className="sel" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
                    <option value="name">Name A→Z</option>
                    <option value="sku">SKU</option>
                    <option value="cat">Category</option>
                  </select>
                </div>
                <div className="sb-sec">
                  <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:6}}>
                    <div className="sb-lbl" style={{marginBottom:0}}>Data Quality</div>
                    <FlagInfoTooltip/>
                  </div>
                  <select className="sel"
                    value={flagTypeFilter}
                    onChange={e=>{ setFlagTypeFilter(e.target.value); setSelectedProd(null); }}
                    style={flagTypeFilter!=="none"?{borderColor:"var(--err)",color:"var(--err)",background:"var(--err-bg)"}:{}}>
                    {FLAG_FILTER_OPTIONS.map(o=>(
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  {flagTypeFilter!=="none" && (
                    <div style={{fontFamily:"var(--fm)",fontSize:9,color:"var(--t3)",marginTop:5}}>
                      {filtered.length} product{filtered.length!==1?"s":""} · {
                        flagTypeFilter==="any"
                          ? `${totalFlaggedCount} total flagged`
                          : FLAG_FILTER_OPTIONS.find(o=>o.id===flagTypeFilter)?.label.replace("▲ ","")
                      }
                    </div>
                  )}
                </div>
                <div className="sb-sec" style={{flex:1}}>
                  <div className="sb-lbl">Tiers</div>
                  <div className="tier-legend">
                    {caps.tiers.map(t=>(
                      <div key={t} className="tleg-row">
                        <span className="tdot" style={{background:TIER_COLORS[t]}}/>
                        <span style={{color:t==="Wholesale"?"var(--ws)":undefined}}>{t}</span>
                        {t==="Wholesale"&&<span className="ws-tag">BASE</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </aside>
        )}

        <div className="main">
          {view==="browse" && (
            <>
              <div className="grid">
                {filtered.length===0&&<div className="empty"><h3>No products found</h3><p>Adjust search or category</p></div>}
                {filtered.map(p=>{
                  const wsPrice=getWsPrice(p.parent_id);
                  const vars=getVariants(allData,p.parent_id);
                  const isSimple=vars.length===1&&vars[0].variant_name==="Simple";
                  const myFlagCount=(flagMap[p.parent_id]||[]).length;
                  return (
                    <div key={p.parent_id}
                      ref={selectedProd?.parent_id===p.parent_id ? selectedCardRef : null}
                      className={`pcard ${selectedProd?.parent_id===p.parent_id?"on":""}`}
                      onClick={()=>setSelectedProd(p)}>
                      {showImages&&(
                        <div className="pcard-img-wrap">
                          {myFlagCount>0&&<span className="pcard-flag">▲{myFlagCount}</span>}
                          <img className="pcard-img" src={p.image_url} alt={p.parent_name}
                            onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="flex";}}/>
                          <div className="pcard-img-ph" style={{display:"none"}}>
                            <span>{p.category?.[0]}</span>
                          </div>
                        </div>
                      )}
                      {!showImages&&myFlagCount>0&&(
                        <div style={{padding:"4px 8px",background:"var(--err-bg)",borderBottom:"1px solid rgba(201,64,64,.15)"}}>
                          <span className="flag-row-badge">▲{myFlagCount} flag{myFlagCount!==1?"s":""}</span>
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
                <DetailPanel key={selectedProd.parent_id} product={selectedProd} visibleTiers={caps.tiers}
                  onClose={()=>{setSelectedProd(null);setFocusChildSku(null);}}
                  allData={allData} focusChildSku={focusChildSku} caps={caps} flagMap={flagMap}/>
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

          {view==="sheet" && caps.canViewSheet && (
            <SheetView visibleTiers={caps.tiers} allData={allData} caps={caps}
              excluded={sheetExcluded} setExcluded={setSheetExcluded} allCategories={allCategories}/>
          )}

          {view==="customer" && caps.canViewCustomers && (
            <CustomerView allData={allData} caps={caps}/>
          )}
        </div>
      </div>
    </div>
  );
}
