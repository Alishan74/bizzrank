import crypto from 'crypto';
import 'dotenv/config';
const KEY = process.env.GOOGLE_MAPS_API_KEY!;
const CID = process.env.GOOGLE_OAUTH_CLIENT_ID!;
const CSE = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
const RDR = process.env.GOOGLE_OAUTH_REDIRECT_URI!;

export async function getPlaceAutocomplete(input: string, types = 'establishment') {
  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', input); url.searchParams.set('types', types); url.searchParams.set('key', KEY);
  try {
    const d = await fetch(url.toString()).then(r => r.json()) as any;
    if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') return [];
    return (d.predictions ?? []).map((p: any) => ({ placeId: p.place_id, description: p.description, mainText: p.structured_formatting?.main_text ?? p.description, secondaryText: p.structured_formatting?.secondary_text ?? '' }));
  } catch { return []; }
}

export async function getAddressAutocomplete(input: string) { return getPlaceAutocomplete(input, 'address'); }

export async function getPlaceDetails(placeId: string) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId); url.searchParams.set('fields', 'name,formatted_address,geometry,formatted_phone_number,website,types,rating,opening_hours'); url.searchParams.set('key', KEY);
  try {
    const d = await fetch(url.toString()).then(r => r.json()) as any;
    if (d.status !== 'OK') return null;
    const r = d.result;
    let openingHours = null;
    if (r.opening_hours?.periods) {
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      openingHours = {};
      for (const p of r.opening_hours.periods) {
        if (p.open && p.close) {
          const day = days[p.open.day];
          (openingHours as any)[day] = {
            open: `${String(Math.floor(p.open.time / 100)).padStart(2,'0')}:${String(p.open.time % 100).padStart(2,'0')}`,
            close: `${String(Math.floor(p.close.time / 100)).padStart(2,'0')}:${String(p.close.time % 100).padStart(2,'0')}`,
          };
        }
      }
    }
    return { placeId, name: r.name, address: r.formatted_address, latitude: r.geometry?.location?.lat, longitude: r.geometry?.location?.lng, phone: r.formatted_phone_number, website: r.website, category: r.types?.[0]?.replace(/_/g, ' '), rating: r.rating, openingHours };
  } catch { return null; }
}

export function getGBPAuthUrl(userId: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CID); url.searchParams.set('redirect_uri', RDR); url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/userinfo.email');
  // CSRF fix: use random state token instead of userId
  // State token → Redis (5 min TTL), verified on callback
  const stateToken = crypto.randomBytes(32).toString('hex');
  // Store mapping: state → userId in Redis (imported lazily to avoid circular dep)
  import('../../infrastructure/cache/RedisClient.js').then(({ redis }) => {
    redis.setex('gbp:state:' + stateToken, 300, userId).catch(() => {});
  });
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', stateToken);
  return url.toString();
}

export async function exchangeGBPCode(code: string) {
  const d = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ code, client_id: CID, client_secret: CSE, redirect_uri: RDR, grant_type:'authorization_code' }) }).then(r => r.json()) as any;
  if (!d.access_token) throw new Error('Token exchange failed');
  return { accessToken: d.access_token, refreshToken: d.refresh_token };
}

export async function fetchGBPLocations(accessToken: string) {
  try {
    const ad = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers:{ Authorization:`Bearer ${accessToken}` } }).then(r => r.json()) as any;
    if (!ad.accounts?.length) return [];
    const ld = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${ad.accounts[0].name}/locations?readMask=name,title,storefrontAddress,latlng,phoneNumbers,websiteUri,categories`, { headers:{ Authorization:`Bearer ${accessToken}` } }).then(r => r.json()) as any;
    return (ld.locations ?? []).map((loc: any) => ({ gbpLocationId: loc.name, name: loc.title, address: [loc.storefrontAddress?.addressLines?.[0], loc.storefrontAddress?.locality, loc.storefrontAddress?.administrativeArea].filter(Boolean).join(', '), latitude: loc.latlng?.latitude, longitude: loc.latlng?.longitude, phone: loc.phoneNumbers?.primaryPhone, website: loc.websiteUri, category: loc.categories?.primaryCategory?.displayName }));
  } catch { return []; }
}
