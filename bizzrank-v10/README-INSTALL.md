# Scan Results Map — installation guide

Two files to drop in, one tiny code change, one .env variable. ~10 minutes.

## Step 1 — Replace the backend route

Copy `apps/api/src/api/routes/organicScans.ts` over your existing file.
This is the same file as in your last fix-pack PLUS a `clientPoints` array in
the GET /:scanId response.

## Step 2 — Add the React component

Copy the entire `apps/frontend/src/components/ScanResultsMap/` folder into your
frontend project at the same path. Two files: `ScanResultsMap.tsx` and
`ScanResultsMap.css`.

## Step 3 — Add your Google Maps API key

In `apps/frontend/.env` (create the file if it doesn't exist), add:

    VITE_GOOGLE_MAPS_API_KEY=your-google-maps-javascript-api-key

This is the **browser** key. It can be the same physical key as your backend
Google Maps key, BUT you should restrict it to HTTP referrers (your domains
only) in Google Cloud Console — otherwise anyone who views your site can copy
the key from the JS bundle and run up your bill.

Where to restrict:
  Google Cloud Console → APIs & Services → Credentials → your API key
  → Application restrictions → "Websites"
  → Add: http://localhost:5173/*  AND  https://your-prod-domain.com/*

Also make sure these APIs are enabled in the same Cloud project:
  - Maps JavaScript API
  - Places API (you already have this)

## Step 4 — Use the component in your scan detail page

Wherever you currently render the scan result (likely `apps/frontend/src/pages/ScanDetail.tsx`
or similar), add the import and use the component:

```tsx
import { ScanResultsMap } from '../components/ScanResultsMap/ScanResultsMap';

// inside your component, after you've fetched the scan data:
const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

return (
  <div>
    {/* ...your existing scan header, score, etc... */}

    {scanData.business && scanData.clientPoints && (
      <section style={{ marginTop: 24 }}>
        <h2>Ranking heatmap</h2>
        <ScanResultsMap
          business={scanData.business}
          clientPoints={scanData.clientPoints}
          rankings={scanData.rankings}
          apiKey={apiKey}
        />
      </section>
    )}

    {/* ...rest of page... */}
  </div>
);
```

The data shape the API returns matches what the component expects, so no
transformation needed.

## Step 5 — Restart and test

1. Save all files
2. Restart the API: in your terminal running `npm run dev`, press Ctrl+C then `npm run dev`
3. Vite will hot-reload the frontend automatically
4. Open any completed scan in your app — the map should render

## What you'll see

- Blue pin = your business location
- Colored circle at each grid point = your rank at that point
  - Green with number 1/2/3 = top 3 (excellent)
  - Yellow with number 4–10 = page 1 (decent)
  - Red with number 11–20 = page 2+ (work needed)
  - Gray X = you didn't appear in the top 20 at all
- Click any circle to see the top 5 competitors at that exact point
- Legend in bottom-left shows count of each color

## Troubleshooting

**Map area is gray with "Loading map…"** — Google Maps script failed. Check browser
console. Most likely cause: API key missing, wrong, or doesn't have Maps JavaScript
API enabled in Google Cloud.

**"For development purposes only" watermark on map** — API key isn't billable.
Enable billing on your Google Cloud project (you get $200/month free credit).

**Map loads but no markers appear** — Your scan completed BEFORE you applied
the backend change, so `clientPoints` is undefined. Run a new scan, or refresh
the page after the change. Existing scans will work too because the route computes
clientPoints on the fly from the existing rankings data.

**Markers appear but all gray** — Your business has no `google_place_id` set,
so we can't match it against the SerpApi results. Re-add the business via the
Google Maps autocomplete to capture the place ID.

