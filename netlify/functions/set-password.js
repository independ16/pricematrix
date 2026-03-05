// netlify/functions/set-password.js
// Sets a user's password via the GoTrue admin API after invite verification.
//
// The user-facing GoTrue API (PUT /user) does not reliably persist passwords
// on Netlify's hosted GoTrue instance. This function uses the admin API instead,
// which is authoritative and bypasses the client-side persistence bug.
//
// Called after POST /verify succeeds on the frontend — we have the user's ID
// and access token at that point, which is all we need here.
//
// Request:  POST /.netlify/functions/set-password
//           Authorization: Bearer {user_access_token}   ← populates clientContext
//           Body: { userId: string, password: string }
//
// Response: 200 { ok: true }
//           400 { error: "..." }   ← missing fields
//           401 { error: "..." }   ← no admin token available
//           502 { error: "..." }   ← admin API call failed

exports.handler = async function(event, context) {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Extract admin token from Netlify Identity context
  const adminToken = context.clientContext?.identity?.token;
  const identityUrl = context.clientContext?.identity?.url || "/.netlify/identity";
  console.log("set-password: adminToken present:", !!adminToken, "identityUrl:", identityUrl);
  if (!adminToken) {
    console.error("set-password: no admin token in clientContext — was Authorization header sent?");
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        error: "Admin token not available",
        hasClientContext: !!context.clientContext,
        hasIdentity: !!context.clientContext?.identity,
      }),
    };
  }

  // Parse request body
  let userId, password;
  try {
    const body = JSON.parse(event.body || "{}");
    userId   = body.userId;
    password = body.password;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!userId || !password) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "userId and password are required" }),
    };
  }

  if (password.length < 8) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Password must be at least 8 characters" }),
    };
  }

  // Call GoTrue admin API to set the password
  try {
    const adminRes = await fetch(`${identityUrl}/admin/users/${userId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ password, confirm: true }),
    });

    const adminData = await adminRes.json();

    if (!adminRes.ok) {
      console.error("set-password: admin API failed:", adminRes.status, adminData);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: adminData.msg || adminData.error_description || "Admin API call failed" }),
      };
    }

    const hasEncryptedPassword = !!adminData.encrypted_password;
    console.log("set-password: admin API response for user", userId, "| encrypted_password present:", hasEncryptedPassword);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, adminResponse: adminData, passwordPersisted: hasEncryptedPassword }),
    };

  } catch (err) {
    console.error("set-password: fetch error:", err);
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Network error calling admin API" }),
    };
  }
};
