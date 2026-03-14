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

const ALLOWED_ROLES = ["admin", "manager", "viewer"];

const headers = {
  "Content-Type":  "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async function(event) {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "POST,OPTIONS" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── Verify caller is an authenticated admin ─────────────────────────────────
  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!callerToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Missing Authorization header" }) };
  }

  // Get caller's user record from Supabase using their access token
  const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${callerToken}`,
      "apikey": SUPABASE_SERVICE_KEY,
    },
  });

  if (!callerRes.ok) {
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

  const profiles = await profileRes.json();
  const callerRole = profiles?.[0]?.role;

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

  const inviteData = await inviteRes.json();

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
