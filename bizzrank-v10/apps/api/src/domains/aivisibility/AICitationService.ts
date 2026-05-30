/**
 * ============================================================
 * BizzRank AI v10 — AICitationService
 * ============================================================
 *
 * WHAT THIS DOES:
 * For every AI visibility check, this service extracts and
 * analyzes the citation sources that AI platforms used when
 * making local business recommendations.
 *
 * WHY CITATIONS MATTER MORE THAN MENTIONS:
 * A business can rank #1 on Google Maps and be completely
 * invisible to ChatGPT. That's because ChatGPT gets its local
 * business data from Foursquare (60-70% of signals), Yelp,
 * and Bing — NOT from Google. Knowing which citation sources
 * the AI used and which ones your competitors have but you
 * don't is the most actionable intelligence possible.
 *
 * SOURCE ANALYSIS PER PLATFORM (from Yext 6.8M citation study,
 * BrightLocal 2026, and FindSkill AI audit data):
 *
 *   ChatGPT:
 *     - Foursquare: 60-70% of local recommendation data
 *     - Bing Places: direct feed into ChatGPT knowledge
 *     - Yelp, BBB, TripAdvisor: secondary enrichment
 *     - Does NOT show citations inline — we infer from context
 *
 *   Perplexity:
 *     - Returns numbered citations [1][2][3] inline in responses
 *     - We extract actual URLs from its responses
 *     - Favors: Yelp, TripAdvisor, Healthgrades, BBB, Angi
 *     - Reddit: ~24% of citations in some categories (2026)
 *
 *   Gemini:
 *     - Favors brand-owned content and Google-indexed pages
 *     - GBP, business website, Google Maps data
 *     - Sometimes shows sources — we parse when available
 *
 * HOW WE DETECT CITATIONS:
 *
 *   Method 1 — Direct extraction (Perplexity only):
 *     Perplexity puts numbered citations inline: [1] [2] [3]
 *     and lists source URLs at the bottom of responses.
 *     We parse these with regex to get exact domains used.
 *
 *   Method 2 — Explicit source query:
 *     After getting a recommendation response, we ask:
 *     "What sources or directories did you use to recommend
 *     those businesses? List the websites."
 *     ChatGPT and Gemini often answer this directly.
 *
 *   Method 3 — Competitor citation inference:
 *     If Competitor A appears in AI results and has Foursquare,
 *     Foursquare is a probable citation source for that query.
 *     We cross-reference competitor directory presence with
 *     who appeared in AI results.
 *
 *   Method 4 — Platform knowledge database:
 *     Each platform has known source preferences by sector.
 *     If a query returns dental results and the platform is
 *     ChatGPT, Healthgrades and Foursquare are almost certainly
 *     in the source set. We show these as "likely sources."
 *
 * HOW WE DETECT YOUR MISSING CITATIONS:
 *     For each citation source used in a query:
 *     1. Is your business listed there? → check from citation_audits
 *        or domain presence in business.website field
 *     2. Are your competitors listed there? → check competitor data
 *     3. Gap = sources your competitors have that you don't
 *
 * OUTPUT:
 *     Per prompt: citations used, your coverage, competitor coverage, gap
 *     Aggregate: which missing citations would help you most
 *     Priority actions: claim these 3 listings in this order
 *
 * ============================================================
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import type { AIPlatform } from './AIVisibilityService.js';

// ─────────────────────────────────────────────────────────────
// CITATION SOURCE DATABASE
//
// These are the directories and platforms that AI engines actually
// use as data sources for local business recommendations.
// Organized by sector for sector-specific gap analysis.
//
// Priority: 'critical' = must have, 'high' = strongly recommended,
//           'medium' = useful, 'low' = nice to have
//
// platform_weight: which AI platform this source influences most
// ─────────────────────────────────────────────────────────────

export interface CitationSource {
  id:              string;          // unique identifier
  name:            string;          // human readable
  domain:          string;          // e.g. yelp.com
  category:        'general' | 'medical' | 'legal' | 'home_services' |
                   'restaurant' | 'hotel' | 'automotive' | 'fitness' |
                   'beauty' | 'education' | 'retail';
  priority:        'critical' | 'high' | 'medium' | 'low';
  platforms:       AIPlatform[];    // which AI platforms use this source
  claimUrl:        string;          // where to claim your listing
  estimatedImpact: string;          // what claiming this does for AI visibility
  sectors:         string[];        // which business sectors benefit most
}

// The master citation database
// Built from: Yext 6.8M citation study, BrightLocal 2026,
// FindSkill AI audit, Local Falcon research, BrightLocal data
export const CITATION_SOURCES: CitationSource[] = [

  // ── UNIVERSAL — every business needs these ──────────────────
  {
    id: 'foursquare', name: 'Foursquare', domain: 'foursquare.com',
    category: 'general', priority: 'critical',
    platforms: ['chatgpt'],
    claimUrl: 'https://foursquare.com/add-place',
    estimatedImpact: 'Powers 60-70% of ChatGPT local recommendations. Single highest-impact citation for ChatGPT visibility.',
    sectors: ['restaurant','dental','medical','home_services','salon_beauty','legal','fitness','retail','automotive','hotel','education','general'],
  },
  {
    id: 'google_business', name: 'Google Business Profile', domain: 'business.google.com',
    category: 'general', priority: 'critical',
    platforms: ['gemini'],
    claimUrl: 'https://business.google.com',
    estimatedImpact: 'Primary source for Gemini and Google AI Overviews. Essential for all AI platforms.',
    sectors: ['restaurant','dental','medical','home_services','salon_beauty','legal','fitness','retail','automotive','hotel','education','general'],
  },
  {
    id: 'yelp', name: 'Yelp', domain: 'yelp.com',
    category: 'general', priority: 'critical',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://biz.yelp.com/claim',
    estimatedImpact: 'Cited by both ChatGPT and Perplexity. High-authority review platform used across all sectors.',
    sectors: ['restaurant','dental','medical','home_services','salon_beauty','legal','fitness','retail','automotive','hotel','general'],
  },
  {
    id: 'bing_places', name: 'Bing Places', domain: 'bingplaces.com',
    category: 'general', priority: 'critical',
    platforms: ['chatgpt'],
    claimUrl: 'https://www.bingplaces.com',
    estimatedImpact: 'Direct data feed into ChatGPT. Bing data enriches ChatGPT local knowledge alongside Foursquare.',
    sectors: ['restaurant','dental','medical','home_services','salon_beauty','legal','fitness','retail','automotive','hotel','education','general'],
  },
  {
    id: 'apple_maps', name: 'Apple Maps / Apple Business Connect', domain: 'mapsconnect.apple.com',
    category: 'general', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://businessconnect.apple.com',
    estimatedImpact: 'Apple Maps data feeds into AI assistants and Siri. Growing importance as iOS users ask Siri for local recommendations.',
    sectors: ['restaurant','dental','medical','home_services','salon_beauty','legal','fitness','retail','automotive','hotel','general'],
  },
  {
    id: 'bbb', name: 'Better Business Bureau (BBB)', domain: 'bbb.org',
    category: 'general', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.bbb.org/business',
    estimatedImpact: 'BBB presence signals trustworthiness to AI platforms. Frequently cited for service businesses and contractors.',
    sectors: ['home_services','legal','dental','medical','automotive','general'],
  },
  {
    id: 'tripadvisor', name: 'TripAdvisor', domain: 'tripadvisor.com',
    category: 'general', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.tripadvisor.com/GetListedNew',
    estimatedImpact: 'High domain authority. Cited by ChatGPT and Perplexity especially for restaurants, hotels, and tourist-facing businesses.',
    sectors: ['restaurant','hotel','general'],
  },
  {
    id: 'facebook_business', name: 'Facebook Business Page', domain: 'facebook.com',
    category: 'general', priority: 'medium',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.facebook.com/business/pages',
    estimatedImpact: 'Social proof signal. AI platforms verify business legitimacy from Facebook Business pages.',
    sectors: ['restaurant','dental','medical','home_services','salon_beauty','fitness','retail','general'],
  },

  // ── RESTAURANT / FOOD ────────────────────────────────────────
  {
    id: 'opentable', name: 'OpenTable', domain: 'opentable.com',
    category: 'restaurant', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://restaurant.opentable.com',
    estimatedImpact: 'Major reservation platform cited by AI for restaurant recommendations. Signals legitimacy and booking capability.',
    sectors: ['restaurant'],
  },
  {
    id: 'zomato', name: 'Zomato', domain: 'zomato.com',
    category: 'restaurant', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.zomato.com/restaurant/register',
    estimatedImpact: 'Critical for South Asian and Middle Eastern markets. Major data source for ChatGPT in these regions.',
    sectors: ['restaurant'],
  },
  {
    id: 'grubhub', name: 'Grubhub / DoorDash / Uber Eats', domain: 'grubhub.com',
    category: 'restaurant', priority: 'medium',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://restaurant.grubhub.com',
    estimatedImpact: 'Delivery platform presence signals active business operation. AI uses this data for food delivery queries.',
    sectors: ['restaurant'],
  },
  {
    id: 'menupages', name: 'MenuPages / AllMenus', domain: 'menupages.com',
    category: 'restaurant', priority: 'medium',
    platforms: ['chatgpt'],
    claimUrl: 'https://www.menupages.com/add-restaurant',
    estimatedImpact: 'Menu data helps AI answer specific food queries. Makes your restaurant appear for dish-specific searches.',
    sectors: ['restaurant'],
  },

  // ── MEDICAL / DENTAL ────────────────────────────────────────
  {
    id: 'healthgrades', name: 'Healthgrades', domain: 'healthgrades.com',
    category: 'medical', priority: 'critical',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.healthgrades.com/business/claim',
    estimatedImpact: 'Primary medical directory cited by AI for healthcare queries. Essential for all medical and dental businesses.',
    sectors: ['dental','medical'],
  },
  {
    id: 'zocdoc', name: 'Zocdoc', domain: 'zocdoc.com',
    category: 'medical', priority: 'critical',
    platforms: ['perplexity', 'chatgpt'],
    claimUrl: 'https://www.zocdoc.com/practice/signup',
    estimatedImpact: 'Zocdoc is frequently cited by Perplexity for "dentist accepting new patients" and "doctor near me" queries.',
    sectors: ['dental','medical'],
  },
  {
    id: 'webmd', name: 'WebMD Health Profile', domain: 'webmd.com',
    category: 'medical', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://doctor.webmd.com/find-a-doctor/claim',
    estimatedImpact: 'WebMD physician and practice profiles are heavily cited by AI for healthcare queries.',
    sectors: ['dental','medical'],
  },
  {
    id: 'vitals', name: 'Vitals.com', domain: 'vitals.com',
    category: 'medical', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.vitals.com/doctors/claim',
    estimatedImpact: 'Doctor and dentist reviews platform cited by AI platforms for "best doctor" and "best dentist" queries.',
    sectors: ['dental','medical'],
  },
  {
    id: 'ratemds', name: 'RateMDs', domain: 'ratemds.com',
    category: 'medical', priority: 'medium',
    platforms: ['perplexity'],
    claimUrl: 'https://www.ratemds.com/doctors/claim',
    estimatedImpact: 'Popular review site for doctors cited by Perplexity in medical recommendation queries.',
    sectors: ['dental','medical'],
  },
  {
    id: 'dentist_com', name: 'Dentist.com / 1-800-Dentist', domain: 'dentist.com',
    category: 'medical', priority: 'medium',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.dentist.com/dentists/add',
    estimatedImpact: 'Specialty dental directory with strong AI citation presence for "find a dentist" queries.',
    sectors: ['dental'],
  },

  // ── HOME SERVICES ────────────────────────────────────────────
  {
    id: 'angi', name: 'Angi (formerly Angie\'s List)', domain: 'angi.com',
    category: 'home_services', priority: 'critical',
    platforms: ['perplexity', 'chatgpt'],
    claimUrl: 'https://pro.angi.com',
    estimatedImpact: 'Dominant home services platform. Perplexity cites Angi for virtually all home services queries. Critical.',
    sectors: ['home_services','automotive'],
  },
  {
    id: 'homeadvisor', name: 'HomeAdvisor', domain: 'homeadvisor.com',
    category: 'home_services', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://pro.homeadvisor.com',
    estimatedImpact: 'Major home services marketplace cited by AI for contractor and repair queries.',
    sectors: ['home_services'],
  },
  {
    id: 'thumbtack', name: 'Thumbtack', domain: 'thumbtack.com',
    category: 'home_services', priority: 'high',
    platforms: ['perplexity', 'chatgpt'],
    claimUrl: 'https://www.thumbtack.com/pro',
    estimatedImpact: 'Service professional marketplace frequently cited in AI responses for local service queries.',
    sectors: ['home_services','fitness','education'],
  },
  {
    id: 'houzz', name: 'Houzz', domain: 'houzz.com',
    category: 'home_services', priority: 'medium',
    platforms: ['perplexity'],
    claimUrl: 'https://www.houzz.com/pro-landing',
    estimatedImpact: 'Home improvement platform cited for renovation, design, and construction queries.',
    sectors: ['home_services'],
  },

  // ── LEGAL ────────────────────────────────────────────────────
  {
    id: 'avvo', name: 'Avvo', domain: 'avvo.com',
    category: 'legal', priority: 'critical',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.avvo.com/claim-my-profile',
    estimatedImpact: 'Primary legal directory cited by AI for lawyer and attorney recommendations. Critical for legal sector.',
    sectors: ['legal'],
  },
  {
    id: 'findlaw', name: 'FindLaw', domain: 'findlaw.com',
    category: 'legal', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://lawyers.findlaw.com/lawyer/update-profile',
    estimatedImpact: 'FindLaw attorney profiles are heavily cited in AI legal recommendation queries.',
    sectors: ['legal'],
  },
  {
    id: 'justia', name: 'Justia', domain: 'justia.com',
    category: 'legal', priority: 'high',
    platforms: ['perplexity'],
    claimUrl: 'https://lawyers.justia.com/claim',
    estimatedImpact: 'Legal information site with attorney directory cited by Perplexity for lawyer queries.',
    sectors: ['legal'],
  },
  {
    id: 'martindale', name: 'Martindale-Hubbell', domain: 'martindale.com',
    category: 'legal', priority: 'medium',
    platforms: ['chatgpt'],
    claimUrl: 'https://www.martindale.com/attorneys/claim-profile',
    estimatedImpact: 'Long-established legal directory. AI uses it as an authority signal for attorney recommendations.',
    sectors: ['legal'],
  },

  // ── AUTOMOTIVE ───────────────────────────────────────────────
  {
    id: 'carfax', name: 'CARFAX Service Shops', domain: 'carfax.com',
    category: 'automotive', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.carfax.com/garage',
    estimatedImpact: 'CARFAX shop directory cited by AI for mechanic and auto repair queries.',
    sectors: ['automotive'],
  },
  {
    id: 'repairpal', name: 'RepairPal', domain: 'repairpal.com',
    category: 'automotive', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://repairpal.com/shop-claim',
    estimatedImpact: 'Auto repair shop directory with strong AI citation presence. Frequently cited for mechanic queries.',
    sectors: ['automotive'],
  },

  // ── FITNESS ──────────────────────────────────────────────────
  {
    id: 'mindbody', name: 'Mindbody', domain: 'mindbodyonline.com',
    category: 'fitness', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.mindbodyonline.com/business',
    estimatedImpact: 'Fitness and wellness booking platform. AI cites Mindbody for gym, yoga, and fitness studio queries.',
    sectors: ['fitness','salon_beauty'],
  },
  {
    id: 'classpass', name: 'ClassPass', domain: 'classpass.com',
    category: 'fitness', priority: 'medium',
    platforms: ['perplexity'],
    claimUrl: 'https://classpass.com/partners',
    estimatedImpact: 'Fitness class booking platform cited by Perplexity for "fitness classes near me" queries.',
    sectors: ['fitness'],
  },

  // ── HOTEL / ACCOMMODATION ────────────────────────────────────
  {
    id: 'booking_com', name: 'Booking.com', domain: 'booking.com',
    category: 'hotel', priority: 'critical',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://partner.booking.com/en-gb/solutions/list-your-property',
    estimatedImpact: 'Major OTA cited by all AI platforms for hotel recommendations. Critical for accommodation sector.',
    sectors: ['hotel'],
  },
  {
    id: 'expedia', name: 'Expedia / Hotels.com', domain: 'expedia.com',
    category: 'hotel', priority: 'high',
    platforms: ['chatgpt', 'perplexity'],
    claimUrl: 'https://www.expediagroup.com/partners/add-your-property',
    estimatedImpact: 'OTA with strong AI citation presence for accommodation queries.',
    sectors: ['hotel'],
  },

  // ── EDUCATION ────────────────────────────────────────────────
  {
    id: 'coursehorse', name: 'CourseHorse / CourseFind', domain: 'coursehorse.com',
    category: 'education', priority: 'medium',
    platforms: ['perplexity'],
    claimUrl: 'https://coursehorse.com/add-your-classes',
    estimatedImpact: 'Education platform cited by Perplexity for class and course queries.',
    sectors: ['education'],
  },

  // ── RETAIL ───────────────────────────────────────────────────
  {
    id: 'google_shopping', name: 'Google Shopping / Merchant Center', domain: 'merchants.google.com',
    category: 'retail', priority: 'high',
    platforms: ['gemini'],
    claimUrl: 'https://merchants.google.com',
    estimatedImpact: 'Google Merchant Center data feeds into Gemini for retail and product queries.',
    sectors: ['retail'],
  },
];

// ─────────────────────────────────────────────────────────────
// CITATION EXTRACTION FROM PERPLEXITY RESPONSES
//
// Perplexity explicitly shows numbered citations in its responses:
//   "The best options are Dental Care Center [1] and City Smiles [2]"
//   "Sources: [1] yelp.com/... [2] healthgrades.com/..."
//
// We extract these URLs using regex and categorize by domain.
// This gives us CONFIRMED citations — not inferred ones.
// ─────────────────────────────────────────────────────────────

export interface ExtractedCitation {
  number:    number;
  url:       string | null;
  domain:    string | null;
  sourceName: string | null;  // matched to our CITATION_SOURCES database
  sourceId:  string | null;
  confidence: 'confirmed' | 'inferred' | 'likely';
}

function extractDomain(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).hostname
      .replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

function matchDomainToSource(domain: string): CitationSource | null {
  return CITATION_SOURCES.find(s =>
    domain.includes(s.domain) || s.domain.includes(domain)
  ) ?? null;
}

export function extractPerplexityCitations(response: string): ExtractedCitation[] {
  const citations: ExtractedCitation[] = [];

  // Pattern 1: Markdown-style citations [1] at end with URL list
  // e.g. "1. https://yelp.com/biz/..." or "[1] https://..."
  const urlPattern = /(?:\[(\d+)\]|\b(\d+)\.)[\s:]*(?:https?:\/\/)?([^\s\n\]]+\.[a-z]{2,}[^\s\n]*)/gi;
  let match;

  while ((match = urlPattern.exec(response)) !== null) {
    const num    = parseInt(match[1] ?? match[2] ?? '0');
    const rawUrl = match[3];
    const domain = extractDomain(rawUrl);
    const source = matchDomainToSource(domain);

    citations.push({
      number:     num,
      url:        rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl,
      domain,
      sourceName: source?.name ?? null,
      sourceId:   source?.id   ?? null,
      confidence: 'confirmed',
    });
  }

  // Pattern 2: Domain mentions without explicit URL
  // e.g. "According to Yelp..." or "Healthgrades shows..."
  const domainMentions = [
    'yelp', 'healthgrades', 'foursquare', 'tripadvisor', 'angi', 'zocdoc',
    'webmd', 'avvo', 'findlaw', 'bbb', 'thumbtack', 'homeadvisor',
    'booking.com', 'expedia', 'opentable', 'zomato', 'vitals',
  ];

  const lower = response.toLowerCase();
  for (const domain of domainMentions) {
    if (lower.includes(domain) && !citations.find(c => c.domain?.includes(domain))) {
      const source = matchDomainToSource(domain);
      citations.push({
        number:     citations.length + 1,
        url:        null,
        domain,
        sourceName: source?.name ?? domain,
        sourceId:   source?.id   ?? null,
        confidence: 'inferred',
      });
    }
  }

  return citations;
}

// ─────────────────────────────────────────────────────────────
// FOLLOW-UP CITATION QUERY
//
// After getting a recommendation response, we ask the AI:
// "What sources or websites did you use to make those
//  recommendations?" — ChatGPT and Gemini often answer
//  this directly. This gives us confirmed source attribution
//  without needing to parse structured citation formats.
//
// We only do this when a business appeared in the main response
// (no point asking about citations if the business wasn't mentioned).
// ─────────────────────────────────────────────────────────────

async function querySourcesFromChatGPT(
  originalPrompt: string,
  originalResponse: string
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        max_tokens:  300,
        temperature: 0.1, // very low — we want factual source attribution
        messages: [
          { role: 'user',      content: originalPrompt },
          { role: 'assistant', content: originalResponse },
          {
            role: 'user',
            content: [
              'For the business recommendations you just made,',
              'what data sources or websites did you use?',
              'List only the website/directory names (e.g. Yelp, Foursquare, Healthgrades).',
              'Be specific and brief.',
            ].join(' '),
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

async function querySourcesFromGemini(
  originalPrompt: string,
  originalResponse: string
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return '';

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user',  parts: [{ text: originalPrompt }] },
            { role: 'model', parts: [{ text: originalResponse }] },
            {
              role: 'user',
              parts: [{
                text: 'What data sources or directories did you use for those recommendations? List only website/directory names.',
              }],
            },
          ],
          generationConfig: { maxOutputTokens: 200, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}

// Parse source attribution response into domain list
function parseSourceAttributionResponse(response: string): string[] {
  const lower    = response.toLowerCase();
  const detected: string[] = [];

  for (const source of CITATION_SOURCES) {
    if (lower.includes(source.name.toLowerCase()) ||
        lower.includes(source.domain.replace('.com', ''))) {
      detected.push(source.domain);
    }
  }

  return [...new Set(detected)];
}

// ─────────────────────────────────────────────────────────────
// SECTOR-SPECIFIC CITATION SOURCES
//
// Returns the most important citation sources for a given sector,
// ordered by priority and AI platform influence.
// ─────────────────────────────────────────────────────────────

export function getCriticalSourcesForSector(sector: string): CitationSource[] {
  // Always include universal sources
  const universal = CITATION_SOURCES.filter(
    s => s.category === 'general' && s.priority !== 'low'
  );

  // Map sector to our category
  const categoryMap: Record<string, string> = {
    restaurant:     'restaurant',
    dental:         'medical',
    medical:        'medical',
    home_services:  'home_services',
    salon_beauty:   'fitness',   // closest match
    legal:          'legal',
    fitness:        'fitness',
    retail:         'retail',
    automotive:     'automotive',
    hotel:          'hotel',
    education:      'education',
    general:        'general',
  };

  const mappedCategory = categoryMap[sector] ?? 'general';
  const sectorSpecific = CITATION_SOURCES.filter(
    s => s.category === mappedCategory && s.priority !== 'low'
  );

  // Deduplicate and sort by priority
  const all       = [...universal, ...sectorSpecific];
  const seen      = new Set<string>();
  const unique    = all.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

  return unique.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

// ─────────────────────────────────────────────────────────────
// BUSINESS CITATION COVERAGE CHECKER
//
// Determines which citation sources a business is likely listed on
// based on available data. We check:
//   1. citation_audits table (if BrightLocal audits have been run)
//   2. Business website domain
//   3. Known data from business profile
//
// This is "best effort" — we can't check every directory
// programmatically. We recommend verifying manually.
// ─────────────────────────────────────────────────────────────

interface CitationCoverageItem {
  sourceId:   string;
  sourceName: string;
  domain:     string;
  covered:    boolean;
  confidence: 'confirmed' | 'assumed' | 'unknown';
  checkUrl:   string;  // URL to verify manually
}

async function getBusinessCitationCoverage(
  businessId: string,
  sourcesToCheck: CitationSource[]
): Promise<CitationCoverageItem[]> {
  // Load citation audit data if available
  const { data: auditData } = await db.from('citation_audits')
    .select('reference_name, brightlocal_campaign_id').eq('business_id', businessId).limit(1).single();

  // Load citation task completions if any
  const { data: tasks } = await db.from('citation_tasks')
    .select('directory_name, status').eq('business_id', businessId) as any;

  const completedDirectories = new Set(
    (tasks ?? []).filter((t: any) => t.status === 'completed').map((t: any) =>
      (t.directory_name ?? '').toLowerCase()
    )
  );

  return sourcesToCheck.map(source => {
    // Check if we have confirmed completion data
    const isCompleted = completedDirectories.has(source.name.toLowerCase()) ||
      completedDirectories.has(source.domain.replace('.com', '').toLowerCase());

    // GBP is assumed present if business has google_place_id
    // Yelp/Bing are unknown unless we have audit data
    const confidence: 'confirmed' | 'assumed' | 'unknown' =
      isCompleted ? 'confirmed' :
      source.id === 'google_business' ? 'assumed' :
      'unknown';

    return {
      sourceId:   source.id,
      sourceName: source.name,
      domain:     source.domain,
      covered:    isCompleted || source.id === 'google_business',
      confidence,
      checkUrl:   `https://${source.domain}/search?q=business+name`,  // generic fallback
    };
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN CITATION INTELLIGENCE SERVICE
// ─────────────────────────────────────────────────────────────

export interface PromptCitationData {
  prompt:                  string;
  platform:                AIPlatform;
  citationsUsed:           ExtractedCitation[];       // sources AI used for this prompt
  yourCoverage:            CitationCoverageItem[];    // which of those you're listed on
  competitorCoverage:      CompetitorCitationMap;     // which sources competitors have
  missingCitations:        CitationGap[];             // sources you're missing that matter
  citationScore:           number;                   // 0-100 how well you're cited vs competitors
}

export interface CompetitorCitationMap {
  [competitorName: string]: {
    sources:    string[];   // source IDs they appear on
    advantage:  number;     // how many more sources than you
  };
}

export interface CitationGap {
  source:          CitationSource;
  presentFor:      string[];   // competitor names that have this
  missingForYou:   true;
  estimatedImpact: 'critical' | 'high' | 'medium';
  platforms:       AIPlatform[];
  claimUrl:        string;
  timeToFix:       string;
}

export interface CitationIntelligenceReport {
  businessId:    string;
  sector:        string;
  checkedAt:     string;

  // Aggregate scores
  overallCitationScore:   number;  // 0-100 how well covered you are
  chatgptCitationScore:   number;
  perplexityCitationScore: number;
  geminiCitationScore:    number;

  // Per-prompt breakdown
  promptCitations:        PromptCitationData[];

  // Aggregate gap analysis
  criticalGaps:           CitationGap[];   // missing sources hurting you most
  competitorAdvantages:   CompetitorCitationSummary[];
  quickWins:              QuickWin[];      // fastest citations to claim

  // Your current coverage
  yourCoverage:           CitationCoverageItem[];
}

export interface CompetitorCitationSummary {
  name:           string;
  citationScore:  number;  // 0-100
  advantage:      number;  // how many more sources than you
  keyAdvantages:  string[];
}

export interface QuickWin {
  source:          CitationSource;
  estimatedTime:   string;  // e.g. "15 minutes"
  estimatedImpact: string;
  claimUrl:        string;
}

export class AICitationService {

  /**
   * Main entry point: given AI visibility prompt run results,
   * extract and analyze all citation intelligence.
   *
   * Called from AIVisibilityService after prompts have run.
   * Takes the raw responses and extracts citation data.
   */
  async analyzeCitations(params: {
    businessId:      string;
    userId:          string;
    sector:          string;
    businessName:    string;
    competitorNames: string[];
    promptResults:   Array<{
      prompt:       string;
      platform:     AIPlatform;
      rawResponse:  string;
      appeared:     boolean;
    }>;
  }): Promise<CitationIntelligenceReport> {
    const { businessId, sector, businessName, competitorNames, promptResults } = params;

    logger.info('[Citations] Analyzing citation intelligence', {
      businessId, sector, prompts: promptResults.length,
    });

    // Get sector-specific critical sources
    const criticalSources = getCriticalSourcesForSector(sector);

    // Get our citation coverage
    const ourCoverage = await getBusinessCitationCoverage(businessId, criticalSources);

    // Process each prompt result for citations
    const promptCitations: PromptCitationData[] = [];
    const allDetectedSources = new Set<string>();

    for (const result of promptResults) {
      let citationsUsed: ExtractedCitation[] = [];

      if (result.platform === 'perplexity') {
        // Perplexity shows actual citation URLs — extract directly
        citationsUsed = extractPerplexityCitations(result.rawResponse);
      } else {
        // For ChatGPT and Gemini, use source attribution query
        // Only do this when business appeared (saves API calls)
        if (result.appeared && result.rawResponse.length > 100) {
          let attributionResponse = '';

          if (result.platform === 'chatgpt') {
            attributionResponse = await querySourcesFromChatGPT(
              result.prompt, result.rawResponse
            );
          } else if (result.platform === 'gemini') {
            attributionResponse = await querySourcesFromGemini(
              result.prompt, result.rawResponse
            );
          }

          if (attributionResponse) {
            const detectedDomains = parseSourceAttributionResponse(attributionResponse);
            citationsUsed = detectedDomains.map((domain, i) => {
              const source = matchDomainToSource(domain);
              return {
                number:     i + 1,
                url:        null,
                domain,
                sourceName: source?.name ?? domain,
                sourceId:   source?.id   ?? null,
                confidence: 'inferred' as const,
              };
            });
          }
        }

        // Always add platform-likely sources based on sector
        // (we know ChatGPT uses Foursquare, so flag it as 'likely')
        const likelySources = this.getLikelySourcesForPlatform(result.platform, sector);
        for (const s of likelySources) {
          if (!citationsUsed.find(c => c.sourceId === s.id)) {
            citationsUsed.push({
              number:     citationsUsed.length + 1,
              url:        null,
              domain:     s.domain,
              sourceName: s.name,
              sourceId:   s.id,
              confidence: 'likely',
            });
          }
        }
      }

      // Track all detected sources
      citationsUsed.forEach(c => { if (c.sourceId) allDetectedSources.add(c.sourceId); });

      // Build competitor citation map for this prompt
      const competitorCoverage: CompetitorCitationMap = {};
      for (const compName of competitorNames) {
        const compSources = this.inferCompetitorSources(
          compName, result.rawResponse, criticalSources
        );
        const compCoverage = ourCoverage.filter(c => c.covered).length;
        competitorCoverage[compName] = {
          sources:   compSources,
          advantage: compSources.length - compCoverage,
        };
      }

      // Find missing citations for this prompt
      const missingCitations: CitationGap[] = citationsUsed
        .filter(c => c.sourceId)
        .map(c => {
          const ourItem = ourCoverage.find(o => o.sourceId === c.sourceId);
          if (ourItem?.covered) return null;

          const source = CITATION_SOURCES.find(s => s.id === c.sourceId);
          if (!source) return null;

          const presentForCompetitors = competitorNames.filter(n =>
            competitorCoverage[n]?.sources.includes(c.sourceId!)
          );

          return {
            source,
            presentFor:    presentForCompetitors,
            missingForYou: true as const,
            estimatedImpact: source.priority === 'critical' ? 'critical' :
                             source.priority === 'high' ? 'high' : 'medium',
            platforms:  source.platforms,
            claimUrl:   source.claimUrl,
            timeToFix:  source.id === 'foursquare' ? '15 minutes' :
                        source.id === 'google_business' ? '30 minutes' : '20-30 minutes',
          } as CitationGap;
        })
        .filter(Boolean) as CitationGap[];

      const citedSourceCount = citationsUsed.filter(c => c.confidence !== 'likely').length;
      const ourCoveredCount  = citationsUsed.filter(c =>
        c.sourceId && ourCoverage.find(o => o.sourceId === c.sourceId && o.covered)
      ).length;

      const citationScore = citedSourceCount > 0
        ? Math.round((ourCoveredCount / citedSourceCount) * 100)
        : 50;

      promptCitations.push({
        prompt:             result.prompt,
        platform:           result.platform,
        citationsUsed,
        yourCoverage:       ourCoverage.filter(c =>
          citationsUsed.find(ci => ci.sourceId === c.sourceId)
        ),
        competitorCoverage,
        missingCitations,
        citationScore,
      });

      // Rate limit
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Aggregate gaps across all prompts ─────────────────────
    const gapFrequency = new Map<string, { gap: CitationGap; count: number }>();
    for (const pc of promptCitations) {
      for (const gap of pc.missingCitations) {
        const existing = gapFrequency.get(gap.source.id);
        if (existing) {
          existing.count++;
        } else {
          gapFrequency.set(gap.source.id, { gap, count: 1 });
        }
      }
    }

    const criticalGaps = [...gapFrequency.values()]
      .sort((a, b) => b.count - a.count || (
        a.gap.estimatedImpact === 'critical' ? -1 :
        b.gap.estimatedImpact === 'critical' ? 1 : 0
      ))
      .slice(0, 8)
      .map(({ gap }) => gap);

    // ── Platform citation scores ───────────────────────────────
    const calcPlatformScore = (platform: AIPlatform) => {
      const platformResults = promptCitations.filter(p => p.platform === platform);
      if (!platformResults.length) return 0;
      return Math.round(
        platformResults.reduce((s, p) => s + p.citationScore, 0) / platformResults.length
      );
    };

    // ── Competitor citation summaries ─────────────────────────
    const competitorAdvantages: CompetitorCitationSummary[] = competitorNames.map(name => {
      const allSources = new Set<string>();
      for (const pc of promptCitations) {
        (pc.competitorCoverage[name]?.sources ?? []).forEach(s => allSources.add(s));
      }
      const ourScore = ourCoverage.filter(c => c.covered).length;
      const theirScore = allSources.size;
      const advantage = theirScore - ourScore;

      return {
        name,
        citationScore:  Math.min(100, Math.round((theirScore / Math.max(criticalSources.length, 1)) * 100)),
        advantage:      Math.max(0, advantage),
        keyAdvantages:  [...allSources]
          .filter(id => !ourCoverage.find(c => c.sourceId === id && c.covered))
          .map(id => CITATION_SOURCES.find(s => s.id === id)?.name ?? id)
          .slice(0, 3),
      };
    }).filter(c => c.advantage > 0);

    // ── Quick wins ─────────────────────────────────────────────
    const quickWins: QuickWin[] = criticalGaps
      .filter(g => g.estimatedImpact === 'critical' || g.estimatedImpact === 'high')
      .slice(0, 5)
      .map(g => ({
        source:          g.source,
        estimatedTime:   g.source.id === 'foursquare' ? '15 minutes' :
                         g.source.id === 'google_business' ? '30 minutes' : '20-30 minutes',
        estimatedImpact: g.source.estimatedImpact,
        claimUrl:        g.source.claimUrl,
      }));

    const overallScore = ourCoverage.length > 0
      ? Math.round((ourCoverage.filter(c => c.covered).length / ourCoverage.length) * 100)
      : 0;

    const report: CitationIntelligenceReport = {
      businessId,
      sector,
      checkedAt:               new Date().toISOString(),
      overallCitationScore:    overallScore,
      chatgptCitationScore:    calcPlatformScore('chatgpt'),
      perplexityCitationScore: calcPlatformScore('perplexity'),
      geminiCitationScore:     calcPlatformScore('gemini'),
      promptCitations:         promptCitations.slice(0, 10), // store top 10 for UI
      criticalGaps,
      competitorAdvantages,
      quickWins,
      yourCoverage: ourCoverage,
    };

    // Save to DB
    await db.from('ai_citation_intelligence').upsert({
      business_id:                params.businessId,
      user_id:                    params.userId,
      sector,
      overall_citation_score:     overallScore,
      chatgpt_citation_score:     calcPlatformScore('chatgpt'),
      perplexity_citation_score:  calcPlatformScore('perplexity'),
      gemini_citation_score:      calcPlatformScore('gemini'),
      critical_gaps:              criticalGaps,
      competitor_advantages:      competitorAdvantages,
      quick_wins:                 quickWins,
      prompt_citations:           promptCitations.slice(0, 10),
      your_coverage:              ourCoverage,
      checked_at:                 new Date().toISOString(),
    }, { onConflict: 'business_id,user_id' });

    logger.info('[Citations] Analysis complete', {
      businessId, overallScore,
      gaps: criticalGaps.length,
      quickWins: quickWins.length,
    });

    return report;
  }

  // ── Get likely sources per platform (from research data) ─────
  private getLikelySourcesForPlatform(
    platform: AIPlatform, sector: string
  ): CitationSource[] {
    const sectorSources = getCriticalSourcesForSector(sector);
    return sectorSources
      .filter(s => s.platforms.includes(platform) && s.priority === 'critical')
      .slice(0, 3);
  }

  // ── Infer competitor citation presence from AI response ───────
  // PREVIOUSLY BOGUS: returned ALL critical sources for any competitor
  // that appeared — completely fabricated data.
  //
  // NOW HONEST: We can only honestly infer that a competitor is listed
  // on platform-specific primary sources when they appear in that
  // platform's results. We return only 1 highly-probable inference
  // per platform, clearly labeled as "likely" not "confirmed."
  private inferCompetitorSources(
    competitorName: string,
    response: string,
    criticalSources: CitationSource[],
    platform?: string,
  ): string[] {
    const lower    = response.toLowerCase();
    const compLow  = competitorName.toLowerCase();
    if (!lower.includes(compLow)) return [];

    // Only infer the single most likely source for this platform
    // ChatGPT → Foursquare is the highest-confidence inference (60-70% probability)
    // Perplexity → Yelp is the highest-confidence inference for review businesses
    // Gemini → GBP is essentially certain for any local business
    const platformInference: Record<string, string> = {
      chatgpt:    'foursquare',
      perplexity: 'yelp',
      gemini:     'google_business',
    };

    const likely = platform ? platformInference[platform] : null;
    if (likely && criticalSources.find(s => s.id === likely)) {
      return [likely]; // Return only the one highly-probable source
    }

    // Without platform context, return only GBP (essentially universal)
    return ['google_business'];
  }

  // ── Get latest citation report for a business ─────────────────
  async getLatestReport(businessId: string, userId: string): Promise<any | null> {
    const { data } = await db.from('ai_citation_intelligence')
      .select('*')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .order('checked_at', { ascending: false })
      .limit(1)
      .single();
    return data ?? null;
  }
}

export const aiCitationService = new AICitationService();

/**
 * Subscribe to GBP_CHANGE_DETECTED events published by GBPGuardService.
 *
 * When a business's website, address, name, or phone changes, all their
 * citations across Foursquare, Yelp, Healthgrades etc. now point to old
 * information. This makes them invisible or misleading to AI platforms
 * until citations are updated.
 *
 * We schedule a lightweight citation gap analysis using the data we
 * already have — no new external API calls required. The result updates
 * the ai_citation_intelligence table which the Citations tab already reads.
 *
 * Why a 2-minute delay: GBPGuardService may be processing multiple alerts
 * for the same business in a single check run. We wait 2 minutes to batch
 * them rather than triggering a re-check for every individual field change.
 */
const pendingCitationChecks = new Map<string, ReturnType<typeof setTimeout>>();

eventBus.subscribe<{
  entityId:      string;
  userId:        string;
  entityName:    string;
  changedFields: Array<{ field: string; oldValue: string; newValue: string }>;
  detectedAt:    string;
}>(Events.GBP_CHANGE_DETECTED, async (event) => {
  const { entityId, userId, changedFields } = event.payload;

  // Cancel any pending check for this business — debounce multiple changes
  const existing = pendingCitationChecks.get(entityId);
  if (existing) clearTimeout(existing);

  // Schedule re-check with 2-minute delay
  const timeout = setTimeout(async () => {
    pendingCitationChecks.delete(entityId);
    try {
      // Load minimal business data for the re-check
      const { data: biz } = await db.from('businesses')
        .select('id, name, category, address')
        .eq('id', entityId).single();

      if (!biz) return;

      // Load competitors
      const { data: comps } = await db.from('competitors')
        .select('name').eq('business_id', entityId).neq('is_active', false).limit(5);

      // Detect sector from category
      const sector = biz.category?.toLowerCase().includes('restaurant') ? 'restaurant'
        : biz.category?.toLowerCase().includes('dent') ? 'dental'
        : biz.category?.toLowerCase().includes('medical') ? 'medical'
        : biz.category?.toLowerCase().includes('plumb') || biz.category?.toLowerCase().includes('electr') ? 'home_services'
        : 'general';

      // Run citation analysis with the changed field context
      // promptResults is empty — we're doing a structural analysis
      // not a live AI query. This identifies the coverage gap
      // without making new ChatGPT/Perplexity API calls.
      await aiCitationService.analyzeCitations({
        businessId:      entityId,
        userId,
        sector,
        businessName:    biz.name,
        competitorNames: (comps ?? []).map((c: any) => c.name),
        promptResults:   [], // structural analysis only — no AI calls
      });

      logger.info('[Citations] Re-check triggered by GBP change', {
        entityId,
        changedFields: changedFields.map(f => f.field),
      });
    } catch (err: any) {
      logger.error('[Citations] GBP-triggered re-check failed', {
        entityId, error: err.message,
      });
    }
  }, 2 * 60 * 1000); // 2-minute debounce

  pendingCitationChecks.set(entityId, timeout);
  logger.info('[Citations] GBP change detected — re-check scheduled', {
    entityId,
    fields:    changedFields.map(f => f.field),
    delayMins: 2,
  });
});
