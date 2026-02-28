// netlify/functions/sheet-data.js
// Fetches pricing data from Google Sheets using service account credentials.
// Called by the React app via /.netlify/functions/sheet-data
//
// Required Netlify environment variables:
//   GOOGLE_SERVICE_ACCOUNT_JSON  — full JSON contents of service account key file
//   GOOGLE_SPREADSHEET_ID        — ID from Google Sheet URL (between /d/ and /edit)
//   GOOGLE_SHEET_TAB             — exact tab name (case-sensitive)

const { google } = require("googleapis");

exports.handler = async function (event, context) {
  try {
    // Parse service account credentials from environment variable
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    // Authenticate with Google Sheets API
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // Fetch all rows from the specified tab
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: `${process.env.GOOGLE_SHEET_TAB}`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, s-maxage=300",
        },
        body: JSON.stringify([]),
      };
    }

    // First row is headers, remaining rows are data
    const headers = rows[0];
    const data = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, i) => {
        const val = row[i] ?? "";
        // Type coercion — Google Sheets returns everything as strings
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
            obj[header] = val === "" || val === "null" ? null : val;
            break;
          default:
            obj[header] = val;
        }
      });
      return obj;
    });

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
