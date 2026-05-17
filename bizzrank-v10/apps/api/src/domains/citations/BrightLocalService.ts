import 'dotenv/config';

const BL_API_KEY = process.env.BRIGHTLOCAL_API_KEY;
const BL_BASE = 'https://tools.brightlocal.com/seo-tools/api/v4';

export const BRIGHTLOCAL_PLATFORMS = ['Google Business Profile','Yelp','Facebook','Apple Maps','Bing Places','Yellow Pages','Foursquare','BBB','TripAdvisor','Angi','HomeAdvisor','Thumbtack','Houzz','LinkedIn','Instagram','MapQuest','Here Maps','Waze','Citysearch','Superpages','MerchantCircle','Manta','Hotfrog'];

export function hasBrightLocalKey(): boolean {
  return !!(BL_API_KEY && BL_API_KEY !== 'your_brightlocal_api_key_here');
}

export function generateManualAudit(name: string, address: string, phone: string | null) {
  const results = BRIGHTLOCAL_PLATFORMS.map(platform => ({ platform, status: 'pending' as const, nameMatch: false, addressMatch: false, phoneMatch: false }));
  const conquestTasks = BRIGHTLOCAL_PLATFORMS.map(platform => ({ platform, priority: ['Google Business Profile','Yelp','Facebook','Apple Maps','Bing Places'].includes(platform) ? 'high' : 'medium', issue: `Verify listing on ${platform}`, action: `Search "${name}" on ${platform} and ensure Name: "${name}" · Address: "${address}"${phone ? ` · Phone: "${phone}"` : ''} are identical` }));
  return { results, conquestTasks, totalPlatforms: BRIGHTLOCAL_PLATFORMS.length, matchingPlatforms: 0, issuesFound: conquestTasks.length, healthScore: 0 };
}

export async function createBrightLocalCampaign(name: string, address: string, phone: string | null, city: string | null): Promise<string> {
  if (!hasBrightLocalKey()) throw new Error('BrightLocal key not configured');
  const res = await fetch(`${BL_BASE}/ld/create`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ 'api-key': BL_API_KEY!, name, address, city: city ?? '', phone: phone ?? '', country: 'USA', format: 'json' }) });
  const data = await res.json() as any;
  if (!data.success) throw new Error('BrightLocal creation failed');
  return data['location-id'];
}

export async function fetchBrightLocalResults(campaignId: string) {
  if (!hasBrightLocalKey()) throw new Error('BrightLocal key not configured');
  const res = await fetch(`${BL_BASE}/ld/get-location`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ 'api-key': BL_API_KEY!, 'location-id': campaignId, format: 'json' }) });
  const data = await res.json() as any;
  const citations = data.citations ?? [];
  const results = citations.map((c: any) => ({ platform: c.site_name, status: c.listing_found ? (c.name_match && c.address_match ? 'found_match' : 'found_mismatch') : 'not_found', foundName: c.found_name, foundAddress: c.found_address, foundPhone: c.found_phone, nameMatch: !!c.name_match, addressMatch: !!c.address_match, phoneMatch: !!c.phone_match, listingUrl: c.listing_url }));
  const matchingPlatforms = results.filter((r: any) => r.status === 'found_match').length;
  const healthScore = results.length > 0 ? Math.round((matchingPlatforms / results.length) * 100) : 0;
  return { results, conquestTasks: [], totalPlatforms: results.length, matchingPlatforms, issuesFound: 0, healthScore };
}
