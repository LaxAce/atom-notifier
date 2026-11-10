import OpenAI from "openai";
import axios from "axios";
import { readFileSync, existsSync } from "fs";
import path from "path";

const envFile = path.join(__dirname, ".env.atom");
if (existsSync(envFile)) {
    const lines = readFileSync(envFile, "utf8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...rest] = trimmed.split("=");
        if (key && rest.length && !process.env[key]) process.env[key] = rest.join("=");
    }
}

export const STYLES: Record<string, string> = {
    auto: "Mix: 30% Compound (two real words joined, e.g. HealZone, CoreRenew, BrightSpin, ThermaBreeze, StriveHive, Daybridge), 25% Blends (two real concepts merged, e.g. Meritvita, Wellmora, Primeborn, Tracestorm), 20% Brand-able from real roots (e.g. Pettle, Nexevel, Atrelio, Clinipal, Jitless, Nuaxo), 15% Real words used as brand (e.g. Thriving, Matter, Sparring, Portico), 10% Creative spelling of real words (e.g. Pennyz, Piiqe, Spexo)",
    blends: "Blends of two real concepts or word roots, e.g. Meritvita (merit+vita), Wellmora (well+mora), Tracestorm (trace+storm), Cymbathera (cymba+therapy), Melomont (mellow+mont)",
    compound: "Two real words joined cleanly, e.g. HealZone, CoreRenew, BrightSpin, ThermaBreeze, StriveHive, FinchHarbor, SkyStream, Daybridge, LittleProteins",
    real_words: "Real English words used as brand names, e.g. Matter, Thriving, Sparring, Portico, Pettle, Una — common words made distinctive by context",
    short_phrase: "Short memorable phrase, e.g. 'More Than the Ride', 'Naughty Fruit', 'Little Proteins', 'Rock Brawler'",
    brandable_names: "Brand-able names built on real roots or recognizable morphemes, e.g. Pettle, Nexevel, Atrelio, Clinipal, Jitless, Nuaxo, Allyond, Opergon, Akhion, Sahano, Suvura, Spexo, Evoiq, Kaivea — each part traceable to a real word or root",
    creative_spelling: "Creative spelling of real words or blends, e.g. Pennyz (pennies), Piiqe (peak), Spexo (specs), Upnxt (up next), Jitless (jitterless), Loqelo (locale)",
    non_english_words: "Non-English words or roots that are easy for English speakers to pronounce, e.g. Kaivea, Sahano, Suvura, Velanee, VamshaDhara, Melomont",
};

export const STYLE_CONSTRAINTS: Record<string, [number, number]> = {
    auto: [14, 2],
    compound: [14, 2],
    brandable_names: [12, 1],
    blends: [12, 2],
    creative_spelling: [10, 2],
    non_english_words: [10, 1],
    real_words: [12, 1],
    short_phrase: [18, 3],
};

function sanitize(input: string): string {
    return (input || "").replace(/[^a-zA-Z0-9\s,.-]/g, "");
}

function validateName(name: string): boolean {
    return (
        typeof name === "string" &&
        name.length >= 3 &&
        name.length <= 25 &&
        !name.includes("*") &&
        !name.includes(":") &&
        !name.includes("\n")
    );
}

function isPronounceable(name: string): boolean {
    const lower = name.replace(/\s+/g, "").toLowerCase();
    // Reject names ending in awkward letter combos that trip English speakers
    const badEndings = ["uo", "ao", "tae", "nao", "yao", "oq", "lq", "rq", "niq", "ylu", "ytu", "dae", "bae"];
    for (const ending of badEndings) {
        if (lower.endsWith(ending)) return false;
    }
    // Reject names starting with uncommon consonant clusters (not real English word starts)
    const badStarts = ["bly", "pry", "zyp", "zym", "blys", "pryn", "brill", "yun"];
    for (const start of badStarts) {
        if (lower.startsWith(start)) return false;
    }
    // Reject 4+ consecutive consonants (indicates unpronounceable assembly)
    const stripped = lower.replace(/[^a-z]/g, "");
    if (/[bcdfghjklmnpqrstvwxyz]{4,}/.test(stripped)) return false;
    return true;
}

async function checkDomain(name: string, ext: string): Promise<string | null> {
    const clean = name.replace(/\s+/g, "").trim();
    try {
        const response = await axios.get(process.env.DOMAIN_CHECKER_URL!, {
            params: { "mashape-key": process.env.RAPIDAPI_KEY, domain: `${clean}.${ext}` },
            headers: {
                "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
                "X-RapidAPI-Host": process.env.RAPIDAPI_HOST,
            },
            timeout: 8000,
        });
        return response?.data?.status?.[0]?.summary === "inactive" ? clean : null;
    } catch {
        return null;
    }
}

export async function generateNames({
    description,
    keywords = "",
    style = "auto",
    extension = "com",
    count = 20,
    requireDomains = true,
    temperature = 0.7,
    nameQualities = "",
    avoid = "",
    alreadyRejected = "",
    likedNames = "",
    dislikedNames = "",
    likedWords = "",
    dislikedWords = "",
}: {
    description: string;
    keywords?: string;
    style?: string;
    extension?: string;
    count?: number;
    requireDomains?: boolean;
    temperature?: number;
    nameQualities?: string;
    avoid?: string;
    alreadyRejected?: string;
    likedNames?: string;
    dislikedNames?: string;
    likedWords?: string;
    dislikedWords?: string;
}): Promise<string[]> {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const [maxLength, maxWords] = STYLE_CONSTRAINTS[style] || STYLE_CONSTRAINTS.auto;
    const styleDesc = STYLES[style] || STYLES.auto;

    const desc = sanitize(description).slice(0, 600);
    const kw = sanitize(keywords).slice(0, 180);
    const qualities = sanitize(nameQualities).slice(0, 200);
    const avoidStr = sanitize(avoid).slice(0, 200);
    const rejected = sanitize(alreadyRejected).slice(0, 500);
    const likedNamesStr = sanitize(likedNames).slice(0, 400);
    const dislikedNamesStr = sanitize(dislikedNames).slice(0, 400);
    const likedWordsStr = sanitize(likedWords).slice(0, 300);
    const dislikedWordsStr = sanitize(dislikedWords).slice(0, 300);

    // Merge liked words into keywords so they seed name generation
    const mergedKeywords = [kw, likedWordsStr].filter(Boolean).join(",");

    const batchSize = 20;
    const MAX_ROUNDS = 20;
    const triedNames = new Set<string>();
    const available: string[] = [];

    for (let round = 1; round <= MAX_ROUNDS && available.length < count; round++) {
        const needed = count - available.length;
        const generateTarget = requireDomains ? needed * 3 : needed;

        console.error(`Round ${round}/${MAX_ROUNDS}: need ${needed} more available names (have ${available.length}/${count})...`);

        const newNames: string[] = [];
        let openaiAttempts = 0;
        const maxOpenaiAttempts = Math.ceil(generateTarget / batchSize) + 2;

        while (newNames.length < generateTarget && openaiAttempts < maxOpenaiAttempts) {
            openaiAttempts++;
            try {
                const res = await (openai.beta.chat.completions as any).parse({
                    model,
                    messages: [
                        {
                            role: "system",
                            content: `You are a brand naming specialist with 10+ years of experience winning professional naming contests. Your names appear in winning entries on competitive platforms.

## NON-NEGOTIABLE: REAL ROOTS ONLY
Every name MUST be built from recognizable building blocks. Before writing any name, identify what each part means:
- Real English words: heal, zone, core, bright, thrive, prime, well, spark
- Latin/Greek roots: vita (life), nova (new), ren (renew), gen (create), meri (merit), sol (sun), lux (light)
- Recognized morphemes: -born, -bridge, -port, -stead, -scape, -forge, pre-, re-, -al, -on, -ix

NEVER assemble random syllables. If you cannot say "this part means X, that part means Y," do not write the name.

## PRONOUNCEABILITY TEST (mandatory)
Say each name aloud before listing it. Any English speaker must be able to read it correctly on first encounter with no guidance. If you hesitate, discard it.

## WINNING PATTERNS (use these)
1. Two meaningful words joined: HealZone, CoreRenew, BrightSpin, ThermaBreeze, StriveHive, Daybridge, SkyStream, LittleProteins, FinchHarbor, SpanGrip
2. Word + meaningful suffix/root blend: Meritvita (merit+vita), Wellmora (well+mora), Primeborn (prime+born), Tracestorm (trace+storm), Atrelio (atelier+lio)
3. Real word as brand: Thriving, Sparring, Matter, Portico, Pettle, Una, Melomont
4. Coined word on traceable roots: Nexevel (next+level), Clinipal (clinic+pal), Jitless (jitter+less), Nuaxo (new+axo), Allyond (ally+beyond), Akhion (action+ion)

## FORBIDDEN PATTERNS (never generate)
- Names with no traceable root: ~~Elytuo, Zumorya, Zestylu, Prynao, Brilloq, Blystae, Lifoniq~~
- Endings that trip English speakers: -uo, -ao, -tae, -ae, -oq, -niq, -ylu, -nao
- Starts with unusual consonant clusters: bly-, pry-, zyp-
- Names ending in 'q' unless it's styled (Piiqe, Spexo are acceptable because the base word is clear)
- More than one unusual spelling element per name
- Names that look like keyboard mashing

## QUALITY BAR
Every name should make a client say "oh, I see what you did there." The meaning should be felt immediately. Length is flexible — short (5-7 chars) and longer (8-14 chars) names both win. Quality matters more than brevity.

Format: return only alphabet characters and spaces (for two-word names). No punctuation except ampersand for two-word phrase styles.
${avoidStr ? `\nAVOID these words/concepts entirely: ${avoidStr}` : ""}
${dislikedWordsStr ? `\nAVOID these words/roots (user preference): ${dislikedWordsStr}` : ""}
${rejected ? `\nNEVER repeat these already-rejected names: ${rejected}` : ""}
${dislikedNamesStr ? `\nNEVER generate names with the same style or pattern as these disliked names: ${dislikedNamesStr}` : ""}`,
                        },
                        {
                            role: "user",
                            content: `Generate ${batchSize} brand names for this business.

Business description: ${desc}
Keywords to draw meaning from (use as roots and concepts, not literally): ${mergedKeywords || "None"}
${qualities ? `Desired name qualities: ${qualities}` : ""}
Naming style: ${styleDesc}
Name length: 4 to ${maxLength} characters, up to ${maxWords} word(s)
Domain extension: .${extension}

REFERENCE EXAMPLES of winning names from similar contests (study their construction, do not copy):
- Health/wellness: Meritvita, Wellmora, Primeborn, HealZone, CoreRenew, LittleProteins, Pettle, Thriving
- Tech/business: Nexevel, Atrelio, Clinipal, Tracestorm, Jitless, BrightSpin, CoreStrux, Onsteady
- General brand: Sparring, Matter, Daybridge, Allyond, Nuaxo, Sahano, StriveHive, Kaivea
${likedNamesStr ? `\nNAMES WE LIKE (match this quality, style, and construction — do not copy these exactly):\n${likedNamesStr}` : ""}

For EACH name you generate, silently verify:
1. I can identify what each part means (real word, root, or morpheme)
2. An English speaker can read it aloud correctly on first try
3. It evokes the right feeling for the business without explaining it
4. It does not appear in the rejected list above

Return exactly ${batchSize} names.`,
                        },
                    ],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "nameListResponse",
                            schema: {
                                type: "object",
                                properties: { names: { type: "array", items: { type: "string" } } },
                                required: ["names"],
                            },
                        },
                    },
                    temperature,
                    max_tokens: 500,
                    frequency_penalty: 0.5,
                    presence_penalty: 0.5,
                });

                const parsed = JSON.parse(res.choices[0].message.content || "{}");
                for (const n of (parsed.names || [])) {
                    if (validateName(n) && isPronounceable(n) && !triedNames.has(n.toLowerCase())) {
                        triedNames.add(n.toLowerCase());
                        newNames.push(n);
                    }
                }
            } catch (err) {
                console.error(`OpenAI attempt ${openaiAttempts} error:`, (err as any).message);
                await sleep(2000);
            }
        }

        if (!requireDomains) {
            available.push(...newNames.slice(0, needed));
            break;
        }

        console.error(`  Checking ${newNames.length} names on .${extension}...`);
        let roundAvailable = 0;
        for (let i = 0; i < newNames.length && available.length < count; i += 10) {
            const batch = newNames.slice(i, i + 10);
            const results = await Promise.all(batch.map((n) => checkDomain(n, extension)));
            const found = results.filter(Boolean) as string[];
            available.push(...found);
            roundAvailable += found.length;
            if (i + 10 < newNames.length && available.length < count) await sleep(500);
        }

        console.error(`  Round ${round} found ${roundAvailable} available → total ${available.length}/${count}`);
    }

    if (available.length < count) {
        if (available.length >= 5) {
            console.error(
                `Warning: only got ${available.length}/${count} available names after ${MAX_ROUNDS} rounds — ` +
                `proceeding with partial results. Check RAPIDAPI_KEY if this happens often.`
            );
        } else {
            throw new Error(
                `Could not fill domain quota after ${MAX_ROUNDS} rounds: ` +
                `got ${available.length}/${count} available names on .${extension}. ` +
                `Check that RAPIDAPI_KEY is valid and the domain checker endpoint is reachable. ` +
                `To skip domain checking, pass requireDomains=false or use --no-domains.`
            );
        }
    }

    return available.slice(0, count);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const get = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
        const has = (flag: string) => args.includes(flag);

        const description = get("--description") || "";
        const keywords = get("--keywords") || "";
        const style = get("--style") || "auto";
        const extension = get("--extension") || "com";
        const count = parseInt(get("--count") || "35");
        const requireDomains = !has("--no-domains");
        const temperature = parseFloat(get("--temperature") || "0.7");

        if (!description) {
            console.error("Error: --description is required");
            process.exit(1);
        }

        console.error(`Generating ${count} names (style: ${style}, domain check: ${requireDomains})...`);

        const names = await generateNames({ description, keywords, style, extension, count, requireDomains, temperature });
        console.log(JSON.stringify({ names, count: names.length }));
    })();
}
