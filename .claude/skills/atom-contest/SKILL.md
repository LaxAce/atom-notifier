# Atom Contest Automation Skill

## Purpose
Participate in naming contests on atom.com autonomously. Read briefs, generate names via OpenAI, mix in premium listings when allowed, and submit 40 entries per contest.

## When to Use
Invoke with `/atom-contest` when:
- A new atom.com contest is detected (email notification or atom-notifier alert)
- User gives you a contest URL to enter
- Running the scheduled automation pipeline

---

## STEP 1 — Check for New Contests

If you don't have a contest URL already, the cron workflow picks one automatically from the atom-notifier Gist state. Or run manually:

```bash
cd /home/user/atom-notifier
node scripts/atom/run-contest.mjs [CONTEST_URL]
```

---

## STEP 2 — Parse the Contest Brief

The brief is scraped from atom.com using Playwright (bypasses Cloudflare). Key data extracted:
- **Contest title** — short description of what business/product this is for
- **Contest type** — "Company Name" or "Tagline"
- **Product description** — long-form brief (often 200-1000+ words)
- **Industry** — tech, food, health, finance, etc.
- **Style preference** — Modern? Traditional? Creative? Playful?
- **Domain extension** — .com only? .io? Any?
- **Keywords** — specific words they want included
- **Premium Domains Allowed** — Yes/No (detected from brief text)

Run `node scripts/atom/parse-brief.mjs <CONTEST_URL>` to get structured JSON output.

---

## STEP 3 — Compress Brief to AiNameIt Limits

**Hard limits:**
- Description: MAX 600 characters
- Keywords: MAX 180 characters

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

**Default to `auto` if unclear.**

---

## STEP 5 — Generate Names

**If premium domains ARE allowed:**
- Generate **35 AI names**
- Pick **5 premium listings** from `premium-listings.json`
- Submit **40 total** (5 premium first, then 35 AI)

**If premium domains are NOT allowed** (brief says "Premium Domains Allowed: No"):
- Generate **40 AI names**
- Skip premium step entirely

```bash
cd /home/user/atom-notifier
node scripts/atom/generate-names.mjs \
  --description "Your compressed brief here" \
  --keywords "keyword1,keyword2" \
  --style "auto" \
  --extension "com" \
  --count 35
```

---

## STEP 6 — Select 5 Premium Listings (only if premiumAllowed=true)

Premium listings are curated in `scripts/atom/premium-listings.json` (43 names, all .com Instant Transfer). The script scores by industry match and brief keyword overlap. Generalist names serve as fallback when no specific industry match exists.

**IMPORTANT: Never substitute AI-generated names in premium slots.** If the contest doesn't allow premium domains, generate 40 AI names instead.

```bash
node scripts/atom/select-premium.mjs \
  --brief "compressed brief here" \
  --industry "tech"
```

---

## STEP 7 — Submit 40 Entries

**Prerequisites:**
- `CONTEST_COOKIES` env var (GitHub secret) with valid atom.com session cookies
- Cookies expire! If you get auth errors, tell the user to refresh cookies from their browser

The script uses Playwright with headless Chromium. It:
1. Sets session cookies from `CONTEST_COOKIES`
2. Navigates to the contest page (waits for full React render)
3. Clicks "SUBMIT YOUR ENTRY" to open the side panel form
4. Fills the 3 "Domain Name *" slots in the form
5. Clicks Submit once per batch of 3 (atom.com limit: 3 entries per Submit click)
6. Auto-dismisses any `alert()` dialogs atom.com shows
7. Repeats until all 40 names are submitted (~14 batches)

```bash
node scripts/atom/submit-entries.mjs \
  --contest-url "https://atom.com/contest/..." \
  --names "Name1,Name2,Name3,..."
```

---

## STEP 8 — Full Orchestration

Run everything in one command:

```bash
cd /home/user/atom-notifier
node scripts/atom/run-contest.mjs "https://atom.com/contest/12345"
node scripts/atom/run-contest.mjs "https://atom.com/contest/12345" --dry-run
```

This runs steps 2-7 automatically. Output is logged to `scripts/atom/logs/`.

### Names Cache (saves OpenAI + RapidAPI costs)

After the first run for a contest, generated names are saved to `scripts/atom/logs/names-cache.json` keyed by contest ID. Every subsequent run for the same contest skips OpenAI and RapidAPI entirely and reuses the cached names.

- Cache key = numeric contest ID from the URL (e.g. `34701`)
- To force fresh name generation: delete that contest's entry from `names-cache.json`
- Cache persists across GitHub Actions runs via the logs directory

---

## Environment Variables Required

Set as GitHub Actions secrets (in the `atom-contest.yml` workflow):

```
OPENAI_API_KEY=        # OpenAI API key
OPENAI_MODEL=          # e.g. gpt-4o-mini or gpt-4o
RAPIDAPI_KEY=          # RapidAPI key for domain checker
RAPIDAPI_HOST=         # RapidAPI host
DOMAIN_CHECKER_URL=    # Domain checker endpoint
CONTEST_COOKIES=       # atom.com session cookies (copy from browser DevTools)
CONTEST_URL=           # atom.com contest listing URL
GIST_ID=               # GitHub Gist ID for shared state
GIST_TOKEN=            # GitHub token with gist scope
GIST_NAME=             # Gist filename for contest state
```

**Getting CONTEST_COOKIES:**
1. Log in to atom.com in Chrome
2. Open DevTools → Network tab
3. Refresh the page
4. Click any request → Headers → copy the Cookie header value
5. Set as `CONTEST_COOKIES` secret in GitHub Actions

---

## Premium Listings Cache

File: `scripts/atom/premium-listings.json` (43 manually curated entries)

Format:
```json
{
  "names": [
    { "name": "ExampleName", "domain": "ExampleName.com", "style": "brandable", "industry": ["tech", "general"] }
  ]
}
```

**There is no price field** — the filter in `select-premium.mjs` must never filter by price.

To add new domains: edit `premium-listings.json` manually. There is no auto-sync script — do not create one, as it would overwrite the curated industry tags.

---

## Monitoring & Logs

- Each run logs to `scripts/atom/logs/YYYY-MM-DD-HH-MM.json`
- Log contains: contest URL, brief, names generated, names submitted, success/failure per name
- Check logs for any failed submissions and re-run if needed

---

## Contest Quality Tips (from $500+ in winnings)

1. **Short names win** — 5-8 chars beats long names almost always
2. **Easy to pronounce** — if you can't say it in one breath, skip it
3. **Domain matters** — .com is king; .io is acceptable for tech
4. **AUTO style** — covers all bases, use for 80% of contests
5. **Brandable over descriptive** — atom.com clients love Google/Slack-style names

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not authenticate" on atom.com | Refresh `CONTEST_COOKIES` secret from browser |
| Domain checker 429 errors | Too many calls; skip domain check with `--no-domains` |
| OpenAI rate limit | Add delay between batches; already handled in script |
| Contest already entered | Script checks for duplicate submissions before submitting |
| Brief scraping fails 403 | Cloudflare blocked IP — cookies may be expired; refresh `CONTEST_COOKIES` |
| "Sorry, this contest is not accepting Premium" | Brief detection missed the "No" — script should have generated 40 AI names; check `premiumAllowed` in logs |
| Form input not found | atom.com UI changed; update selectors in `submit-entries.mjs` |
| Workflow timed out at submission | atom.com showed an alert dialog — old code hung; fixed in current version with `page.on('dialog')` handler |
| 0 entries submitted | Check logs for "Dialog:" lines; if missing, the Submit button selector may need updating |
