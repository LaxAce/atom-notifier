# Atom Contest Automation Skill

## Purpose
Participate in naming contests on atom.com autonomously. Read briefs, generate names using AiNameIt's OpenAI logic, mix in premium listings, and submit 40 entries per contest.

## When to Use
Invoke with `/atom-contest` when:
- A new atom.com contest is detected (email notification or atom-notifier alert)
- User gives you a contest URL to enter
- Running the scheduled automation pipeline

---

## STEP 1 — Check for New Contests

If you don't have a contest URL already:

```bash
cd /home/user/laxace/atom-notifier
node -e "
const axios = require('axios');
(async () => {
  const r = await axios.get(process.env.CONTEST_URL, {
    headers: { Cookie: process.env.CONTEST_COOKIES, 'User-Agent': 'Mozilla/5.0' }
  });
  const m = r.data.match(/<ul class=\"content pull-left watching_contests\">\s*<li[^>]*data-contest-id=\"([^\"]+)\"[^>]*>[\s\S]*?<a href=\"([^\"]+)\">/);
  console.log(JSON.stringify({ id: m?.[1], url: 'https://atom.com' + m?.[2] }));
})();
" 2>/dev/null
```

Or just run the automation script directly:
```bash
cd /home/user/ai-name-it
node scripts/atom/run-contest.mjs [CONTEST_URL]
```

---

## STEP 2 — Parse the Contest Brief

The brief is scraped from atom.com with your session cookies. Key data to extract:
- **Contest title** — short description of what business/product this is for
- **Contest type** — "Company Name" or "Tagline"
- **Product description** — long-form brief (often 200-1000+ words)
- **Industry** — tech, food, health, finance, etc.
- **Style preference** — Modern? Traditional? Creative? Playful?
- **Domain extension** — .com only? .io? Any?
- **Keywords** — any specific words they want included
- **Do NOT include** words — blacklist

Run `node scripts/atom/parse-brief.mjs <CONTEST_URL>` to get structured JSON output.

---

## STEP 3 — Compress Brief to AiNameIt Limits

**Hard limits:**
- Description: MAX 600 characters
- Keywords: MAX 180 characters

**Compression rules:**
1. Extract the single most important sentence about what the business does
2. Add the target audience in 5-10 words
3. Add the core brand values in 5 words
4. Total ≤ 600 chars

Example compression:
> "We are a B2B SaaS company helping mid-market CFOs automate accounts receivable reconciliation with AI-powered invoice matching, reducing DSO by 40% and eliminating manual data entry across ERPs including SAP and NetSuite." 
→
> "B2B SaaS platform helping CFOs automate accounts receivable reconciliation using AI. Reduces manual work, integrates with SAP/NetSuite. Targets mid-market finance teams. Values: efficiency, accuracy, simplicity."

---

## STEP 4 — Determine Name Style

Map what the contest brief asks for → AiNameIt style:

| Contest says | Use style |
|---|---|
| Modern, Tech, AI, SaaS, Startup | `auto` or `brandable_names` |
| Traditional, Professional, Law, Finance | `real_words` or `compound` |
| Creative, Fun, Playful | `blends` or `creative_spelling` |
| Global, International | `non_english_words` |
| Descriptive, Clear | `compound` or `real_words` |
| Minimal, Short | `brandable_names` |
| Catchy tagline (if tagline contest) | `short_phrase` |

**Default to `auto` if unclear.** The AUTO style produces a mix of all styles.

**Style → name length + word count rules:**
| Style | Max chars | Max words |
|---|---|---|
| auto | 12 | 2 |
| compound | 12 | 2 |
| brandable_names | 8 | 1 |
| blends | 10 | 2 |
| creative_spelling | 8 | 2 |
| non_english_words | 7 | 1 |
| real_words | 8 | 1 |
| short_phrase | 15 | 3 |

---

## STEP 5 — Generate 35 Names

Run the name generator directly (bypasses AiNameIt UI, auth, and credit system):

```bash
cd /home/user/ai-name-it
node scripts/atom/generate-names.mjs \
  --description "Your compressed brief here" \
  --keywords "keyword1,keyword2" \
  --style "auto" \
  --extension "com" \
  --count 35
```

This calls OpenAI directly with the same prompt as AiNameIt, then checks domain availability via RapidAPI. Generates 60 names, filters to available ones, returns top 35.

**Critical:** The script reads env vars from `.env.atom` (create from `.env.atom.example`).

**Domain check budget awareness:**
- RapidAPI domain checker: check current usage before running
- Each "requireDomains=true" run uses ~60 API calls (1 per name per extension)
- If near monthly limit, set `--no-domains` flag to skip domain checking

---

## STEP 6 — Select 5 Premium Listings

Premium listings are cached in `scripts/atom/premium-listings.json`. Pick the 5 most relevant to the contest brief:

1. Read the premium listings file
2. For each premium name, score relevance (does it fit the industry/style?)
3. Pick top 5

```bash
node scripts/atom/select-premium.mjs \
  --brief "compressed brief here" \
  --industry "tech"
```

If no good match exists, generate 5 more names to fill the gap.

---

## STEP 7 — Submit 40 Entries

**Prerequisites:**
- `ATOM_COOKIES` env var must be set with valid atom.com session cookies
- Cookies expire! If you get auth errors, tell the user to refresh cookies from their browser

```bash
node scripts/atom/submit-entries.mjs \
  --contest-url "https://atom.com/contest/..." \
  --names "Name1,Name2,Name3,..."
```

The script uses Playwright with headless Chromium. It:
1. Sets session cookies
2. Navigates to the contest page
3. Finds the "Submit Entry" form
4. Submits each name with a 1-2 second delay between entries
5. Logs success/failure for each name

**Rate: submit ~5 names/minute to avoid rate limiting.**

---

## STEP 8 — Full Orchestration

Run everything in one command:

```bash
cd /home/user/ai-name-it
node scripts/atom/run-contest.mjs "https://atom.com/contest/12345"
```

This runs steps 2-7 automatically. Output is logged to `scripts/atom/logs/`.

---

## Environment Variables Required

Create `scripts/atom/.env.atom` from `scripts/atom/.env.atom.example`:

```
PENAI_API_KEY=        # OpenAI API key (note: PENAI not OPENAI - typo in codebase)
OPENAI_MODEL=         # e.g. gpt-4o-mini or gpt-4o
RAPIDAPI_KEY=         # RapidAPI key for domain checker
RAPIDAPI_HOST=        # RapidAPI host
DOMAIN_CHECKER_URL=   # Domain checker endpoint
ATOM_COOKIES=         # atom.com session cookies (copy from browser DevTools)
```

**Getting ATOM_COOKIES:**
1. Log in to atom.com in Chrome
2. Open DevTools → Network tab
3. Refresh the page
4. Click any request → Headers → copy the Cookie header value
5. Paste as `ATOM_COOKIES=<value>`

---

## Premium Listings Cache

File: `scripts/atom/premium-listings.json`

User must populate this manually. Format:
```json
{
  "names": [
    { "name": "ExampleName", "industry": "tech", "style": "brandable", "price": 1500 },
    ...
  ],
  "lastUpdated": "2024-01-01"
}
```

To refresh from atom.com:
```bash
node scripts/atom/fetch-premium-listings.mjs
```
(Requires ATOM_COOKIES to be set)

---

## Monitoring & Logs

- Each run logs to `scripts/atom/logs/YYYY-MM-DD-HH-MM.json`
- Log contains: contest URL, brief, names generated, names submitted, success rate
- Check logs for any failed submissions and re-run if needed

---

## Contest Quality Tips (from $500+ in winnings)

1. **Short names win** — 5-8 chars beats long names almost always
2. **Easy to pronounce** — if you can't say it in one breath, skip it
3. **Domain matters** — .com is king; .io is acceptable for tech
4. **AUTO style** — covers all bases, use for 80% of contests
5. **Brandable over descriptive** — atom.com clients love Google/Slack-style names
6. **Watch recent winners** — run `node scripts/atom/check-winners.mjs` monthly to calibrate

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not authenticate" on atom.com | Refresh ATOM_COOKIES from browser |
| Domain checker 429 errors | Too many calls; skip domain check with `--no-domains` |
| OpenAI rate limit | Add delay between batches; already handled in script |
| Contest already entered | Script checks for duplicate submissions before submitting |
| Brief scraping fails | atom.com HTML structure changed; update selectors in parse-brief.mjs |
