# Gitterdone Desktop

A minimal [Electron](https://www.electronjs.org/) shell around the live Gitterdone
web app. It is a single window that loads **https://app.gitterdone.org**, so it
always shows the latest deployed version — there is nothing to rebuild when the
web app updates.

This repo is **completely separate** from the web app's repo and Vercel project.
It contains no application code and no copy of the site — only the desktop wrapper.

## Run it (development)

```bash
npm install
npm start
```

## Build a double-clickable macOS app

```bash
npm run dist
```

The packaged `.app`, `.dmg`, and `.zip` land in `dist/`.

## Point it somewhere else

The URL lives in one place — `APP_URL` in [`main.js`](main.js). You can also
override it at launch without editing code:

```bash
GITTERDONE_URL="https://staging.example.com" npm start
```

## How it works

- `main.js` — creates the window and loads `APP_URL`. External links open in the
  user's real browser; failed loads (offline / mid-deploy) retry automatically.
- `preload.js` — intentionally empty; the web app gets no Node access (sandboxed).
- `package.json` — `electron-builder` config for packaging.
