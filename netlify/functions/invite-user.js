// netlify/functions/invite-user.js
//
// Admin-only endpoint — invites a new user via Supabase Admin API and writes
// their name + role to the user_profiles table.
//
// The caller must supply a valid Supabase access_token belonging to a user
// whose user_profiles.role === "admin".  The function verifies this before
// doing anything privileged.
//
// Request:  POST /.netlify/functions/invite-user
//           Authorization: Bearer {supabase_access_token}
//           Body: { email, name, role }
//
// Response: 200 { ok: true }
//           400 { error: "..." }   — missing / invalid fields
//           401 { error: "..." }   — not authenticated or not admin
//           409 { error: "..." }   — user already exists
//           502 { error: "..." }   — Supabase API call failed

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The anon key is safe to hardcode here — it's already public in the frontend.
// It is required for the /auth/v1/user endpoint (which validates user JWTs),
// which rejects the service role key in the apikey header.
const SUPABASE_ANON_KEY = "sb_publishable_H3M7RiA4omp-KvMy2s3plg_ce4wO0BV";

const ALLOWED_ROLES = ["admin", "manager", "viewer"];

const headers = {
  "Content-Type":  "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async function(event) {
  // ── Diagnostic: log env var state on every invocation ──────────────────────
  console.log("invite-user: SUPABASE_URL present:", !!SUPABASE_URL, "| starts with https:", SUPABASE_URL?.startsWith("https"));
  console.log("invite-user: SUPABASE_SERVICE_KEY present:", !!SUPABASE_SERVICE_KEY, "| length:", SUPABASE_SERVICE_KEY?.length);

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "POST,OPTIONS" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Guard: if env vars missing, fail fast with a clear error instead of a cryptic crash
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("invite-user: missing env vars — SUPABASE_URL:", SUPABASE_URL, "| SUPABASE_SERVICE_ROLE_KEY present:", !!SUPABASE_SERVICE_KEY);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfiguration: missing Supabase env vars" }) };
  }

  // ── Verify caller is an authenticated admin ─────────────────────────────────
  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!callerToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Missing Authorization header" }) };
  }

  // Get caller's user record from Supabase using their access token.
  // Must use the ANON key here — the /auth/v1/user endpoint validates user JWTs
  // and requires the anon key, not the service role key.
  const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${callerToken}`,
      "apikey": SUPABASE_ANON_KEY,
    },
  });

  if (!callerRes.ok) {
    const errText = await callerRes.text();
    console.error("invite-user: /auth/v1/user failed:", callerRes.status, errText);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid or expired session" }) };
  }

  const callerUser = await callerRes.json();
  const callerId   = callerUser.id;

  // Look up caller's role in user_profiles
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${callerId}&select=role`,
    {
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "apikey":         SUPABASE_SERVICE_KEY,
      },
    }
  );

  if (!profileRes.ok) {
    const errText = await profileRes.text();
    console.error("invite-user: user_profiles lookup failed:", profileRes.status, errText);
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Failed to look up caller profile" }) };
  }

  const profiles = await profileRes.json();
  const callerRole = profiles?.[0]?.role;

  console.log("invite-user: caller role:", callerRole);

  if (callerRole !== "admin") {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Admin access required" }) };
  }

  // ── Parse and validate request body ────────────────────────────────────────
  let email, name, role;
  try {
    const body = JSON.parse(event.body || "{}");
    email = (body.email || "").trim().toLowerCase();
    name  = (body.name  || "").trim();
    role  = (body.role  || "").trim();
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!email || !name || !role) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "email, name, and role are required" }) };
  }

  if (!ALLOWED_ROLES.includes(role)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid role. Must be one of: ${ALLOWED_ROLES.join(", ")}` }) };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid email address" }) };
  }

  // ── Send Supabase invite ────────────────────────────────────────────────────
  // Supabase Admin invite API sends a magic-link email so the user can set
  // their own password.  We embed name + role in user_metadata so they're
  // available immediately; we also write them to user_profiles below.
  const inviteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/invite`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "apikey":         SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({
      email,
      data: { name, role },   // user_metadata — available on the client immediately after invite
    }),
  });

  const inviteText = await inviteRes.text();
  console.log("invite-user: Supabase invite response:", inviteRes.status, inviteText.slice(0, 200));

  let inviteData;
  try {
    inviteData = JSON.parse(inviteText);
  } catch {
    console.error("invite-user: Supabase invite returned non-JSON:", inviteText.slice(0, 500));
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Supabase returned unexpected response — check function logs" }) };
  }

  if (!inviteRes.ok) {
    // Supabase returns 422 when the user already exists
    if (inviteRes.status === 422) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: "A user with that email already exists" }) };
    }
    console.error("invite-user: Supabase invite failed:", inviteRes.status, inviteData);
    return { statusCode: 502, headers, body: JSON.stringify({ error: inviteData.msg || inviteData.error_description || "Supabase invite failed" }) };
  }

  const newUserId = inviteData.id;

  // ── Write to user_profiles ──────────────────────────────────────────────────
  // Upsert so re-inviting an existing user updates their profile cleanly.
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "apikey":         SUPABASE_SERVICE_KEY,
      "Prefer":         "resolution=merge-duplicates",
    },
    body: JSON.stringify({ id: newUserId, email, name, role }),
  });

  if (!upsertRes.ok) {
    const upsertErr = await upsertRes.text();
    console.error("invite-user: user_profiles upsert failed:", upsertRes.status, upsertErr);
    // Don't fail the whole request — the invite went out, the profile write is
    // a secondary concern and can be fixed manually in Supabase dashboard.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, warning: "Invite sent but profile write failed — set role manually in Supabase dashboard" }),
    };
  }

  console.log(`invite-user: invited ${email} as ${role} (uid: ${newUserId})`);
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
