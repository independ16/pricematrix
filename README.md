# PriceMatrix — Local Development Setup

## Quick Start (Mock Data)

1. **Open this folder in VS Code**, then in the terminal (Ctrl+`):

   ```
   npm install
   npm run dev
   ```

2. Browser opens to http://localhost:3000 — sign in with any demo user.

This runs Vite only — great for UI work with mock data.

## Full Stack Local Dev (Real Data)

When you're ready to wire up Google Sheets data:

1. **Install Netlify CLI globally** (one time):

   ```
   npm install -g netlify-cli
   ```

2. **Set up your environment variables:**

   ```
   copy .env.example .env
   ```

   Edit `.env` and fill in your real values (service account JSON, sheet ID, tab name).

3. **Run with Netlify CLI:**

   ```
   npm run netlify-dev
   ```

   This starts both Vite (port 3000) and the serverless function, proxied together
   on http://localhost:8888. The function is available at
   `http://localhost:8888/.netlify/functions/sheet-data`.

## Project Structure

```
pricematrix-local/
├── index.html                      ← HTML entry point
├── package.json                    ← Dependencies & scripts
├── vite.config.js                  ← Vite dev server config
├── netlify.toml                    ← Netlify build + function config
├── .env.example                    ← Template for environment variables
├── .gitignore                      ← Keeps secrets & build output out of git
├── src/
│   ├── main.jsx                    ← React mount point
│   └── App.jsx                     ← Full PriceMatrix app (woo-pricing-ui-v3.jsx)
├── netlify/
│   └── functions/
│       └── sheet-data.js           ← Serverless function: Google Sheets → JSON
└── README.md
```

## Key Commands

| Command              | What it does                                           |
|----------------------|--------------------------------------------------------|
| `npm run dev`        | Vite only — mock data, fast hot reload                 |
| `npm run netlify-dev`| Vite + serverless functions — real data from Sheets    |
| `npm run build`      | Production build → `dist/`                             |
| `npm run preview`    | Preview production build locally                       |

## Editing Workflow

1. Open `src/App.jsx` in VS Code
2. Make changes, save — browser updates automatically (HMR)
3. When working with Claude in the project chat, copy updated code into `App.jsx`

## Notes

- `npm run dev` = UI work only (mock data, no serverless functions)
- `npm run netlify-dev` = full stack (functions + Vite, needs `.env` configured)
- The `.env` file is gitignored — never commit it
- The Google Fonts `@import` in the CSS may cause a brief flash on first load
- Mock auth (demo user picker) will be replaced by Netlify Identity when deployed
