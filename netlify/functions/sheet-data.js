// netlify/functions/sheet-data.js
// Fetches pricing data from Google Sheets using service account credentials.
// Called by the React app via /.netlify/functions/sheet-data
//
// Required Netlify environment variables:
//   GOOGLE_SERVICE_ACCOUNT_JSON  — full JSON contents of service account key file
//   GOOGLE_SPREADSHEET_ID        — ID from Google Sheet URL (between /d/ and /edit)
//   GOOGLE_SHEET_TAB             — exact tab name for master pricing (case-sensitive)
//
// Additional tabs read (hardcoded — no env var needed):
//   Customer_Pricing_Ratio_STAGING  — generic ratio rows (customer_id blank)
//   Customer_Specific_Pricing       — named customer override rows (col M style)

const { google } = require("googleapis");

// Parse a raw rows array (first row = headers) into typed objects
function parseSheet(rows, defaultCustomerId = undefined) {
  if (!rows || rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      const val = row[i] ?? "";
      switch (header) {
        case "uid":
        case "parent_id":
        case "child_id":
        case "qty_break":
          obj[header] = parseInt(val, 10) || 0;
          break;
        case "price":
          obj[header] = parseFloat(val) || 0;
          break;
        case "customer_id":
          // Blank or "null" string → null (generic fallback row)
          obj[header] = val === "" || val === "null" ? null : val;
          break;
        default:
          obj[header] = val;
      }
    });
    // Allow caller to force a customer_id value (not used currently)
    if (defaultCustomerId !== undefined && obj.customer_id === undefined) {
      obj.customer_id = defaultCustomerId;
    }
    return obj;
  });
}

exports.handler = async function (event, context) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    // Fetch all three tabs in parallel
    const [masterResp, ratioResp, specificResp] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: process.env.GOOGLE_SHEET_TAB,
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Customer_Pricing_Ratio_STAGING",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Customer_Specific_Pricing",
      }),
    ]);

    const masterData   = parseSheet(masterResp.data.values);
    const ratioData    = parseSheet(ratioResp.data.values).map(r => ({ ...r, _src: "ratio" }));
    const specificData = parseSheet(specificResp.data.values).map(r => ({ ...r, _src: "specific" }));

    // Concatenate — master first, then customer pricing rows
    const data = [...masterData, ...ratioData, ...specificData];

    const zlib = require("zlib");
    const compressed = zlib.gzipSync(JSON.stringify(data));

    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Cache-Control": "public, s-maxage=300",
      },
      body: compressed.toString("base64"),
    };
  } catch (error) {
    console.error("Sheet data fetch error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to fetch pricing data" }),
    };
  }
};
