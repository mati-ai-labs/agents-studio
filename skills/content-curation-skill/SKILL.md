---
name: content-curation-skill
description: >
  Research, extract, and synthesize winning content ideas from 15+ sources
  (Meta Ads Library, TikTok, Pinterest, Reddit, Amazon, YouTube, Google Trends,
  Quora, competitor pages, newsletters, Instagram, Twitter, podcasts) to generate
  creative briefs for carousel ad creation. Produces hook libraries, CTA patterns,
  visual direction guides, and 10 full slide-by-slide carousel concepts.
compatibility: >
  Claude Code with bash, web search, and file I/O. Meta Ads connector recommended
  for the Meta Ads Library source. SearchAPI key optional for Meta Ads Library.
metadata:
  role: marketing_content_curator
  version: "3.0.0"
  skill_key: content-curation-skill
---

# Skill: `carousel_content_intelligence`

**Version:** 3.0.0
**Purpose:** Research, extract, and synthesize winning content ideas from 15+ sources to generate a creative brief for carousel ad creation.
**Agent:** Claude Code (or any agentic coding assistant with bash, web search, and file I/O capabilities)

---

## Input

```json
{
  "product_idea": "string (required) — what you're selling",
  "target_audience": "string (optional) — who buys it, their pain points",
  "geo_markets": ["array of country codes (default: ['US'])"],
  "content_pillars": ["array (optional) — angles to prioritize: e.g. ['pain_point', 'social_proof', 'education', 'comparison']"],
  "max_carousel_concepts": "integer (default: 10)",
  "sources": {
    "meta_ads_library": true,
    "tiktok_creative_center": true,
    "pinterest_trends": true,
    "reddit_discussions": true,
    "amazon_reviews": true,
    "youtube_comments": true,
    "google_trends": true,
    "quora_questions": true,
    "g2_capterra": false,
    "competitor_landing_pages": true,
    "newsletter_spy": true,
    "app_store_reviews": false,
    "instagram_hashtag": true,
    "twitter_threads": true,
    "podcast_titles": false
  },
  "searchapi_key": "string (optional — required if meta_ads_library enabled)",
  "output_format": "enum: json | markdown (default: json)"
}
```

---

## Output

1. **`creative_brief.json`** — Full structured data with all research, patterns, and 10 carousel concepts.
2. **`carousel_concepts.md`** — Human-readable version of the 10 concepts with slide-by-slide breakdowns.
3. **`competitor_assets/`** — Directory of downloaded reference images, thumbnails, and screenshots.
4. **`hook_swipe_file.txt`** — Plain text list of all hooks, one per line.

---

## Execution Flow

### Phase 1: Competitor Discovery

**Goal:** Build a list of 5-10 direct and adjacent competitors.

**Actions:**

1. Run web searches for:
   - `top {product_idea} brands 2026`
   - `{product_idea} competitors facebook instagram ads`
   - `best {product_idea} DTC brands`
   - `{product_idea} alternatives reddit`

2. From results, extract:
   - Brand names
   - Domains
   - Social handles (Instagram, TikTok)
   - Amazon storefront names
   - Subreddit names where discussed

3. Categorize competitors by positioning:
   - **Direct:** Same product, same price range
   - **Premium anchor:** 2-3x your price (use for "luxury alternative" angles)
   - **Budget anchor:** 0.5x your price (use for "no compromise" angles)
   - **Adjacent:** Solves same problem differently

4. Save competitor list to working memory for Phase 2.

---

### Phase 2: Multi-Source Content Raid

#### Source A: Meta Ads Library (SearchAPI.io)

**When to use:** If `searchapi_key` is provided. This is the highest-quality source for actual converting ad creative.

**Steps:**

1. Find competitor Page IDs using SearchAPI.io page search engine:
   ```bash
   curl "https://www.searchapi.io/api/v1/search?engine=meta_ad_library_page_search&q={BRAND_NAME}&api_key={KEY}"
   ```
   Extract `page_id` from the first result.

2. Fetch active ads using the meta_ad_library engine:
   ```bash
   curl "https://www.searchapi.io/api/v1/search?engine=meta_ad_library&page_id={PAGE_ID}&country={GEO}&ad_type=all&media_type=all&api_key={KEY}"
   ```
   Paginate using `next_page_token` until you have 20-50 ads per competitor.

3. For each ad, extract:
   - `snapshot.caption` — body copy, hook patterns
   - `snapshot.cta_text` — CTA buttons ("Shop Now", "Learn More", "Sign Up")
   - `snapshot.display_format` — IMAGE, VIDEO, CAROUSEL
   - `snapshot.videos[].video_preview_image_url` — thumbnail reference
   - `start_date` / `end_date` — longer run = likely winning
   - `publisher_platform` — INSTAGRAM, FACEBOOK, MESSENGER

4. Pattern extraction:
   - Group ads by `display_format`. Focus on CAROUSEL and IMAGE ads.
   - For CAROUSEL ads: note the `link_url` (landing page) to infer slide sequencing.
   - Extract the first sentence of every caption — this is the hook library.
   - Count CTA frequency — rank by popularity.

5. Download video thumbnails:
   ```bash
   curl -o {BRAND}_{AD_ID}.jpg "{VIDEO_PREVIEW_URL}"
   ```
   Save to `competitor_assets/`.

---

#### Source B: TikTok Creative Center / TikTok Ads Library

**When to use:** If product has visual/demo potential (physical products, transformations, before/after).

**Steps:**

1. Search for:
   - `{product_idea} tiktok ads examples`
   - `{competitor_name} tiktok ad creative`
   - `top performing tiktok ads {niche} 2026`

2. Visit `https://ads.tiktok.com/business/creativecenter` and search by industry category and region. Filter by "High CTR" or "High conversion".

3. Extract:
   - Top 5 video hooks (first 3 seconds text overlay)
   - Music trends used (note song names/tempos)
   - Transition styles (jump cuts, morphs, split screen)
   - Text overlay density (how much text per frame)

4. For carousel adaptation:
   - TikTok's first 3 seconds = carousel Slide 1
   - TikTok's problem setup = carousel Slide 2
   - TikTok's product reveal = carousel Slide 3
   - TikTok's proof/UGC = carousel Slide 4
   - TikTok's CTA = carousel Slide 5

---

#### Source C: Pinterest Trends & Popular Pins

**When to use:** For visual aesthetic, color palettes, layout inspiration, and "mood" of the niche.

**Steps:**

1. Search for:
   - `site:pinterest.com {product_idea} aesthetic`
   - `{product_idea} pinterest trending 2026`
   - `pinterest trends {niche} color palette`

2. Visit `https://trends.pinterest.com/` and search niche keywords. Note rising search terms (these are consumer pain points/desires).

3. Extract:
   - Dominant color schemes (save hex codes if visible)
   - Typography styles (serif vs sans, bold vs thin)
   - Image composition (product-centered vs lifestyle)
   - Text-to-image ratio (how much copy on the pin)

4. For carousel adaptation:
   - Pinterest's vertical 2:3 ratio = carousel 4:5 ratio adaptation
   - Pinterest's text overlay style = carousel text treatment
   - Pinterest's "save-worthy" hooks = carousel curiosity hooks

---

#### Source D: Reddit Discussions (Pain Point Mining)

**When to use:** ALWAYS. Reddit is the best source for authentic pain points, objections, and language.

**Steps:**

1. Search for:
   - `reddit {product_idea} worth it`
   - `reddit {product_idea} problems issues`
   - `reddit best {product_idea} recommendation`
   - `reddit {product_idea} vs {competitor}`

2. Visit top 5-10 Reddit threads.

3. Extract:
   - **Pain points:** What do people complain about with current solutions?
   - **Objections:** "Too expensive", "doesn't work for tall people", "assembly nightmare"
   - **Aha moments:** What made someone finally buy?
   - **Language:** Exact phrases, slang, emoji usage, caps lock emphasis
   - **Comparison points:** How do they compare alternatives?

4. For carousel adaptation:
   - Pain points = Slide 2 (Problem agitation)
   - Objections = Address in Slide 3 or 4 (preemptive counter)
   - Exact Reddit quotes = Slide 4 (Social proof / "real people say")
   - Language patterns = Copy tone for all slides

---

#### Source E: Amazon Reviews (Review Mining)

**When to use:** If product is physical / e-commerce. Skip for SaaS.

**Steps:**

1. Search for:
   - `site:amazon.com {product_idea} reviews`
   - `{competitor_name} amazon review complaints`

2. Visit Amazon product pages for top 3 competitors.

3. Read:
   - 5-star reviews: What do people LOVE? (use for benefits)
   - 3-star reviews: What do people wish was better? (use for differentiation)
   - 1-star reviews: What broke? (use for objection handling)

4. Extract:
   - Most common praise phrases (frequency count)
   - Most common complaint phrases
   - "Verified Purchase" language (authenticity markers)
   - Photo review descriptions (visual proof)

5. For carousel adaptation:
   - Top praise phrases = benefit bullets on Slide 3
   - Top complaints + your fix = "Unlike others, we..." on Slide 3
   - "Verified Purchase" style = trust badges on Slide 5

---

#### Source F: YouTube Comments & Video Titles

**When to use:** For educational/authority angles, tutorial-style carousels.

**Steps:**

1. Search for:
   - `youtube {product_idea} review 2026`
   - `{product_idea} unboxing first impressions`
   - `best {product_idea} honest review`

2. Visit top 5 YouTube videos.

3. Extract from video titles:
   - Hook formulas ("I tried X for 30 days", "Honest review of X", "X vs Y")
   - Number patterns ("5 things I wish I knew", "Top 3 mistakes")
   - Timeframes ("30 days", "1 year later", "first week")

4. Extract from comments:
   - Top questions (what do people want to know?)
   - Emotional reactions ("This changed my life", "Waste of money")
   - Feature requests (what's missing?)

5. For carousel adaptation:
   - Video title formulas = carousel title/hook variations
   - Top questions = FAQ carousel concept (7-slide educational)
   - Emotional reactions = testimonial slide content

---

#### Source G: Google Trends & AlsoAsked

**When to use:** For hook ideas based on what people are actually searching.

**Steps:**

1. Visit `https://trends.google.com/trends/explore`. Search `{product_idea}`, filter by geo and time (past 12 months).

2. Extract:
   - Rising queries (what's spiking?)
   - Related queries (what else do they search?)
   - Seasonality (when does interest peak?)

3. Visit `https://alsoasked.com/`. Enter seed keyword. Download question map.

4. Extract:
   - Question-based hooks ("How do I...", "Why does...", "Is it worth...")
   - Pre-vs-post comparison questions
   - Price-related questions

5. For carousel adaptation:
   - Rising queries = trending angle for Slide 1 hook
   - AlsoAsked questions = "Did you know?" educational slides
   - Seasonality = timing recommendation for ad launch

---

#### Source H: Quora Questions

**When to use:** For authority/educational carousel concepts.

**Steps:**

1. Search for:
   - `site:quora.com {product_idea} worth buying`
   - `site:quora.com best {product_idea} recommendation`

2. Extract:
   - Most-viewed questions (high interest = high relevance)
   - Top answer structures (how do experts explain it?)
   - Objections framed as questions ("Is X a scam?")

3. For carousel adaptation:
   - Quora questions = carousel Slide 1 ("Is [product idea] worth it?")
   - Expert answer structures = educational carousel flow
   - "Scam" objections = trust-building slide content

---

#### Source I: Competitor Landing Pages

**When to use:** ALWAYS. Landing pages reveal their highest-converting messaging.

**Steps:**

1. Search for:
   - `{competitor_name} landing page`
   - `{product_idea} buy now official site`

2. Visit top 3 competitor landing pages.

3. Extract:
   - **Above the fold:** Headline, subheadline, CTA button text
   - **Benefit section:** How do they list benefits? (bullet points, icons, images)
   - **Social proof:** Reviews, trust badges, media logos, user counts
   - **Urgency/scarcity:** Countdown timers, stock alerts, limited offers
   - **FAQ section:** What objections do they address?
   - **Footer:** Guarantees, return policies, shipping info

4. For carousel adaptation:
   - Landing page headline = Slide 1 hook
   - Benefit bullets = Slide 3 feature callouts
   - Social proof section = Slide 4 proof
   - FAQ objections = preemptive content in Slide 2-3
   - Urgency elements = Slide 5 CTA urgency

---

#### Source J: Newsletter Spy (SparkToro / Newsletter directories)

**When to use:** For copy tone, subject line hooks, and long-form storytelling.

**Steps:**

1. Search for:
   - `{product_idea} newsletter subscribe`
   - `sparktoro audience intelligence {niche}`

2. Subscribe to 2-3 competitor newsletters (if possible) or search archive sites.

3. Extract:
   - Subject line formulas (curiosity, urgency, benefit-driven)
   - Opening hooks (first sentence of email)
   - Storytelling structure (problem → struggle → solution → offer)
   - CTA placement (where do they ask for the sale?)

4. For carousel adaptation:
   - Subject lines = carousel Slide 1 text variations
   - Email opening hooks = carousel narrative flow
   - Story structure = 7-slide storytelling carousel

---

#### Source K: Instagram Hashtag & Explore Page

**When to use:** For visual trends, influencer content, and UGC patterns.

**Steps:**

1. Search for:
   - `instagram {product_idea} reels trending`
   - `#{product_idea} instagram posts popular`

2. Extract:
   - Top-performing post formats (single vs carousel vs reel)
   - Caption hooks (first line before "more")
   - Hashtag clusters (what tags do competitors use?)
   - Influencer content style (polished vs UGC vs meme)

3. For carousel adaptation:
   - Carousel post structures on Instagram = your direct template
   - Caption hooks = Slide 1 text
   - UGC style = visual direction for authentic look
   - Hashtag clusters = ad targeting interest suggestions

---

#### Source L: Twitter/X Threads & Discussions

**When to use:** For contrarian angles, hot takes, and meme potential.

**Steps:**

1. Search for:
   - `twitter {product_idea} review`
   - `x.com {product_idea} worth it`
   - `{product_idea} meme twitter`

2. Extract:
   - Viral tweet formats (list threads, "hot takes", "unpopular opinion")
   - Meme formats relevant to niche
   - Complaint threads (what frustrates people?)
   - "Day in the life" content (usage scenarios)

3. For carousel adaptation:
   - List threads = "5 reasons why..." carousel
   - Hot takes = contrarian Slide 1 ("Stop buying X. Do this instead.")
   - Meme formats = relatable humor slides (if brand voice allows)
   - Complaint threads = problem-agitation slides

---

#### Source M: Podcast Episode Titles & Show Notes

**When to use:** For long-form storytelling and authority positioning.

**Steps:**

1. Search for:
   - `{product_idea} podcast episode`
   - `best podcasts {niche} 2026`

2. Extract:
   - Episode title formulas (question-based, number-based, story-based)
   - Guest expertise angles (what credentials do they cite?)
   - Show note structures (how do they summarize value?)

3. For carousel adaptation:
   - Episode titles = carousel concept titles
   - Expert credentials = authority slide content ("As seen on...")
   - Show note value props = benefit bullets

---

### Phase 3: Synthesis & Pattern Recognition

**Goal:** Turn raw data from all active sources into actionable creative patterns.

**Actions:**

1. **Create a master hook bank:**
   - Collect every opening line from all sources.
   - Categorize by type:
     - **Pain-point:** "Tired of...", "Sick of...", "Stop doing..."
     - **Curiosity:** "This changed everything...", "The real reason...", "What nobody tells you..."
     - **Social proof:** "300,000 people...", "Voted #1 by...", "The chair editors love..."
     - **Urgency:** "Only 47 left...", "Sale ends...", "Last batch..."
     - **Contrarian:** "Stop buying X...", "Why I returned...", "Overrated: X. Underrated: Y"
     - **Educational:** "5 mistakes...", "How to...", "The science behind..."

2. **Create a CTA pattern bank:**
   - Collect every CTA from all sources.
   - Categorize by intent:
     - **Direct sale:** "Shop Now", "Buy Now", "Get Yours"
     - **Risk reversal:** "Try Free", "45-Day Trial", "See If You Qualify"
     - **Education:** "Learn More", "Watch Demo", "How It Works"
     - **Scarcity:** "Claim Before Sold Out", "Get 30% Off", "Join Waitlist"

3. **Create a visual direction guide:**
   - From Pinterest, Instagram, TikTok, Meta ad thumbnails:
     - Dominant color palettes (list hex codes if extractable)
     - Font styles (bold sans-serif, elegant serif, playful script)
     - Image ratios (4:5 feed, 9:16 Reels, 1:1 square)
     - Text density (minimal vs information-heavy)
     - Background types (solid color, gradient, lifestyle photo, product cutout)

4. **Create a slide sequencing library:**
   - **5-slide conversion:** Hook → Problem → Solution → Proof → CTA
   - **7-slide education:** Hook → Myth → Truth → Feature → Proof → Offer → CTA
   - **10-slide story:** Hook → Struggle → Discovery → First Try → Results → Comparison → Objection → Guarantee → Urgency → CTA
   - **3-slide teaser:** Hook → Product → CTA (for retargeting)

5. **Create a content pillar matrix:**
   - Map each source's best content to a pillar:
     - **Pain point:** Reddit complaints + Amazon 1-star reviews
     - **Social proof:** Meta ads + Amazon 5-star + YouTube comments
     - **Education:** Quora + AlsoAsked + Google Trends
     - **Comparison:** Reddit vs threads + G2 pros/cons
     - **Aspirational:** Pinterest + Instagram + TikTok aesthetic

---

### Phase 4: Carousel Concept Generation

**Goal:** Generate 10 distinct carousel concepts, each with a full slide-by-slide brief.

For each concept, define:

1. **Concept Name:** e.g., "Pain-Point Punch", "Social Proof Stack", "Myth Buster"

2. **Hook Strategy:** Which source inspired it? (e.g., "Reddit complaint #1")

3. **Slide-by-Slide Breakdown:**
   - Slide 1: Hook text + visual direction + color note
   - Slide 2: Problem / Context + visual direction
   - Slide 3: Solution / Product + visual direction
   - Slide 4: Proof / Social + visual direction
   - Slide 5: CTA / Offer + visual direction

4. **Copy Tone:** (conversational, authoritative, playful, urgent, empathetic)

5. **Visual References:** Which downloaded asset or Pinterest pin inspired it?

6. **Source Attribution:** Which research source is this based on?

---

### Phase 5: Output Packaging

**Generate these files:**

1. **`creative_brief.json`** — Full structured data:
   - competitor_analysis
   - hook_library (categorized)
   - cta_library (categorized)
   - visual_direction_guide
   - content_pillar_matrix
   - carousel_concepts (10 concepts, slide-by-slide)
   - source_attribution (which data came from where)
   - files_manifest

2. **`carousel_concepts.md`** — Human-readable version of the 10 concepts with visual descriptions.

3. **`competitor_assets/`** — Directory containing:
   - Meta ad thumbnails (from SearchAPI.io)
   - Pinterest reference images
   - Instagram screenshot references
   - Any downloaded video thumbnails

4. **`hook_swipe_file.txt`** — Plain text list of all hooks, one per line, ready to copy-paste.

---

### Phase 6: Handoff to Carousel Generation Agent

Include in the brief:

```json
{
  "next_agent_instructions": {
    "role": "carousel_designer",
    "input_files": [
      "creative_brief.json",
      "competitor_assets/"
    ],
    "task": "Generate 10 carousel image sets based on the concepts in creative_brief.json",
    "specs": {
      "feed_carousel": "1080x1350px (4:5)",
      "reels_carousel": "1080x1920px (9:16)",
      "format": "PNG or MP4 per slide",
      "fonts": "Reference visual_direction_guide.fonts",
      "colors": "Reference visual_direction_guide.palettes"
    },
    "priority_concepts": ["001", "003", "007"]
  }
}
```

---

## Error Handling & Fallbacks

| Scenario | Fallback |
|----------|----------|
| SearchAPI.io key missing or invalid | Skip Meta Ads. Double down on Reddit + Amazon + Pinterest |
| No competitors found in niche | Search adjacent niches. E.g., "ergonomic chair" → "home office setup" → "back pain relief" |
| Pinterest/Instagram blocked | Use image search for `{niche} aesthetic` and `{niche} moodboard` |
| Reddit threads are sparse | Search Quora + Twitter + Amazon reviews for equivalent pain points |
| No video content on TikTok | Focus on static carousel concepts from Meta + Pinterest |
| Competitor landing pages are minimal | Use G2/Capterra or App Store reviews for messaging |
| All sources return generic content | Force contrarian angle: "Why [common advice] is wrong" |

---

## Example Invocation

```json
{
  "skill": "carousel_content_intelligence",
  "input": {
    "product_idea": "AI-powered ergonomic office chair with posture sensors and auto-adjust lumbar, under $400",
    "target_audience": "Remote workers and gamers 25-40, back pain sufferers, tall people frustrated with one-size-fits-all chairs",
    "geo_markets": ["US", "GB", "CA"],
    "content_pillars": ["pain_point", "social_proof", "comparison", "education"],
    "max_carousel_concepts": 10,
    "sources": {
      "meta_ads_library": true,
      "tiktok_creative_center": true,
      "pinterest_trends": true,
      "reddit_discussions": true,
      "amazon_reviews": true,
      "youtube_comments": true,
      "google_trends": true,
      "quora_questions": true,
      "competitor_landing_pages": true,
      "instagram_hashtag": true,
      "twitter_threads": true
    },
    "searchapi_key": "sai_xxxxxxxxxxxxxxxx",
    "output_format": "json"
  }
}
```
