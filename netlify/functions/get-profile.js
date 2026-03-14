// netlify/functions/get-profile.js
//
// Returns the calling user's profile (name, role) from the user_profiles table.
// Called immediately after a successful Supabase login so the frontend knows
// what role the user has.
//
// We use the SERVICE_ROLE_KEY on the server side so RLS doesn't block the read
// (the user's JWT is verified first to confirm identity).
//
// Request:  GET /.netlify/functions/get-profile
//           Authorization: Bearer {supabase_access_token}
//
// Response: 200 { id, email, name, role }
//           401 { error: "..." }   — missing / invalid token
//           404 { error: "..." }   — no profile row (user was never assigned a role)
//           502 { error: "..." }   — Supabase API call failed

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  "Content-Type":  "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async function(event) {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Authorization", "Access-Control-Allow-Methods": "GET,OPTIONS" }, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── Verify access token ─────────────────────────────────────────────────────
  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Missing Authorization header" }) };
  }

  // Validate the token and get the user's ID from Supabase Auth
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_SERVICE_KEY,
    },
  });

  if (!userRes.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid or expired session" }) };
  }

  const authUser = await userRes.json();
  const userId   = authUser.id;
  const email    = authUser.email;

  // ── Read profile from user_profiles ────────────────────────────────────────
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=id,email,name,role&limit=1`,
    {
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "apikey":         SUPABASE_SERVICE_KEY,
      },
    }
  );

  if (!profileRes.ok) {
    const err = await profileRes.text();
    console.error("get-profile: user_profiles read failed:", profileRes.status, err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Failed to read user profile" }) };
  }

  const profiles = await profileRes.json();

  if (!profiles || profiles.length === 0) {
    // Profile row missing — could be the very first admin (Nash) before his
    // profile row exists, or an invited user whose upsert failed.
    // Fall back to user_metadata if role was embedded there at invite time.
    const metaRole = authUser.user_metadata?.role;
    const metaName = authUser.user_metadata?.name;

    if (metaRole) {
      console.warn(`get-profile: no user_profiles row for ${userId} — using user_metadata role: ${metaRole}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ id: userId, email, name: metaName || email, role: metaRole }),
      };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: "No profile found for this user. Contact your administrator." }) };
  }

  const profile = profiles[0];
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ id: profile.id, email: profile.email || email, name: profile.name, role: profile.role }),
  };
};
