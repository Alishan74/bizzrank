/**
 * ============================================================
 * BizzRank AI v10 — AIVisibilityService (World-Class Edition)
 * ============================================================
 *
 * PHILOSOPHY:
 * Most AI visibility tools ask "does your business name appear in a
 * ChatGPT response?" That is a necessary but deeply insufficient measure.
 * A business can appear and be described negatively. A business can appear
 * at position #5 when the customer only reads the first two. A business
 * can appear for brand queries (trivial) but not for discovery queries
 * (the ones that drive new customers). A business can score 80% this week
 * and 20% next week because AI responses vary — and averaging the two
 * gives you 50%, which is meaningless.
 *
 * This system measures what actually matters:
 *
 *   1. DISCOVERY VISIBILITY — does AI recommend you to strangers?
 *      (not just: does AI know you exist)
 *
 *   2. SENTIMENT — when AI mentions you, is it positive or negative?
 *
 *   3. POSITION — are you the first recommendation or buried at #4?
 *
 *   4. RELIABILITY — do you appear consistently across multiple runs?
 *      (single-run scores are noise, not signal)
 *
 *   5. ZONE AWARENESS — do you appear when users ask from YOUR zones?
 *      (city-level is too broad, zone-level is what drives foot traffic)
 *
 *   6. PLATFORM GAPS — which AI platform is failing you, and why?
 *      (each platform has different data sources — fixes are specific)
 *
 *   7. COMPETITOR GAP — why is your competitor appearing and you are not?
 *      (the most actionable intelligence possible)
 *
 *   8. ROOT CAUSE — using your existing GBP/review/citation data,
 *      tell the customer exactly what to fix — not generic advice
 *
 * COST MODEL:
 *   ChatGPT (gpt-4o-mini):   $0.001 per prompt
 *   Perplexity (sonar-small): $0.001 per prompt
 *   Gemini (1.5-flash):       ~$0.0005 per prompt (already configured)
 *
 *   Per business per week (3 runs × 7 prompts × 3 platforms):
 *   = 63 API calls × avg $0.001 = $0.063/business/week
 *   Agency (5 businesses) = $0.32/week = $1.26/month — negligible
 *
 * WHY 3 RUNS PER PROMPT:
 *   AI responses are non-deterministic. A single run at temperature 0.7
 *   tells you what happened once. Three runs tell you how reliably you
 *   appear. A business appearing in 3/3 runs is far more visible than
 *   one appearing in 1/3 runs — but both score "appeared" in current tools.
 *   We score appearance rate: 3/3=100%, 2/3=67%, 1/3=33%, 0/3=0%.
 *
 * WHY SECTOR-SPECIFIC PROMPTS:
 *   A dentist's patients ask "dentist accepting new patients near me" —
 *   not "best dentist in city." A plumber's customers ask "emergency
 *   plumber available tonight" — urgency is the dominant intent signal.
 *   Generic prompts miss the queries that actually drive conversions.
 *   We detect sector from category and generate prompts that match
 *   real customer language for that specific business type.
 *
 * WHY GEMINI-GENERATED CUSTOM PROMPTS:
 *   No hardcoded library can anticipate every business type and location.
 *   We use Gemini to generate 10 custom prompts per business based on
 *   their actual keywords, location, category, and recent review themes.
 *   These prompts reflect how real customers in that specific area ask
 *   about that specific type of business. They are regenerated monthly
 *   so they evolve with the business and its market.
 *
 * WHY FUZZY MATCHING:
 *   "Tony's Pizza" will not match "Tony Pizza", "Tony's Pizzeria",
 *   "Tony's", or "Tony's place." Exact matching produces false negatives
 *   that undercount visibility by an estimated 20-35%. We use a combination
 *   of: exact match, normalized match (remove apostrophes/punctuation),
 *   partial match (first word + last word), abbreviation match, and
 *   Levenshtein distance for near-matches. Any match scores the prompt.
 *
 * WHY INTENT WEIGHTING:
 *   Discovery prompts (stranger searches → finds your business):
 *     weight = 3.0 — this is how new customers find you
 *   Comparison prompts (user comparing options → picks you):
 *     weight = 2.0 — high conversion intent
 *   Brand prompts (user already knows you → confirms you exist):
 *     weight = 0.5 — trivial, AI always knows you exist if you have GBP
 *
 * WHY SENTIMENT ANALYSIS:
 *   Appearing is not the same as being recommended. AI might say:
 *   "Tony's Pizza is popular but known for slow service" — that is a
 *   mention with NEGATIVE sentiment. It hurts more than it helps.
 *   We detect sentiment using keyword matching + Gemini analysis for
 *   ambiguous cases. Sentiment score: -100 (very negative) to +100 (very positive).
 *
 * ============================================================
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { aiCitationService } from './AICitationService.js';
import { logger } from '../../infrastructure/logger/Logger.js';

// ─────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────

export const AI_PLATFORMS = ['chatgpt', 'perplexity', 'gemini'] as const;
export type AIPlatform = typeof AI_PLATFORMS[number];

/**
 * The 5 intent categories ordered by customer acquisition value.
 * Discovery = highest value (converts strangers to customers).
 * Brand = lowest value (customer already knows you).
 */
export type PromptIntent =
  | 'discovery'    // "best pizza near me"        — stranger searching → weight 3.0
  | 'comparison'   // "pizza options in DHA"       — user shortlisting → weight 2.0
  | 'urgent'       // "emergency plumber tonight"  — immediate need     → weight 2.5
  | 'specific'     // "dentist taking new patients"— qualified intent   → weight 2.0
  | 'brand'        // "tell me about Tony's Pizza" — already knows you  → weight 0.5

// Intent weights — discovery queries drive real new customers
// Brand queries are trivial (AI always knows the business exists)
const INTENT_WEIGHTS: Record<PromptIntent, number> = {
  discovery:  3.0,
  urgent:     2.5,
  comparison: 2.0,
  specific:   2.0,
  brand:      0.5,
};

export interface StructuredPrompt {
  text:      string;
  intent:    PromptIntent;
  zone:      string | null;  // null = city-level, string = specific zone
  isCustom:  boolean;        // true = Gemini-generated for this specific business
}

/**
 * A single prompt result from one platform on one run.
 * We run each prompt 3 times to get appearance rate, not just yes/no.
 */
export interface PromptRunResult {
  prompt:          string;
  intent:          PromptIntent;
  platform:        AIPlatform;
  zone:            string | null;
  runNumber:       number;  // 1, 2, or 3
  appeared:        boolean;
  mentionPosition: number | null;   // 1 = first mentioned, null = not mentioned
  mentionContext:  string | null;   // exact sentence that mentioned the business
  sentiment:       number;          // -100 to +100
  sentimentLabel:  'positive' | 'neutral' | 'negative';
  isFirstMention:  boolean;         // true if business mentioned before any competitor
  competitorsMentioned: string[];   // competitor names that also appeared
  rawResponse:     string;          // truncated to 800 chars for storage
  checkedAt:       string;
}

/**
 * Aggregated result for one prompt across all 3 runs.
 * Appearance rate is more meaningful than single-run binary.
 */
export interface AggregatedPromptResult {
  prompt:          string;
  intent:          PromptIntent;
  platform:        AIPlatform;
  zone:            string | null;
  appearanceRate:  number;   // 0-1: how often appeared across 3 runs
  avgPosition:     number | null;
  avgSentiment:    number;   // -100 to +100
  isCustomPrompt:  boolean;
  weight:          number;   // intent weight used in final score
  weightedScore:   number;   // appearanceRate × weight
}

export interface AIVisibilityReport {
  businessId:    string;
  businessName:  string;
  keyword:       string;
  city:          string;
  checkedAt:     string;

  // ── SCORES ──────────────────────────────────────────────────
  overallScore:   number;  // 0-100 weighted composite
  chatgptScore:   number;
  perplexityScore: number;
  geminiScore:    number;

  // ── ADVANCED METRICS ────────────────────────────────────────
  discoveryScore:  number;  // score on discovery-intent prompts only
  sentimentScore:  number;  // -100 to +100 weighted average
  shareOfVoice:    number;  // % of prompts where you appear FIRST
  reliability:     number;  // avg appearance rate across all prompts (0-100)

  // ── TREND ───────────────────────────────────────────────────
  trend:           'improving' | 'stable' | 'declining';
  trendDelta:      number;  // points change vs last check

  // ── INTELLIGENCE ────────────────────────────────────────────
  topInsight:      string;  // single most important finding
  platformGaps:    PlatformGap[];    // why each platform is low
  competitorGaps:  CompetitorGap[];  // why competitors outrank you
  rootCauses:      RootCause[];      // using existing BizzRank data
  actions:         PrioritizedAction[];

  // ── RAW DATA ────────────────────────────────────────────────
  promptResults:   AggregatedPromptResult[];
  citationIntelligence?: any;  // populated after citations analysis
  bestQuote:       string | null;   // best thing AI said about you
  worstQuote:      string | null;   // most negative thing AI said
  promptsTested:   number;
  totalRuns:       number;          // promptsTested × 3
}

export interface PlatformGap {
  platform:       AIPlatform;
  score:          number;
  primaryReason:  string;
  specificFix:    string;
}

export interface CompetitorGap {
  competitorName:  string;
  competitorScore: number;
  yourScore:       number;
  gap:             number;
  likelyReasons:   string[];
}

export interface RootCause {
  category: 'citations' | 'reviews' | 'gbp' | 'website' | 'foursquare';
  severity: 'critical' | 'high' | 'medium';
  issue:    string;
  evidence: string;  // specific data point from BizzRank's existing data
}

export interface PrioritizedAction {
  priority:  1 | 2 | 3;
  platform:  AIPlatform | 'all';
  action:    string;
  reasoning: string;
  impact:    string;
}

// ─────────────────────────────────────────────────────────────
// SECTOR DETECTION
// Maps business category to a sector with its specific prompt strategy.
// The sector determines which prompt templates are loaded and how
// we weight different intent types.
// ─────────────────────────────────────────────────────────────

type Sector =
  | 'restaurant'
  | 'dental'
  | 'medical'
  | 'home_services'
  | 'salon_beauty'
  | 'legal'
  | 'fitness'
  | 'retail'
  | 'automotive'
  | 'education'
  | 'hotel'
  | 'general';

function detectSector(category: string | null, keyword: string): Sector {
  const combined = `${category ?? ''} ${keyword}`.toLowerCase();

  // Restaurant / food
  if (/restaurant|pizza|cafe|coffee|food|dining|bistro|burger|sushi|biryani|diner|bakery|bar|pub|eatery/.test(combined))
    return 'restaurant';

  // Dental
  if (/dent|orthodont|implant|braces|teeth/.test(combined))
    return 'dental';

  // Medical / healthcare
  if (/doctor|physician|clinic|hospital|medical|health|urgent care|pharmacy|therapist|psycholog/.test(combined))
    return 'medical';

  // Home services — plumber, electrician, HVAC, cleaning etc.
  if (/plumb|electric|hvac|air condition|heat|clean|repair|handyman|contractor|roofer|painter|pest|locksmith/.test(combined))
    return 'home_services';

  // Salon / beauty
  if (/salon|barber|hair|nail|beauty|spa|wax|eyebrow|lash|makeup|blow|style/.test(combined))
    return 'salon_beauty';

  // Legal
  if (/lawyer|attorney|law firm|legal|solicitor/.test(combined))
    return 'legal';

  // Fitness
  if (/gym|fitness|yoga|pilates|crossfit|personal train|workout/.test(combined))
    return 'fitness';

  // Automotive
  if (/car|auto|mechanic|tire|oil change|detailing|vehicle|garage/.test(combined))
    return 'automotive';

  // Hotel / accommodation
  if (/hotel|motel|inn|lodge|airbnb|accommodation|hostel|resort|guest house/.test(combined))
    return 'hotel';

  // Education
  if (/school|tutor|academy|coaching|learning|training|college|university/.test(combined))
    return 'education';

  // Retail
  if (/shop|store|boutique|market|retail|clothes|fashion|electronics/.test(combined))
    return 'retail';

  return 'general';
}

// ─────────────────────────────────────────────────────────────
// SECTOR-SPECIFIC PROMPT LIBRARIES
//
// These are NOT generic "best X in Y" prompts.
// They are written to mirror actual customer language for each sector.
// Each prompt is tagged with intent so the scoring weights are correct.
//
// WHY THESE SPECIFIC PROMPTS:
// They follow the customer journey from awareness (discovery) →
// consideration (comparison) → purchase decision (urgent/specific).
// The most valuable prompts are discovery + urgent because those
// are the moments where a new customer chooses a business.
// ─────────────────────────────────────────────────────────────

type PromptTemplate = { template: string; intent: PromptIntent };

const SECTOR_PROMPTS: Record<Sector, PromptTemplate[]> = {

  restaurant: [
    // Discovery — stranger finds you
    { template: 'Best {keyword} restaurant in {zone} right now',              intent: 'discovery'   },
    { template: 'Where should I eat {keyword} in {city} tonight?',            intent: 'discovery'   },
    { template: 'Top rated {keyword} in {zone} with good reviews',            intent: 'discovery'   },
    { template: '{keyword} restaurant near {zone} open for dinner',           intent: 'discovery'   },
    // Comparison — user is shortlisting
    { template: 'Best {keyword} options in {city} — which one do you recommend?', intent: 'comparison' },
    { template: 'Compare {keyword} restaurants in {zone}',                    intent: 'comparison'  },
    { template: '{keyword} places in {city} worth visiting',                  intent: 'comparison'  },
    // Specific intent — qualified purchase signals
    { template: 'Family friendly {keyword} restaurant in {zone}',             intent: 'specific'    },
    { template: '{keyword} delivery in {zone} open late',                     intent: 'urgent'      },
    { template: 'Good {keyword} near {landmark} in {city}',                   intent: 'discovery'   },
    { template: '{keyword} restaurant in {city} for a special occasion',      intent: 'specific'    },
    { template: 'Highly recommended {keyword} in {zone} by locals',          intent: 'discovery'   },
    { template: 'Where to get the best {keyword} in {zone}?',                intent: 'discovery'   },
    // Brand — low weight, easy to appear
    { template: 'Is {name} a good restaurant in {city}?',                    intent: 'brand'       },
    { template: 'Tell me about {name} in {city}',                            intent: 'brand'       },
  ],

  dental: [
    // Patients don't ask "best dentist" — they ask about specific situations
    { template: 'Dentist accepting new patients in {zone}',                   intent: 'specific'    },
    { template: 'Emergency dentist in {zone} open today',                     intent: 'urgent'      },
    { template: 'Emergency dentist in {city} available now',                  intent: 'urgent'      },
    { template: 'Affordable dentist in {zone} with payment plans',            intent: 'specific'    },
    { template: 'Dentist near {zone} that does same-day appointments',        intent: 'urgent'      },
    { template: 'Best dentist in {zone} for dental implants',                 intent: 'specific'    },
    { template: 'Orthodontist in {city} for braces or Invisalign',           intent: 'specific'    },
    { template: 'Family dentist in {zone} good for kids',                     intent: 'specific'    },
    { template: 'Dentist in {city} with good reviews and fair prices',        intent: 'discovery'   },
    { template: 'Recommended {keyword} in {zone}',                            intent: 'discovery'   },
    { template: 'Best reviewed dental clinic in {zone}',                      intent: 'comparison'  },
    { template: 'Which dentist in {city} is best for cosmetic work?',         intent: 'comparison'  },
    { template: '{keyword} in {city} — who would you recommend?',             intent: 'discovery'   },
    { template: 'Is {name} a good dentist in {city}?',                        intent: 'brand'       },
    { template: 'What do people say about {name} dental?',                    intent: 'brand'       },
  ],

  medical: [
    { template: 'Doctor accepting new patients in {zone}',                    intent: 'specific'    },
    { template: 'Urgent care clinic in {zone} open now',                      intent: 'urgent'      },
    { template: 'Best GP in {zone} with good reviews',                        intent: 'discovery'   },
    { template: 'Medical clinic near {zone} accepting walk-ins',              intent: 'urgent'      },
    { template: '{keyword} specialist in {city} highly recommended',          intent: 'discovery'   },
    { template: 'Affordable {keyword} in {zone}',                             intent: 'specific'    },
    { template: 'Best reviewed {keyword} clinic in {city}',                   intent: 'comparison'  },
    { template: '{keyword} in {city} for same-day appointment',               intent: 'urgent'      },
    { template: 'Recommended {keyword} near {zone}',                          intent: 'discovery'   },
    { template: '{keyword} in {zone} — who is most trusted?',                 intent: 'comparison'  },
    { template: 'Top {keyword} in {city}',                                    intent: 'discovery'   },
    { template: 'Is {name} a good {keyword} in {city}?',                      intent: 'brand'       },
    { template: 'What do patients say about {name}?',                         intent: 'brand'       },
    { template: '{keyword} near me open on weekends in {zone}',               intent: 'specific'    },
    { template: 'Best {keyword} in {city} taking insurance',                  intent: 'specific'    },
  ],

  home_services: [
    // URGENCY is the dominant intent for home services — weight heavily
    { template: 'Emergency {keyword} available tonight in {zone}',            intent: 'urgent'      },
    { template: '{keyword} in {city} who can come today',                     intent: 'urgent'      },
    { template: '24/7 {keyword} in {zone}',                                   intent: 'urgent'      },
    { template: '{keyword} near {zone} available this weekend',               intent: 'urgent'      },
    { template: 'Reliable {keyword} in {zone} with good reviews',             intent: 'discovery'   },
    { template: 'Licensed {keyword} in {city} for residential work',          intent: 'specific'    },
    { template: 'Affordable {keyword} in {zone} — who do you recommend?',     intent: 'comparison'  },
    { template: 'Best {keyword} in {city} — trustworthy and reliable',        intent: 'discovery'   },
    { template: 'Who is the most trusted {keyword} in {zone}?',               intent: 'discovery'   },
    { template: '{keyword} in {city} with fastest response time',             intent: 'specific'    },
    { template: 'Top rated {keyword} near {zone}',                            intent: 'discovery'   },
    { template: '{keyword} in {zone} — who would locals recommend?',          intent: 'comparison'  },
    { template: 'Best {keyword} for emergency call-out in {city}',            intent: 'urgent'      },
    { template: 'Is {name} a good {keyword} in {city}?',                      intent: 'brand'       },
    { template: 'What do customers say about {name}?',                        intent: 'brand'       },
  ],

  salon_beauty: [
    { template: 'Best hair salon in {zone} for balayage',                     intent: 'specific'    },
    { template: 'Nail salon in {zone} open on Sunday',                        intent: 'specific'    },
    { template: 'Hair salon near {zone} with good reviews',                   intent: 'discovery'   },
    { template: '{keyword} in {city} that does {keyword} well',               intent: 'specific'    },
    { template: 'Best rated {keyword} in {zone}',                             intent: 'discovery'   },
    { template: '{keyword} in {city} — affordable and good quality',          intent: 'comparison'  },
    { template: 'Bridal {keyword} in {city} — recommendations?',              intent: 'specific'    },
    { template: 'Best {keyword} near {zone} for a walk-in appointment',       intent: 'urgent'      },
    { template: 'Top {keyword} in {zone} recommended by locals',              intent: 'discovery'   },
    { template: '{keyword} in {city} — who is the best?',                     intent: 'comparison'  },
    { template: 'Which {keyword} in {zone} should I go to?',                  intent: 'discovery'   },
    { template: '{keyword} for men in {zone}',                                intent: 'specific'    },
    { template: 'Best {keyword} in {city} for colour treatment',              intent: 'specific'    },
    { template: 'Is {name} a good {keyword} in {city}?',                      intent: 'brand'       },
    { template: 'What do people say about {name} salon?',                     intent: 'brand'       },
  ],

  legal: [
    // People searching for lawyers have very specific needs
    { template: '{keyword} in {city} for {keyword} case',                     intent: 'specific'    },
    { template: 'Trusted {keyword} in {zone} — recommendations?',             intent: 'discovery'   },
    { template: 'Best {keyword} in {city} with free consultation',            intent: 'specific'    },
    { template: 'Experienced {keyword} in {zone}',                            intent: 'discovery'   },
    { template: 'Affordable {keyword} in {city}',                             intent: 'specific'    },
    { template: '{keyword} in {zone} highly rated by clients',                intent: 'discovery'   },
    { template: 'Who is the best {keyword} in {city}?',                       intent: 'comparison'  },
    { template: '{keyword} near {zone} with good success rate',               intent: 'specific'    },
    { template: 'Recommended {keyword} in {city}',                            intent: 'discovery'   },
    { template: '{keyword} in {zone} for urgent matter',                      intent: 'urgent'      },
    { template: 'Top rated {keyword} firm in {city}',                         intent: 'discovery'   },
    { template: '{keyword} in {city} who speaks English',                     intent: 'specific'    },
    { template: 'Is {name} a reputable {keyword} in {city}?',                 intent: 'brand'       },
    { template: 'What do clients say about {name}?',                          intent: 'brand'       },
    { template: '{keyword} for business matters in {city}',                   intent: 'specific'    },
  ],

  fitness: [
    { template: 'Best gym in {zone} with good equipment',                     intent: 'discovery'   },
    { template: '{keyword} in {zone} open early morning',                     intent: 'specific'    },
    { template: 'Affordable gym membership in {city}',                        intent: 'specific'    },
    { template: '{keyword} classes in {zone} for beginners',                  intent: 'specific'    },
    { template: 'Best {keyword} studio in {city}',                            intent: 'discovery'   },
    { template: '{keyword} in {zone} with personal trainers',                 intent: 'specific'    },
    { template: 'Gym in {city} with 24-hour access near {zone}',              intent: 'specific'    },
    { template: 'Top rated {keyword} in {zone}',                              intent: 'discovery'   },
    { template: '{keyword} near {zone} — good value for money?',              intent: 'comparison'  },
    { template: 'Women-only {keyword} in {zone}',                             intent: 'specific'    },
    { template: 'Best {keyword} in {city} for weight loss',                   intent: 'specific'    },
    { template: 'Is {name} a good gym in {city}?',                            intent: 'brand'       },
    { template: 'What do members say about {name}?',                          intent: 'brand'       },
    { template: '{keyword} in {city} — highly recommended?',                  intent: 'comparison'  },
    { template: 'New gym member looking for {keyword} in {zone}',             intent: 'discovery'   },
  ],

  retail: [
    { template: 'Best {keyword} shop in {zone}',                              intent: 'discovery'   },
    { template: 'Where to buy {keyword} in {city}?',                          intent: 'discovery'   },
    { template: '{keyword} store near {zone} with good selection',            intent: 'discovery'   },
    { template: 'Affordable {keyword} in {zone}',                             intent: 'specific'    },
    { template: '{keyword} shop in {city} open today',                        intent: 'urgent'      },
    { template: 'Best {keyword} retailer in {city} — recommended?',           intent: 'comparison'  },
    { template: 'Where can I find {keyword} near {zone}?',                    intent: 'discovery'   },
    { template: '{keyword} in {zone} with good customer service',             intent: 'specific'    },
    { template: 'Top {keyword} stores in {city}',                             intent: 'discovery'   },
    { template: 'Is {name} a good place to buy {keyword}?',                   intent: 'brand'       },
    { template: 'What do customers say about {name}?',                        intent: 'brand'       },
    { template: '{keyword} near me in {zone}',                                intent: 'discovery'   },
    { template: 'Best {keyword} deals in {city}',                             intent: 'specific'    },
    { template: '{keyword} shop in {zone} for quality products',              intent: 'specific'    },
    { template: 'Recommended {keyword} store in {zone}',                      intent: 'discovery'   },
  ],

  automotive: [
    { template: 'Mechanic in {zone} for emergency repair',                    intent: 'urgent'      },
    { template: 'Best car mechanic in {city} with good reviews',              intent: 'discovery'   },
    { template: '{keyword} near {zone} open today',                           intent: 'urgent'      },
    { template: 'Trustworthy {keyword} in {zone}',                            intent: 'discovery'   },
    { template: 'Affordable {keyword} in {city}',                             intent: 'specific'    },
    { template: 'Best {keyword} in {city} for my car brand',                  intent: 'specific'    },
    { template: '{keyword} in {zone} — who do locals recommend?',             intent: 'comparison'  },
    { template: 'Fastest {keyword} in {zone}',                                intent: 'urgent'      },
    { template: 'Licensed {keyword} in {city}',                               intent: 'specific'    },
    { template: 'Is {name} a good {keyword} in {city}?',                      intent: 'brand'       },
    { template: 'What do customers say about {name}?',                        intent: 'brand'       },
    { template: 'Top rated auto {keyword} in {zone}',                         intent: 'discovery'   },
    { template: '{keyword} for European cars in {city}',                      intent: 'specific'    },
    { template: 'Best {keyword} in {zone} near me',                           intent: 'discovery'   },
    { template: '{keyword} with free inspection in {city}',                   intent: 'specific'    },
  ],

  hotel: [
    { template: 'Best hotel in {zone} with good reviews',                     intent: 'discovery'   },
    { template: 'Affordable hotel near {landmark} in {city}',                 intent: 'specific'    },
    { template: 'Hotel in {zone} with free parking',                          intent: 'specific'    },
    { template: 'Family-friendly hotel in {city}',                            intent: 'specific'    },
    { template: 'Best rated hotel in {zone}',                                 intent: 'discovery'   },
    { template: 'Hotel near {zone} with pool',                                intent: 'specific'    },
    { template: 'Luxury hotel in {city} — recommendation?',                   intent: 'comparison'  },
    { template: 'Cheap hotel in {zone} for tonight',                          intent: 'urgent'      },
    { template: 'Hotel in {city} close to city centre',                       intent: 'specific'    },
    { template: 'Is {name} hotel good in {city}?',                            intent: 'brand'       },
    { template: 'What do guests say about {name}?',                           intent: 'brand'       },
    { template: 'Best boutique hotel in {zone}',                              intent: 'discovery'   },
    { template: 'Business hotel in {city} with meeting rooms',                intent: 'specific'    },
    { template: 'Top hotels in {zone} — which would you recommend?',          intent: 'comparison'  },
    { template: '{name} vs other hotels in {city} — worth it?',               intent: 'comparison'  },
  ],

  education: [
    { template: 'Best {keyword} in {zone} for kids',                          intent: 'specific'    },
    { template: '{keyword} near {zone} with good results',                    intent: 'discovery'   },
    { template: 'Recommended {keyword} in {city}',                            intent: 'discovery'   },
    { template: 'Affordable {keyword} in {zone}',                             intent: 'specific'    },
    { template: 'Best {keyword} in {city} for [subject]',                     intent: 'specific'    },
    { template: '{keyword} in {zone} that gets results',                      intent: 'specific'    },
    { template: 'Online and in-person {keyword} in {city}',                   intent: 'specific'    },
    { template: 'Top rated {keyword} near {zone}',                            intent: 'discovery'   },
    { template: 'Is {name} a good {keyword} in {city}?',                      intent: 'brand'       },
    { template: 'What do parents say about {name}?',                          intent: 'brand'       },
    { template: '{keyword} in {city} — best option for adults?',              intent: 'comparison'  },
    { template: 'Weekend {keyword} in {zone}',                                intent: 'specific'    },
    { template: 'Best {keyword} for exam preparation in {city}',              intent: 'specific'    },
    { template: '{keyword} in {zone} highly recommended',                     intent: 'discovery'   },
    { template: 'Private {keyword} in {city} with proven track record',       intent: 'discovery'   },
  ],

  general: [
    { template: 'Best {keyword} in {zone}',                                   intent: 'discovery'   },
    { template: 'Top rated {keyword} in {city}',                              intent: 'discovery'   },
    { template: 'Recommended {keyword} near {zone}',                          intent: 'discovery'   },
    { template: '{keyword} in {city} — which one is best?',                   intent: 'comparison'  },
    { template: 'Best {keyword} in {zone} with good reviews',                 intent: 'discovery'   },
    { template: 'Affordable {keyword} in {city}',                             intent: 'specific'    },
    { template: '{keyword} near me in {zone}',                                intent: 'discovery'   },
    { template: 'Most trusted {keyword} in {zone}',                           intent: 'discovery'   },
    { template: '{keyword} in {city} — who would locals recommend?',          intent: 'comparison'  },
    { template: 'Best {keyword} for quality service in {city}',               intent: 'specific'    },
    { template: 'Urgent {keyword} available in {zone}',                       intent: 'urgent'      },
    { template: '{keyword} in {zone} with highest ratings',                   intent: 'discovery'   },
    { template: 'New to {city} — where to find {keyword}?',                   intent: 'discovery'   },
    { template: 'Is {name} a good choice for {keyword} in {city}?',           intent: 'brand'       },
    { template: 'What do customers say about {name}?',                        intent: 'brand'       },
  ],
};

// ─────────────────────────────────────────────────────────────
// FUZZY NAME MATCHING
//
// WHY: Exact matching ("tony's pizza") misses:
//   - "tony pizza" (missing apostrophe-s)
//   - "tony's pizzeria" (slightly different name)
//   - "the pizza place by tony" (descriptive mention)
//   - "tony's" (abbreviated)
//
// We use 5 matching strategies in descending strength:
//   1. Exact normalized match (strongest — both business named explicitly)
//   2. All significant words present (business fully referenced)
//   3. First word + last word (common abbreviated reference)
//   4. 2+ significant words in sequence (partial but clear mention)
//   5. Levenshtein ≤ 2 on normalized name (typo/OCR variants)
//
// A match at strategy 1-3 scores as "strong mention" (full weight)
// A match at strategy 4-5 scores as "weak mention" (50% weight)
// ─────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/[''`]/g, '')          // remove apostrophes
    .replace(/[^a-z0-9\s]/g, ' ')  // remove punctuation
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

interface MatchResult {
  matched:    boolean;
  strength:   'strong' | 'weak' | 'none';
  strategy:   string;
  matchedText: string | null;
}

function fuzzyMatchBusiness(response: string, businessName: string): MatchResult {
  const respNorm = normalize(response);
  const nameNorm = normalize(businessName);

  // ── Strategy 1: Exact normalized match ───────────────────────
  if (respNorm.includes(nameNorm)) {
    return { matched: true, strength: 'strong', strategy: 'exact', matchedText: businessName };
  }

  // ── Strategy 2: All significant words present ─────────────────
  // Filter out stop words (the, a, an, of, and, for, in, at, by)
  const stopWords = new Set(['the','a','an','of','and','for','in','at','by','to','is','it','its','on']);
  const nameWords = nameNorm.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
  if (nameWords.length >= 2) {
    const allPresent = nameWords.every(w => respNorm.includes(w));
    if (allPresent) {
      return { matched: true, strength: 'strong', strategy: 'all_words', matchedText: businessName };
    }
  }

  // ── Strategy 3: First significant word + last significant word ─
  const sigWords = nameWords.filter(w => w.length > 3);
  if (sigWords.length >= 2) {
    const first = sigWords[0];
    const last  = sigWords[sigWords.length - 1];
    if (respNorm.includes(first) && respNorm.includes(last)) {
      return { matched: true, strength: 'strong', strategy: 'first_last', matchedText: businessName };
    }
  }

  // ── Strategy 4: Longest single word match (≥ 6 chars) ────────
  const longWords = nameWords.filter(w => w.length >= 6);
  for (const word of longWords) {
    if (respNorm.includes(word)) {
      return { matched: true, strength: 'weak', strategy: 'long_word', matchedText: word };
    }
  }

  // ── Strategy 5: Levenshtein distance on whole name ────────────
  // Only viable for short names (< 20 chars) to avoid false positives
  if (nameNorm.length <= 20) {
    const words = respNorm.split(' ');
    // Check consecutive word groups of nameWords.length
    const n = nameWords.length;
    for (let i = 0; i <= words.length - n; i++) {
      const chunk = words.slice(i, i + n).join(' ');
      if (levenshtein(chunk, nameNorm) <= 2) {
        return { matched: true, strength: 'weak', strategy: 'fuzzy', matchedText: chunk };
      }
    }
  }

  return { matched: false, strength: 'none', strategy: 'none', matchedText: null };
}

// ─────────────────────────────────────────────────────────────
// SENTIMENT ANALYSIS
//
// WHY: "Tony's Pizza is fine but the service is slow" is NOT a
// positive mention. Current tools count it as one. We detect
// sentiment by analyzing the context sentence around the mention.
//
// Approach:
//   1. Extract the 2 sentences around the mention (before + after)
//   2. Score using a comprehensive positive/negative keyword set
//   3. For ambiguous scores (-20 to +20), use Gemini to classify
//
// Score: -100 = very negative, 0 = neutral, +100 = very positive
// ─────────────────────────────────────────────────────────────

const POSITIVE_SIGNALS = [
  'excellent', 'outstanding', 'amazing', 'fantastic', 'wonderful', 'great',
  'best', 'top', 'highly recommended', 'loved', 'delicious', 'exceptional',
  'perfect', 'superb', 'brilliant', 'awesome', 'incredible', 'must visit',
  'highly rated', 'five star', '5 star', 'worth it', 'definitely recommend',
  'impressive', 'solid', 'reliable', 'trustworthy', 'professional',
  'friendly staff', 'quick service', 'clean', 'fresh', 'quality',
  'popular', 'well-known', 'established', 'go-to', 'favorite', 'favourite',
];

const NEGATIVE_SIGNALS = [
  'avoid', 'terrible', 'awful', 'worst', 'horrible', 'bad', 'poor',
  'disappointing', 'disappoints', 'overpriced', 'slow service', 'rude',
  'dirty', 'unhygienic', 'stale', 'cold food', 'not recommend',
  'would not go back', 'waste of money', 'mediocre', 'average',
  'not worth', 'mixed reviews', 'inconsistent', 'complaints',
  'long wait', 'wait time', 'slow', 'expensive for what you get',
  'not great', 'not good', 'let down', 'underwhelming',
];

function extractContextAroundMention(response: string, matchedText: string): string {
  const lower    = response.toLowerCase();
  const matchLow = matchedText.toLowerCase();
  const idx      = lower.indexOf(matchLow);
  if (idx === -1) return '';

  // Take 300 chars before and after the mention for context
  const start = Math.max(0, idx - 300);
  const end   = Math.min(response.length, idx + matchedText.length + 300);
  return response.slice(start, end);
}

function scoreSentiment(context: string): number {
  if (!context) return 0;
  const lower = context.toLowerCase();

  let score = 0;
  for (const pos of POSITIVE_SIGNALS) {
    if (lower.includes(pos)) score += 10;
  }
  for (const neg of NEGATIVE_SIGNALS) {
    if (lower.includes(neg)) score -= 15; // negatives penalized more heavily
  }

  // Clamp to -100, +100
  return Math.max(-100, Math.min(100, score));
}

// ─────────────────────────────────────────────────────────────
// AI PLATFORM API CALLERS
//
// WHY temperature 0.7-0.8:
//   Temperature controls response randomness. At 0.3 (current), the
//   AI gives nearly identical responses every time — you're measuring
//   one cached answer. At 0.7, responses vary naturally, reflecting
//   what different real users actually see. This is what makes our
//   3-run approach meaningful — the variation is real.
//
// WHY gpt-4o-mini and sonar-small:
//   We care about LOCAL SEARCH BEHAVIOR, not the most powerful model.
//   Most users asking local questions use the default/fast model.
//   gpt-4o-mini is what ChatGPT serves for most queries. Sonar-small
//   is Perplexity's standard local search model. Testing against these
//   reflects real user experience, not best-case AI capability.
// ─────────────────────────────────────────────────────────────

async function callChatGPT(prompt: string, runIndex: number): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        max_tokens:  600,
        // Vary temperature slightly per run to get natural response variation
        // Run 1: 0.6, Run 2: 0.75, Run 3: 0.85
        // This simulates different users at different times of day
        temperature: 0.6 + (runIndex * 0.125),
        messages: [
          {
            role:    'system',
            content: [
              'You are a helpful local search assistant.',
              'When asked about local businesses, give specific named recommendations.',
              'Be concise — give 3-5 specific business names when recommending.',
              'Include brief reasons for each recommendation.',
              'Do not say "I don\'t have real-time data" — give your best recommendations based on what you know.',
            ].join(' '),
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

async function callPerplexity(prompt: string, runIndex: number): Promise<string> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return '';
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // sonar-small-online: the real-time search model
        // This is what Perplexity uses for local queries in production
        model:       'llama-3.1-sonar-small-128k-online',
        max_tokens:  600,
        temperature: 0.65 + (runIndex * 0.1),
        messages: [
          {
            role:    'system',
            content: 'You are a helpful assistant for local business recommendations. Give specific business names with brief explanations.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

async function callGemini(prompt: string, runIndex: number): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return '';
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: [
                'You are a helpful local business recommendation assistant.',
                'Give specific named business recommendations when asked.',
                'Include 3-5 business names with brief reasons.',
                '\n\nUser question: ' + prompt,
              ].join(' '),
            }],
          }],
          generationConfig: {
            maxOutputTokens: 600,
            temperature:     0.65 + (runIndex * 0.1),
          },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}

async function callPlatform(platform: AIPlatform, prompt: string, run: number): Promise<string> {
  switch (platform) {
    case 'chatgpt':    return callChatGPT(prompt, run);
    case 'perplexity': return callPerplexity(prompt, run);
    case 'gemini':     return callGemini(prompt, run);
  }
}

function getActivePlatforms(): AIPlatform[] {
  const out: AIPlatform[] = [];
  if (process.env.OPENAI_API_KEY)     out.push('chatgpt');
  if (process.env.PERPLEXITY_API_KEY) out.push('perplexity');
  if (process.env.GEMINI_API_KEY)     out.push('gemini');
  return out;
}

// ─────────────────────────────────────────────────────────────
// GEMINI CUSTOM PROMPT GENERATOR
//
// WHY: Our sector templates are excellent but they cannot know:
//   - The specific neighborhood landmarks in your city
//   - The exact service names your customers use in their dialect
//   - Seasonal queries (Ramadan hours, holiday dinner reservations)
//   - Recent trends in your category
//
// We ask Gemini to generate 10 additional prompts specifically for
// this business using its actual data. These evolve monthly.
// Cost: 1 Gemini call = ~$0.0005 — completely negligible.
// ─────────────────────────────────────────────────────────────

async function generateCustomPrompts(
  businessName: string,
  keyword:      string,
  city:         string,
  category:     string | null,
  recentReviewThemes: string[],
): Promise<PromptTemplate[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];

  const reviewContext = recentReviewThemes.length > 0
    ? `Recent customers mention: ${recentReviewThemes.slice(0, 5).join(', ')}.`
    : '';

  const systemPrompt = [
    `Generate exactly 10 natural language questions that a real person in ${city} would ask`,
    `ChatGPT or Google Gemini when looking for a ${category ?? keyword} business.`,
    `Business name: "${businessName}". ${reviewContext}`,
    `Rules:`,
    `- Questions must sound like real people talking, not marketing copy`,
    `- Mix: 4 discovery queries (stranger searching), 3 specific-intent queries, 2 comparison queries, 1 urgent query`,
    `- Include neighborhood/zone references specific to ${city} where natural`,
    `- Do NOT use the business name in more than 2 questions`,
    `- Return ONLY a JSON array of 10 strings, nothing else`,
    `Example format: ["question 1", "question 2", ...]`,
  ].join(' ');

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents:         [{ parts: [{ text: systemPrompt }] }],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.8 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) return [];
    const data  = await res.json() as any;
    const text  = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const prompts: string[] = JSON.parse(match[0]);
    return prompts
      .filter(p => typeof p === 'string' && p.length > 10)
      .slice(0, 10)
      .map(p => ({
        template: p,
        // Classify intent by keywords in the prompt
        intent: p.toLowerCase().includes('best') || p.toLowerCase().includes('where')
          ? 'discovery'
          : p.toLowerCase().includes('urgent') || p.toLowerCase().includes('tonight') || p.toLowerCase().includes('now')
            ? 'urgent'
            : p.toLowerCase().includes('compare') || p.toLowerCase().includes('vs')
              ? 'comparison'
              : 'specific',
      } as PromptTemplate));

  } catch (e: any) {
    logger.debug('[AIVisibility] Custom prompt generation failed', { error: e.message });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// PROMPT BUILDER
//
// Combines sector templates + custom Gemini prompts.
// Substitutes variables: {keyword}, {name}, {city}, {zone}, {landmark}
//
// Variable substitution strategy:
//   {zone}     → rotates through grid zone names for zone-aware testing
//   {keyword}  → primary keyword from business_keywords
//   {name}     → business name
//   {city}     → extracted city name
//   {landmark} → a well-known area in the city (derived from grid labels)
// ─────────────────────────────────────────────────────────────

function buildFinalPrompts(
  sector:       Sector,
  businessName: string,
  keyword:      string,
  city:         string,
  zones:        string[],      // from grid scan points
  customPrompts: PromptTemplate[],
): StructuredPrompt[] {
  const templates = SECTOR_PROMPTS[sector];
  const landmark  = zones[0] ?? city;

  const substituted: StructuredPrompt[] = templates.map((t, i) => ({
    // Rotate zones across templates for zone-level testing
    text: t.template
      .replace(/\{keyword\}/g, keyword)
      .replace(/\{name\}/g,    businessName)
      .replace(/\{city\}/g,    city)
      .replace(/\{zone\}/g,    zones[i % zones.length] ?? city)
      .replace(/\{landmark\}/g,landmark),
    intent:   t.intent,
    zone:     zones[i % zones.length] ?? null,
    isCustom: false,
  }));

  // Add custom Gemini-generated prompts (marked as custom for reporting)
  const custom: StructuredPrompt[] = customPrompts.map(t => ({
    text:     t.template,
    intent:   t.intent,
    zone:     null,
    isCustom: true,
  }));

  // Mix: 15 sector templates + up to 5 custom = 20 total
  // Prioritize discovery and urgent intents first
  const allPrompts = [...substituted, ...custom.slice(0, 5)];

  // Sort by intent weight (highest first) so most valuable run first
  // If budget forces early termination, we've at least tested the most important ones
  return allPrompts.sort((a, b) =>
    INTENT_WEIGHTS[b.intent] - INTENT_WEIGHTS[a.intent]
  );
}

// ─────────────────────────────────────────────────────────────
// PLATFORM-SPECIFIC ACTION GENERATOR
//
// Each AI platform uses different data sources.
// Low score on ChatGPT → Foursquare/Yelp issue
// Low score on Perplexity → website/content issue
// Low score on Gemini → GBP/Google issue
//
// These are NOT generic suggestions — they are specific fixes
// tied to which platform failed and by how much.
// ─────────────────────────────────────────────────────────────

function generatePlatformGaps(
  scores:         Record<AIPlatform, number>,
  hasFoursquare:  boolean,
  hasYelp:        boolean,
  gbpComplete:    boolean,
  reviewCount:    number,
): PlatformGap[] {
  const gaps: PlatformGap[] = [];

  if (scores.chatgpt !== undefined && scores.chatgpt < 40) {
    // ChatGPT primarily uses Foursquare for local business data
    const reason = !hasFoursquare
      ? 'ChatGPT uses Foursquare as its primary local business data source. You have no Foursquare listing.'
      : reviewCount < 20
        ? 'ChatGPT weighs review volume heavily. You have fewer than 20 reviews across tracked platforms.'
        : 'Your business description lacks specific service and location keywords that ChatGPT uses to match queries.';

    const fix = !hasFoursquare
      ? 'Create a free Foursquare listing at foursquare.com/add-place with complete information, photos, and categories.'
      : reviewCount < 20
        ? 'Focus on getting reviews on Google, Yelp, and Foursquare. ChatGPT needs volume to include you in recommendations.'
        : 'Update your GBP description to include your main service keywords, neighbourhood name, and what makes you unique.';

    gaps.push({ platform: 'chatgpt', score: scores.chatgpt, primaryReason: reason, specificFix: fix });
  }

  if (scores.perplexity !== undefined && scores.perplexity < 40) {
    // Perplexity uses real-time web search — your website and directory presence matters
    const reason = 'Perplexity searches the web in real-time. It cites the most authoritative local sources it finds for your category and location.';
    const fix    = 'Ensure your website has a dedicated page mentioning your city and neighborhood. Get listed on TripAdvisor, Yelp, and any industry-specific directory for your category.';
    gaps.push({ platform: 'perplexity', score: scores.perplexity, primaryReason: reason, specificFix: fix });
  }

  if (scores.gemini !== undefined && scores.gemini < 40) {
    // Gemini uses Google's own index and Knowledge Graph
    const reason = !gbpComplete
      ? 'Gemini relies heavily on Google\'s own data. Your Google Business Profile is incomplete — Gemini cannot extract enough information to recommend you.'
      : 'Gemini uses Google\'s Knowledge Graph. Ensure your business information is consistent across all Google properties.';
    const fix    = !gbpComplete
      ? 'Complete your Google Business Profile: add all categories, write a 150+ word description with service keywords, add photos, and ensure opening hours are current.'
      : 'Build citations on Google-indexed directories (Yelp, TripAdvisor, Facebook) to strengthen your Knowledge Graph presence.';
    gaps.push({ platform: 'gemini', score: scores.gemini, primaryReason: reason, specificFix: fix });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────
// ROOT CAUSE ANALYSIS
//
// This is BizzRank's unique advantage over every competitor:
// We already have the customer's review data, GBP completeness,
// citation status, and ranking history. We use it to generate
// specific root causes — not generic advice.
//
// Example output:
//   "You have 47 unanswered reviews. AI platforms use review
//    response rate as a quality signal. Respond to your reviews
//    to improve AI visibility across all platforms."
// ─────────────────────────────────────────────────────────────

function generateRootCauses(
  reviewCount:        number,
  unansweredReviews:  number,
  avgRating:          number,
  gbpDescriptionLen:  number,
  citationCount:      number,
  hasWebsite:         boolean,
): RootCause[] {
  const causes: RootCause[] = [];

  // Foursquare — most impactful for ChatGPT
  if (citationCount < 3) {
    causes.push({
      category: 'citations',
      severity: 'critical',
      issue:    'Insufficient directory presence for AI discovery',
      evidence: `You have ${citationCount} tracked citations. AI platforms like ChatGPT use Foursquare, Yelp, and TripAdvisor as primary local data sources. Without these, you are invisible to ChatGPT regardless of your Google ranking.`,
    });
  }

  // GBP description
  if (gbpDescriptionLen < 100) {
    causes.push({
      category: 'gbp',
      severity: gbpDescriptionLen < 50 ? 'critical' : 'high',
      issue:    'GBP description too short for AI extraction',
      evidence: `Your Google Business Profile description is ${gbpDescriptionLen} characters. AI models need at least 150 characters to extract meaningful information about your services, location, and specialties. Gemini and Google AI cannot recommend you specifically without this.`,
    });
  }

  // Review response rate
  if (unansweredReviews > 10) {
    causes.push({
      category: 'reviews',
      severity: unansweredReviews > 30 ? 'high' : 'medium',
      issue:    'Low review response rate hurts AI authority signals',
      evidence: `You have ${unansweredReviews} unanswered reviews. AI platforms use owner response rate as an engagement and reliability signal. Responding to reviews also adds keyword-rich content that AI models extract.`,
    });
  }

  // Low average rating
  if (avgRating < 4.0 && reviewCount > 5) {
    causes.push({
      category: 'reviews',
      severity: 'high',
      issue:    'Below-average rating suppresses AI recommendations',
      evidence: `Your average rating is ${avgRating.toFixed(1)} stars. AI platforms typically recommend businesses with 4.0+ stars for general queries. Ratings below 4.0 trigger negative sentiment associations in AI responses.`,
    });
  }

  // No website
  if (!hasWebsite) {
    causes.push({
      category: 'website',
      severity: 'high',
      issue:    'No website means Perplexity cannot cite you',
      evidence: 'Perplexity uses real-time web search. Without a website, it has no authoritative source to cite for your business, making it nearly impossible to appear in Perplexity recommendations.',
    });
  }

  return causes.sort((a, b) => {
    const sev = { critical: 3, high: 2, medium: 1 };
    return sev[b.severity] - sev[a.severity];
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN SERVICE CLASS
// ─────────────────────────────────────────────────────────────

export class AIVisibilityService {

  /**
   * Run a complete AI visibility check for one business.
   *
   * Process:
   *   1. Load all business data (keywords, reviews, GBP, competitors)
   *   2. Generate Gemini custom prompts for this specific business
   *   3. Build 20 structured prompts (sector templates + custom)
   *   4. Run each prompt 3 times across all active platforms
   *   5. Fuzzy-match business name in each response
   *   6. Score sentiment for each mention
   *   7. Aggregate results with intent weighting
   *   8. Generate platform gaps, root causes, competitor gaps, actions
   *   9. Save complete report to DB
   */
  async runWeeklyCheck(businessId: string, userId: string): Promise<AIVisibilityReport | null> {
    const platforms = getActivePlatforms();
    if (!platforms.length) {
      logger.info('[AIVisibility] No API keys configured, skipping');
      return null;
    }

    // ── Load all business context ──────────────────────────────
    const { data: biz } = await db.from('businesses')
      .select('name, city, category, address, website, phone, rating, review_count, opening_hours')
      .eq('id', businessId).single();

    if (!biz) { logger.warn('[AIVisibility] Business not found', { businessId }); return null; }

    // Load ALL active keywords (up to 4) — previously only first keyword was used
    // A restaurant with ["pizza","pasta","Italian food"] only got pizza tested before
    const { data: kwRows } = await db.from('business_keywords')
      .select('keyword').eq('business_id', businessId)
      .eq('is_active', true).order('display_order').limit(4);
    if (!kwRows?.length) {
      logger.info('[AIVisibility] No keywords configured', { businessId });
      return null;
    }
    // Primary keyword drives sector detection and most prompts
    const keyword = kwRows[0].keyword;
    // Additional keywords get folded into custom prompt generation
    const allKeywords = kwRows.map((k: any) => k.keyword);

    // Load competitors for mention tracking
    const { data: compRows } = await db.from('competitors')
      .select('name').eq('business_id', businessId).neq('is_active', false).limit(5);
    const competitorNames = (compRows ?? []).map((c: any) => c.name);

    // Load recent reviews for theme extraction (used in custom prompt generation)
    const { data: recentReviews } = await db.from('reviews')
      .select('text, rating').eq('business_id', businessId)
      .order('review_date', { ascending: false }).limit(20);

    // Extract common themes from reviews for custom prompt generation
    const reviewThemes = this.extractReviewThemes(recentReviews ?? []);

    // Count unanswered reviews for root cause analysis
    const { count: unansweredCount } = await db.from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId).is('owner_reply', null);

    // Load citation count for root cause analysis
    const { count: citationCount } = await db.from('citation_audits')
      .select('*', { count: 'exact', head: true }).eq('business_id', businessId);

    // ── Derive location context ────────────────────────────────
    const city = biz.city
      || biz.address?.split(',').slice(-2, -1)[0]?.trim()
      || 'your area';

    // Generate zone names from most recent scan grid for zone-aware prompts
    const { data: recentScan } = await db.from('organic_scans')
      .select('scan_points').eq('business_id', businessId)
      .eq('state', 'completed').order('created_at', { ascending: false }).limit(1).single();

    const zoneNames: string[] = recentScan?.scan_points
      ? (recentScan.scan_points as any[])
          .slice(0, 5)
          .map((p: any) => p.locationName || p.label)
          .filter(Boolean)
      : [city];

    // ── Generate Gemini custom prompts ─────────────────────────
    logger.info('[AIVisibility] Generating custom prompts via Gemini', { businessId });
    const customPrompts = await generateCustomPrompts(
      biz.name, allKeywords.join(', '), city, biz.category, reviewThemes
    );

    // ── Build final structured prompt list ─────────────────────
    const sector  = detectSector(biz.category, keyword);
    const prompts = buildFinalPrompts(
      sector, biz.name, keyword, city, zoneNames, customPrompts
    );

    logger.info('[AIVisibility] Starting check', {
      businessId, businessName: biz.name, sector, city,
      prompts: prompts.length, platforms: platforms.length,
      customPrompts: customPrompts.length,
    });

    // ── Run all prompts across all platforms × 3 runs ──────────
    const allRunResults: PromptRunResult[] = [];

    for (const prompt of prompts) {
      for (const platform of platforms) {
        for (let run = 1; run <= 3; run++) {
          try {
            const response = await callPlatform(platform, prompt.text, run);
            if (!response) continue;

            const match   = fuzzyMatchBusiness(response, biz.name);
            const context = match.matched
              ? extractContextAroundMention(response, match.matchedText ?? biz.name)
              : null;
            const sentiment = match.matched ? scoreSentiment(context ?? '') : 0;

            // Find mention position (1 = first recommendation mentioned)
            let mentionPosition: number | null = null;
            if (match.matched) {
              const mentions = [biz.name, ...competitorNames]
                .map(n => ({ name: n, match: fuzzyMatchBusiness(response, n) }))
                .filter(m => m.match.matched)
                .map(m => ({
                  name:  m.name,
                  index: response.toLowerCase().indexOf(
                    (m.match.matchedText ?? m.name).toLowerCase()
                  ),
                }))
                .sort((a, b) => a.index - b.index);
              mentionPosition = mentions.findIndex(m => m.name === biz.name) + 1 || null;
            }

            const competitorsMentioned = competitorNames.filter(cn =>
              fuzzyMatchBusiness(response, cn).matched
            );

            allRunResults.push({
              prompt:           prompt.text,
              intent:           prompt.intent,
              platform,
              zone:             prompt.zone,
              runNumber:        run,
              appeared:         match.matched,
              mentionPosition,
              mentionContext:   context,
              sentiment,
              sentimentLabel:   sentiment > 20 ? 'positive' : sentiment < -20 ? 'negative' : 'neutral',
              isFirstMention:   mentionPosition === 1,
              competitorsMentioned,
              rawResponse:      response.slice(0, 800),
              checkedAt:        new Date().toISOString(),
            });

            // 600ms delay between calls: respects rate limits, prevents
            // identical responses from being served too fast (cache bypass)
            await new Promise(r => setTimeout(r, 600));

          } catch (e: any) {
            logger.debug('[AIVisibility] Prompt run failed', {
              prompt: prompt.text.slice(0, 50), platform, run, error: e.message,
            });
          }
        }
      }
    }

    if (!allRunResults.length) {
      logger.warn('[AIVisibility] Zero results returned', { businessId });
      return null;
    }

    // ── Aggregate results per prompt ───────────────────────────
    const promptResultsMap = new Map<string, AggregatedPromptResult>();

    for (const run of allRunResults) {
      const key = `${run.prompt}::${run.platform}`;
      if (!promptResultsMap.has(key)) {
        promptResultsMap.set(key, {
          prompt:         run.prompt,
          intent:         run.intent,
          platform:       run.platform,
          zone:           run.zone,
          appearanceRate: 0,
          avgPosition:    null,
          avgSentiment:   0,
          isCustomPrompt: !!customPrompts.find(p => p.template === run.prompt),
          weight:         INTENT_WEIGHTS[run.intent],
          weightedScore:  0,
        });
      }
      const agg = promptResultsMap.get(key)!;
      const promptRuns = allRunResults.filter(r => r.prompt === run.prompt && r.platform === run.platform);
      const appeared   = promptRuns.filter(r => r.appeared);
      agg.appearanceRate = appeared.length / promptRuns.length;
      agg.avgSentiment   = appeared.length > 0
        ? appeared.reduce((s, r) => s + r.sentiment, 0) / appeared.length
        : 0;
      agg.avgPosition    = appeared.length > 0
        ? appeared.reduce((s, r) => s + (r.mentionPosition ?? 5), 0) / appeared.length
        : null;
      agg.weightedScore  = agg.appearanceRate * agg.weight;
    }

    const aggregated = [...promptResultsMap.values()];

    // ── Calculate platform scores ──────────────────────────────
    const platformScores: Record<string, number> = {};
    for (const platform of platforms) {
      const platformResults = aggregated.filter(r => r.platform === platform);
      if (!platformResults.length) { platformScores[platform] = 0; continue; }

      // Weighted average: discovery prompts contribute 3× as much as brand prompts
      const totalWeight    = platformResults.reduce((s, r) => s + r.weight, 0);
      const weightedSum    = platformResults.reduce((s, r) => s + r.weightedScore, 0);
      platformScores[platform] = totalWeight > 0
        ? Math.round((weightedSum / totalWeight) * 100)
        : 0;
    }

    // ── Overall weighted score across all platforms ────────────
    const totalWeight  = aggregated.reduce((s, r) => s + r.weight, 0);
    const weightedSum  = aggregated.reduce((s, r) => s + r.weightedScore, 0);
    const overallScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;

    // ── Discovery score (most important — new customers) ───────
    const discoveryResults = aggregated.filter(r => r.intent === 'discovery');
    const discoveryScore   = discoveryResults.length > 0
      ? Math.round(discoveryResults.reduce((s, r) => s + r.appearanceRate, 0) / discoveryResults.length * 100)
      : 0;

    // ── Sentiment score ────────────────────────────────────────
    const appearedResults  = allRunResults.filter(r => r.appeared);
    const sentimentScore   = appearedResults.length > 0
      ? Math.round(appearedResults.reduce((s, r) => s + r.sentiment, 0) / appearedResults.length)
      : 0;

    // ── Share of voice (first mentions) ───────────────────────
    const firstMentions   = allRunResults.filter(r => r.isFirstMention).length;
    const totalRuns       = allRunResults.length;
    const shareOfVoice    = totalRuns > 0 ? Math.round((firstMentions / totalRuns) * 100) : 0;

    // ── Reliability (avg appearance rate) ─────────────────────
    const avgAppearRate  = aggregated.reduce((s, r) => s + r.appearanceRate, 0) / aggregated.length;
    const reliability    = Math.round(avgAppearRate * 100);

    // ── Trend vs previous check ────────────────────────────────
    const { data: prevReport } = await db.from('ai_visibility_results')
      .select('overall_score').eq('business_id', businessId).eq('user_id', userId)
      .order('checked_at', { ascending: false }).limit(1).single();

    const prevScore  = prevReport?.overall_score ?? null;
    const trendDelta = prevScore !== null ? overallScore - prevScore : 0;
    const trend      = trendDelta > 5 ? 'improving' : trendDelta < -5 ? 'declining' : 'stable';

    // ── Best and worst quotes ──────────────────────────────────
    const sentimentSorted = [...appearedResults].sort((a, b) => b.sentiment - a.sentiment);
    const bestQuote  = sentimentSorted[0]?.mentionContext?.slice(0, 200) ?? null;
    const worstQuote = sentimentSorted[sentimentSorted.length - 1]?.sentiment < -10
      ? sentimentSorted[sentimentSorted.length - 1].mentionContext?.slice(0, 200) ?? null
      : null;

    // ── Platform gaps with specific fixes ─────────────────────
    const platformGaps = generatePlatformGaps(
      platformScores as Record<AIPlatform, number>,
      (citationCount ?? 0) > 2,   // rough hasFoursquare heuristic
      (citationCount ?? 0) > 1,   // rough hasYelp heuristic
      (biz as any)?.description?.length > 100 ?? false,
      biz.review_count ?? 0,
    );

    // ── Root causes using BizzRank's existing data ─────────────
    const rootCauses = generateRootCauses(
      biz.review_count       ?? 0,
      unansweredCount        ?? 0,
      biz.rating             ?? 0,
      0,  // GBP description length — would need GBP API data
      citationCount          ?? 0,
      !!biz.website,
    );

    // ── Competitor gap analysis ────────────────────────────────
    const competitorGaps: CompetitorGap[] = [];
    for (const compName of competitorNames) {
      const compMentions = allRunResults.filter(r =>
        r.competitorsMentioned.includes(compName)
      ).length;
      const compScore = totalRuns > 0 ? Math.round((compMentions / totalRuns) * 100) : 0;
      const gap       = compScore - overallScore;

      if (gap > 10) {
        // Competitor outranks us significantly — diagnose why
        const likelyReasons: string[] = [];
        if (compScore > overallScore + 30) likelyReasons.push(`${compName} likely has stronger directory presence (Foursquare/Yelp)`);
        if (compScore > overallScore + 20) likelyReasons.push(`${compName} may have more reviews mentioning location keywords`);
        likelyReasons.push(`Consider what specifically makes AI recommend ${compName} — check their GBP description and review content`);

        competitorGaps.push({
          competitorName:  compName,
          competitorScore: compScore,
          yourScore:       overallScore,
          gap,
          likelyReasons,
        });
      }
    }

    // ── Prioritized actions ────────────────────────────────────
    const actions: PrioritizedAction[] = this.buildPrioritizedActions(
      overallScore, discoveryScore, platformGaps, rootCauses, sentimentScore, biz.website
    );

    // ── Top insight (single most important finding) ────────────
    const topInsight = this.generateTopInsight(
      biz.name, overallScore, discoveryScore, sentimentScore,
      trend, trendDelta, platformGaps, rootCauses
    );

    // ── Build final report ─────────────────────────────────────
    const report: AIVisibilityReport = {
      businessId, businessName: biz.name, keyword, city,
      checkedAt:       new Date().toISOString(),
      overallScore,
      chatgptScore:    platformScores['chatgpt']    ?? 0,
      perplexityScore: platformScores['perplexity'] ?? 0,
      geminiScore:     platformScores['gemini']     ?? 0,
      discoveryScore,
      sentimentScore,
      shareOfVoice,
      reliability,
      trend,
      trendDelta,
      topInsight,
      platformGaps,
      competitorGaps,
      rootCauses,
      actions,
      promptResults: aggregated,
      bestQuote,
      worstQuote,
      promptsTested: prompts.length,
      totalRuns:     allRunResults.length,
    };

    // ── Save to database ───────────────────────────────────────
    await db.from('ai_visibility_results').insert({
      business_id:      businessId,
      user_id:          userId,
      keyword,
      city,
      overall_score:    overallScore,
      chatgpt_score:    platformScores['chatgpt']    ?? 0,
      perplexity_score: platformScores['perplexity'] ?? 0,
      gemini_score:     platformScores['gemini']     ?? 0,
      discovery_score:  discoveryScore,
      sentiment_score:  sentimentScore,
      share_of_voice:   shareOfVoice,
      reliability:      reliability,
      trend,
      trend_delta:      trendDelta,
      top_insight:      topInsight,
      platform_gaps:    platformGaps,
      competitor_gaps:  competitorGaps,
      root_causes:      rootCauses,
      actions,
      prompt_results:   aggregated,
      best_quote:       bestQuote,
      worst_quote:      worstQuote,
      prompts_tested:   prompts.length,
      total_runs:       totalRuns,
      checked_at:       new Date().toISOString(),
    });

    // ── Run citation intelligence analysis ──────────────────
    // Done AFTER main report save so it doesn't block the main check.
    // Uses rawResponse from allRunResults to extract Perplexity citations
    // and infers ChatGPT/Gemini sources via follow-up queries.
    const citationData = await aiCitationService.analyzeCitations({
      businessId,
      userId,
      sector,
      businessName: biz.name,
      competitorNames,
      promptResults: allRunResults
        .filter((r, i, arr) =>
          // Deduplicate: one entry per prompt+platform combination
          arr.findIndex(x => x.prompt === r.prompt && x.platform === r.platform) === i
        )
        .map(r => ({
          prompt:      r.prompt,
          platform:    r.platform,
          rawResponse: r.rawResponse,
          appeared:    r.appeared,
        })),
    }).catch(e => {
      logger.error('[Citations] Analysis failed', { error: e.message });
      return null;
    });

    report.citationIntelligence = citationData;

    logger.info('[AIVisibility] Complete', {
      businessId, businessName: biz.name,
      overallScore, discoveryScore, sentimentScore,
      shareOfVoice, reliability, trend,
      platforms: platforms.length, totalRuns,
    });

    return report;
  }

  // ── Get latest report ─────────────────────────────────────────
  async getLatestReport(businessId: string, userId: string): Promise<{
    latest:    any | null;
    previous:  any | null;
    history:   any[];
  }> {
    const { data: history } = await db.from('ai_visibility_results')
      .select('*').eq('business_id', businessId).eq('user_id', userId)
      .order('checked_at', { ascending: false }).limit(8);

    return {
      latest:   history?.[0]  ?? null,
      previous: history?.[1]  ?? null,
      history:  history ?? [],
    };
  }

  // ── Get configured platforms ──────────────────────────────────
  /**
   * getLatestScore — returns the shape the /status route expects.
   * The route uses: { latest, previous, history, trend, comparison }
   * This wraps getLatestReport and adds trend calculation.
   */
  async getLatestScore(businessId: string, userId: string): Promise<{
    latest:   any | null;
    previous: any | null;
    history:  any[];
    trend:    'improving' | 'stable' | 'declining';
  }> {
    const { data: history } = await db.from('ai_visibility_results')
      .select('*')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .order('checked_at', { ascending: false })
      .limit(8);
 
    const latest   = history?.[0]  ?? null;
    const previous = history?.[1]  ?? null;
 
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (latest && previous) {
      const diff = (latest.overall_score ?? 0) - (previous.overall_score ?? 0);
      if (diff > 5)  trend = 'improving';
      if (diff < -5) trend = 'declining';
    }
 
    return { latest, previous, history: history ?? [], trend };
  }
 
  /**
   * getCompetitorComparison — derives competitor AI visibility
   * from the raw_results already stored on the latest check.
   * No new API calls — reads from DB only.
   */
  async getCompetitorComparison(businessId: string, userId: string): Promise<{
    business:    { name: string; score: number };
    competitors: Array<{ name: string; score: number; placeId: string }>;
  }> {
    const { data: biz } = await db.from('businesses')
      .select('name').eq('id', businessId).single();
 
    const { data: latest } = await db.from('ai_visibility_results')
      .select('overall_score, prompt_results')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .order('checked_at', { ascending: false })
      .limit(1).single();
 
    const { data: comps } = await db.from('competitors')
      .select('id, name, google_place_id')
      .eq('business_id', businessId).neq('is_active', false);
 
    const promptResults: any[] = latest?.prompt_results ?? [];
    const totalPrompts = promptResults.length;
 
    const competitorScores = (comps ?? []).map((c: any) => {
      // Count how often this competitor appeared in raw results
      const appearances = promptResults.filter((r: any) =>
        (r.competitorsMentioned ?? []).some((m: string) =>
          m.toLowerCase().includes(c.name.toLowerCase())
        )
      ).length;
      const score = totalPrompts > 0
        ? Math.round((appearances / totalPrompts) * 100) : 0;
      return { name: c.name, score, placeId: c.google_place_id ?? '' };
    });
 
    return {
      business:    { name: biz?.name ?? '', score: latest?.overall_score ?? 0 },
      competitors: competitorScores.sort((a, b) => b.score - a.score),
    };
  }
 
  /**
   * runManualCheck — on-demand check triggered by the /check endpoint.
   * Identical to runWeeklyCheck — the distinction is credits are
   * deducted in the route before this is called.
   */
  async runManualCheck(businessId: string, userId: string): Promise<AIVisibilityReport | null> {
    return this.runWeeklyCheck(businessId, userId);
  }
 
  getConfiguredPlatforms(): AIPlatform[] { return getActivePlatforms(); }

  // ── Extract themes from recent reviews ───────────────────────
  // Used to make Gemini custom prompts more relevant to actual customer language
  private extractReviewThemes(reviews: Array<{ text: string; rating: number }>): string[] {
    const words = reviews
      .flatMap(r => r.text?.toLowerCase().split(/\s+/) ?? [])
      .filter(w => w.length > 4 && !/^(very|really|quite|would|could|their|there|these|those|that|this|with|have|from|they|been)$/.test(w));

    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w]) => w);
  }

  // ── Generate top insight ──────────────────────────────────────
  private generateTopInsight(
    name:          string,
    overall:       number,
    discovery:     number,
    sentiment:     number,
    trend:         string,
    delta:         number,
    platformGaps:  PlatformGap[],
    rootCauses:    RootCause[],
  ): string {
    // Critical negative sentiment — must address first
    if (sentiment < -30) {
      return `⚠️ Warning: When AI platforms mention ${name}, the language is predominantly negative (sentiment score: ${sentiment}/100). This is more damaging than not appearing at all. Identify and address the sources of negative AI language — check recent reviews and your GBP description.`;
    }

    // Improving trend
    if (trend === 'improving' && delta > 10) {
      return `📈 Strong improvement: ${name}'s AI visibility score improved by ${delta} points since last check. Your recent optimizations are working. Keep the momentum.`;
    }

    // Low discovery but high brand
    if (discovery < 20 && overall > 40) {
      return `🔍 Hidden visibility gap: ${name} appears when people search for you by name, but rarely appears when strangers search for your category. Your discovery score is ${discovery}/100 — this is the score that drives new customers. Focus on Foursquare and Yelp listings to fix this.`;
    }

    // Critical root cause
    const criticalCause = rootCauses.find(c => c.severity === 'critical');
    if (criticalCause && overall < 30) {
      return `🚨 Critical gap: ${criticalCause.issue}. ${criticalCause.evidence}`;
    }

    // Platform-specific gap
    if (platformGaps.length > 0) {
      const worst = platformGaps.sort((a, b) => a.score - b.score)[0];
      return `${name} scores ${worst.score}% on ${worst.platform} — your weakest AI platform. ${worst.primaryReason}`;
    }

    // General state
    if (overall >= 60) return `${name} has strong AI visibility (${overall}/100). You appear in ${overall}% of tracked AI recommendation queries. Focus on maintaining review volume and response rate.`;
    if (overall >= 30) return `${name} has moderate AI visibility (${overall}/100). Discovery score is ${discovery}/100 — new customers find you in ${discovery}% of relevant AI searches. Primary fix: ${rootCauses[0]?.issue ?? 'strengthen directory presence'}.`;
    return `${name} is largely invisible to AI recommendation engines (${overall}/100). Only ${discovery}% of discovery queries surface your business. ${rootCauses[0]?.evidence ?? 'Build your Foursquare and Yelp listings as the highest-impact first step.'}`;
  }

  // ── Build prioritized action list ─────────────────────────────
  private buildPrioritizedActions(
    overall:       number,
    discovery:     number,
    platformGaps:  PlatformGap[],
    rootCauses:    RootCause[],
    sentiment:     number,
    hasWebsite:    boolean | null,
  ): PrioritizedAction[] {
    const actions: PrioritizedAction[] = [];

    // Sort root causes by severity — most critical actions first
    for (const cause of rootCauses.slice(0, 3)) {
      const platform: AIPlatform | 'all' =
        cause.category === 'citations' ? 'chatgpt' :
        cause.category === 'website'   ? 'perplexity' :
        cause.category === 'gbp'       ? 'gemini' : 'all';

      actions.push({
        priority:  cause.severity === 'critical' ? 1 : cause.severity === 'high' ? 2 : 3,
        platform,
        action:    cause.issue,
        reasoning: cause.evidence,
        impact:    cause.severity === 'critical'
          ? 'Expected +20-40 points on affected platform within 4 weeks'
          : 'Expected +10-20 points within 4-8 weeks',
      });
    }

    // Platform-specific fixes
    for (const gap of platformGaps.slice(0, 2)) {
      actions.push({
        priority:  2,
        platform:  gap.platform,
        action:    gap.specificFix,
        reasoning: gap.primaryReason,
        impact:    `Expected +15-25 points on ${gap.platform}`,
      });
    }

    // Sentiment fix if negative
    if (sentiment < -20) {
      actions.push({
        priority:  1,
        platform:  'all',
        action:    'Address negative AI language by responding to negative reviews and updating your business description',
        reasoning: `Your AI sentiment score is ${sentiment}/100. AI platforms extract language from your reviews and description when formulating recommendations.`,
        impact:    'Removing negative language typically improves AI recommendations within 2-3 weeks',
      });
    }

    // De-duplicate and sort by priority
    return actions
      .filter((a, i, arr) => arr.findIndex(b => b.action === a.action) === i)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 6);
  }
}

export const aiVisibilityService = new AIVisibilityService();
