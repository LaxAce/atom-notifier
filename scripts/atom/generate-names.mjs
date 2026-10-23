/**
 * Standalone name generator — replicates AiNameIt's OpenAI logic without auth/credits.
 * Reads env from .env.atom (or process.env for GitHub Actions).
 *
 * Usage:
 *   node generate-names.mjs --description "..." --style "auto" --extension "com" --count 35
 *   node generate-names.mjs --description "..." --no-domains  (skip domain check)
 */

import OpenAI from "openai";
import axios from "axios";
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.atom if present (local dev); GitHub Actions injects env vars directly
const envFile = path.join(__dirname, ".env.atom");
if (existsSync(envFile)) {
    const lines = readFileSync(envFile, "utf8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...rest] = trimmed.split("=");
        if (key && rest.length && !process.env[key]) {
            process.env[key] = rest.join("=");
        }
    }
}

// ── Styles (mirrors utils/enums.ts EBrandStyle) ──────────────────────────────

export const STYLES = {
    auto: "20% of Blends, e.g Sharpcast, Instagram, Wikipedia etc, 20% of Compound, e.g WordPress, Facebook, SnapChat etc, 20% of Brand-able names, e.g Google, Meebo, Praxo etc., 20% of Creative spelling, e.g Flickr, Lyft etc, 10% of Non english words, e.g Zello, Avrio, Karaoke etc, and 10% of Short phrase, e.g Just Do It,  I'm Lovin' It etc.",
    blends: "Blends, e.g Sharpcast, Instagram, Wikipedia etc.",
    compound: "Compound, e.g WordPress, WhatsApp, LiveScore, SnapChat etc.",
    real_words: "Real words, e.g Apple, Amazon, Adobe etc.",
    short_phrase: "Short phrase, e.g Just Do It,  I'm Lovin' It etc.",
    brandable_names: "Brand-able names, e.g Google, Meebo, Praxo etc.",
    creative_spelling: "Creative spelling, e.g Flickr, Lyft etc.",
    non_english_words: "Non english words, e.g Zello, Avrio, Karaoke etc.",
};

// Style → [maxLength, maxWords]
export const STYLE_CONSTRAINTS = {
    auto: [12, 2],
    compound: [12, 2],
    brandable_names: [8, 1],
    blends: [10, 2],
    creative_spelling: [8, 2],
    non_english_words: [7, 1],
    real_words: [8, 1],
    short_phrase: [15, 3],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(input) {
    return (input || "").replace(/[^a-zA-Z0-9\s,.-]/g, "");
}

function validateName(name) {
    return (
        typeof name === "string" &&
        name.length >= 3 &&
        name.length <= 25 &&
        !name.includes("*") &&
        !name.includes(":") &&
        !name.includes("\n")
    );
}

// ── Domain checker ────────────────────────────────────────────────────────────

async function checkDomain(name, ext) {
    const clean = name.replace(/\s+/g, "").trim();
    try {
        const response = await axios.get(process.env.DOMAIN_CHECKER_URL, {
            params: { "mashape-key": process.env.RAPIDAPI_KEY, domain: `${clean}.${ext}` },
            headers: {
                "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
                "X-RapidAPI-Host": process.env.RAPIDAPI_HOST,
            },
            timeout: 8000,
        });
        return response?.data?.status?.[0]?.summary === "inactive" ? clean : null;
    } catch {
        return null; // treat error as unavailable to be safe
    }
}

// ── OpenAI name generation ────────────────────────────────────────────────────

export async function generateNames({
    description,
    keywords = "",
    style = "auto",
    extension = "com",
    count = 35,
    requireDomains = true,
    temperature = 0.7,
}) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const [maxLength, maxWords] = STYLE_CONSTRAINTS[style] || STYLE_CONSTRAINTS.auto;
    const styleDesc = STYLES[style] || STYLES.auto;

    const desc = sanitize(description).slice(0, 600);
    const kw = sanitize(keywords).slice(0, 180);

    const batchSize = 20;
    const totalNeeded = requireDomains ? count * 3 : count; // generate 3x to have enough after domain filtering
    const uniqueNames = new Set();

    let attempts = 0;
    const maxAttempts = Math.ceil(totalNeeded / batchSize) + 2;

    while (uniqueNames.size < totalNeeded && attempts < maxAttempts) {
        attempts++;
        try {
            const res = await openai.beta.chat.completions.parse({
                model,
                messages: [
                    {
                        role: "system",
                        content: `Generate ${batchSize} names, do not add the extensions to the end of the names, names should only contain alphabet, names should be at least 3 letters, names should not exceed ${maxLength}, 20% of the generated names should not be based on the 'Product description,' 'Keywords,' or 'Naming style. Every name in the array should be unique. Most importantly, ensure that the names are easy to pronounce and spell, and that they don't end with double letters like 'xx', 'oo', 'ee', etc. names should not end with 'q'. ${kw ? `60% of the names should be based on the 'Keywords'` : ""}`,
                    },
                    {
                        role: "user",
                        content: `Generate ${batchSize} company names with the following criteria:
- Product description: ${desc}
- Keywords: ${kw || "None"}
- Name length: Ensure name doesn't exceed 5 to ${maxLength} characters
- Maximum number of words: ${maxWords}
- Naming style: ${styleDesc}
- Extensions: ${extension}
- Syllables: Ensure all names have maximum of ${maxLength > 12 ? 4 : 3} syllables.
- Domain availability: ${requireDomains ? `Ensure the names are likely available as domains in the following extensions: (${extension}). Utilize common prefixes and suffixes to increase domain availability.` : "Do not consider domain extensions."}
- Pronunciation and spelling: Ensure all names are easy to pronounce and spell.`,
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
            const names = parsed.names || [];
            names.filter(validateName).forEach((n) => uniqueNames.add(n));
        } catch (err) {
            console.error(`OpenAI batch ${attempts} error:`, err.message);
            await sleep(2000);
        }

        if (uniqueNames.size >= totalNeeded) break;
    }

    const allNames = Array.from(uniqueNames);

    if (!requireDomains) {
        return allNames.slice(0, count);
    }

    // Check domain availability — parallel but rate-limited
    console.error(`Checking domain availability for ${allNames.length} names on .${extension}...`);
    const available = [];
    for (let i = 0; i < allNames.length && available.length < count; i += 10) {
        const batch = allNames.slice(i, i + 10);
        const results = await Promise.all(batch.map((n) => checkDomain(n, extension)));
        available.push(...results.filter(Boolean));
        if (i + 10 < allNames.length && available.length < count) await sleep(500);
    }

    // If we couldn't get enough available, fill with remaining names
    if (available.length < count) {
        const availableSet = new Set(available);
        for (const name of allNames) {
            if (available.length >= count) break;
            if (!availableSet.has(name)) available.push(name);
        }
    }

    return available.slice(0, count);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const get = (flag) => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : undefined;
    };
    const has = (flag) => args.includes(flag);

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

    // Output as JSON to stdout so orchestrator can parse it
    console.log(JSON.stringify({ names, count: names.length }));
}
