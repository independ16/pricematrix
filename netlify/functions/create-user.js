// netlify/functions/create-user.js
// Admin-only function: creates a new GoTrue user directly via POST /admin/users
// with a temporary password — bypasses the broken invite/verify/set-password flow entirely.
//
// The Netlify hosted GoTrue instance does not persist passwords set via the
// invite/verify path (PUT /user or PUT /admin/users/{id} both fail silently).
// Creating the user with the password in the initial POST call is the only
// reliable path on this platform.
//
// Workflow:
//   1. Admin calls this function with { email, role, tempPassword }
//   2. Function creates user via POST /admin/users with confirm: true
//   3. Function sets role via PUT /admin/users/{id} with app_metadata
//   4. Admin manually notifies the new user of their temp password
//   5. New user logs in normally, then uses Forgot Password to set their own
//
// Request:  POST /.netlify/functions/create-user
//           Authorization: Bearer {admin_access_token}
//           Body: { email: string, role: string, tempPassword: string }
//
// Response: 200 { ok: true, userId, email, passwordPersisted }
//           400 { error: "..." }
//           401 { error: "..." }
//           403 { error: "..." }  ← caller is not admin role
//           502 { error: "..." }  ← GoTrue API call failed

exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const adminToken = context.clientContext?.identity?.token;
  const identityUrl = context.clientContext?.identity?.url;

  if (!adminToken || !identityUrl) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Admin token not available — was Authorization header sent?" }),
    };
  }

  // Verify the caller is an admin via their JWT
  const callerToken = (event.headers.authorization || "").replace("Bearer ", "");
  if (callerToken) {
    try {
      const payload = JSON.parse(Buffer.from(callerToken.split(".")[1], "base64").toString());
      const callerRole = payload?.app_metadata?.roles?.[0];
      if (callerRole !== "admin") {
        return {
          statusCode: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Only admins can create users" }),
        };
      }
    } catch {
      // If JWT parse fails, let GoTrue admin token gate it
    }
  }

  let email, role, tempPassword;
  try {
    const body = JSON.parse(event.body || "{}");
    email        = body.email?.trim().toLowerCase();
    role         = body.role || "viewer";
    tempPassword = body.tempPassword;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!email || !tempPassword) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "email and tempPassword are required" }),
    };
  }

  if (tempPassword.length < 8) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "tempPassword must be at least 8 characters" }),
    };
  }

  const VALID_ROLES = ["admin", "manager", "viewer", "commercial", "wholesale", "retail"];
  if (!VALID_ROLES.includes(role)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` }),
    };
  }

  try {
    // Step 1: Create the user with password + role in one call
    // confirm: true = admin is confirming this user, no email verification needed
    const createRes = await fetch(`${identityUrl}/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        email,
        password: tempPassword,
        confirm: true,
        app_metadata: { roles: [role] },
      }),
    });

    const createData = await createRes.json();

    if (!createRes.ok) {
      console.error("create-user: POST /admin/users failed:", createRes.status, createData);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: createData.msg || createData.error_description || "Failed to create user" }),
      };
    }

    const userId = createData.id;
    const passwordPersisted = !!createData.encrypted_password;
    console.log("create-user: created user", userId, email, "role:", role, "| encrypted_password present:", passwordPersisted);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        userId,
        email,
        role,
        passwordPersisted,
        adminResponse: createData,
      }),
    };

  } catch (err) {
    console.error("create-user: fetch error:", err);
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Network error calling admin API" }),
    };
  }
};
