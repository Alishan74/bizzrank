# Review Intelligence — installation

Gemini-powered theme extraction from customer reviews. Surfaces what
customers consistently praise and complain about as actionable themes.

## What this delivers

  - A single Gemini call per business per week extracts up to 5 positive themes,
    5 negative themes, and 3 emerging themes (new in last 30 days).
  - One-line headline summary: "Customers consistently praise X but complain about Y."
  - Overall sentiment + trending direction (improving / stable / declining).
  - Cached in DB (TTL 7 days), force-refreshable on demand.

## Files

  migration/004-review-intelligence.sql                              new table
  apps/api/src/domains/reviews/ReviewIntelligenceService.ts          main logic
  apps/api/src/api/routes/reviewIntelligence.ts                      2 endpoints
  apps/frontend/src/components/ReviewIntelligence/ReviewIntelligencePanel.tsx  UI

## Apply

### 1. SQL migration
Supabase SQL Editor → paste contents of migration/004-review-intelligence.sql → Run.
Verify:
    select count(*) from public.review_intelligence;   -- 0 initially

### 2. Extract files
    cd /workspaces/bizzrank/bizzrank-v10
    unzip -o bizzrank-review-intelligence.zip

### 3. Mount the route
In apps/api/src/index.ts (or server.ts):

    import reviewIntelRoutes from './api/routes/reviewIntelligence.js';
    app.use('/api/review-intelligence', reviewIntelRoutes);

### 4. Add weekly cron (recommended)
In the same file where other crons live (next to the briefing cron):

    import { reviewIntelligenceService } from './domains/reviews/ReviewIntelligenceService.js';

    // Every Sunday 02:00 UTC — refresh all businesses
    cron.schedule('0 2 * * 0', () => {
      reviewIntelligenceService.runWeeklyRefresh().catch(err =>
        logger.error('[ReviewIntel] Weekly refresh error', { error: err.message })
      );
    });

### 5. Add the panel to your Reviews page
In apps/frontend/src/pages/Reviews.tsx — at the top of the page above the review list:

    import ReviewIntelligencePanel from '../components/ReviewIntelligence/ReviewIntelligencePanel';

    // inside your component, where you have the selected businessId:
    <ReviewIntelligencePanel businessId={selectedBusinessId} />

### 6. Restart the API
    npm run dev

## Smoke test

  1. Pick a business with at least 3 reviews in your DB.
  2. Open Reviews page → the panel appears, says "Analyzing reviews…"
  3. Within 5-10 seconds it renders the panel with positive + negative themes.
  4. Watch the API terminal for:
       [ReviewIntel] Saved { businessId: '...', reviewsAnalyzed: N, positives: 5, negatives: 5 }

## What you'll see

A 3-row card on the Reviews page:

  Row 1 — Headline band:
    "Overall positive · ↗ improving · Customers consistently praise your
    friendly staff but complain about wait times during peak hours."
    Refresh button (icon).

  Row 2 — Two columns:
    Left: "What customers love" — 5 positive themes with mention counts + example
    Right: "What they complain about" — 5 negative themes same format

  Row 3 (if applicable):
    "Emerging in last 30 days" — chips for new themes appearing recently

## Cost

  - Gemini Flash call: ~$0.001 per business per week
  - At 500 businesses × 52 weeks = 26,000 calls/year = ~$26/year total
  - Effectively free

## How to integrate with the briefing

In BriefingService, you can read review_intelligence.summary and inject the
sentiment one-liner into the briefing prose. Look for the buildPrompt() method
and add this near the top of the metrics block:

    `Review intelligence: ${reviewIntel?.summary ?? 'no review themes yet'}`

This makes the morning briefing reference what customers are saying ("today's
reviews echo what we've seen all month — customers love the friendly staff
but the wait-times complaints keep coming") which is the kind of synthesis
no other tool does.

## What's not in this delivery

  - Per-theme drill-down (showing all reviews matching a theme) — easy follow-up
  - Theme trend over time (this week's "wait times" mentions vs last month) —
    requires keeping historical analyses; not in v1
  - Direct action buttons ("create review-request campaign about parking") —
    will plug into Opportunity Engine when that ships

## Notes for the next features

Review Intelligence is foundational data for the Opportunity Engine you're
building next. The negative themes become "fix opportunities", the trending-down
direction becomes a "recovery plan trigger", and the emerging themes become
"watch list" items. Keep this schema stable; the Engine will read from it.
