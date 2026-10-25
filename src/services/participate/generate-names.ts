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
    auto: "20% of Blends, e.g Sharpcast, Instagram, Wikipedia etc, 20% of Compound, e.g WordPress, Facebook, SnapChat etc, 20% of Brand-able names, e.g Google, Meebo, Praxo etc., 20% of Creative spelling, e.g Flickr, Lyft etc, 10% of Non english words, e.g Zello, Avrio, Karaoke etc, and 10% of Short phrase, e.g Just Do It,  I'm Lovin' It etc.",
    blends: "Blends, e.g Sharpcast, Instagram, Wikipedia etc.",
    compound: "Compound, e.g WordPress, WhatsApp, LiveScore, SnapChat etc.",
    real_words: "Real words, e.g Apple, Amazon, Adobe etc.",
    short_phrase: "Short phrase, e.g Just Do It,  I'm Lovin' It etc.",
    brandable_names: "Brand-able names, e.g Google, Meebo, Praxo etc.",
    creative_spelling: "Creative spelling, e.g Flickr, Lyft etc.",
    non_english_words: "Non english words, e.g Zello, Avrio, Karaoke etc.",
};

export const STYLE_CONSTRAINTS: Record<string, [number, number]> = {
    auto: [12, 2],
    compound: [12, 2],
    brandable_names: [8, 1],
    blends: [10, 2],
    creative_spelling: [8, 2],
    non_english_words: [7, 1],
    real_words: [8, 1],
    short_phrase: [15, 3],
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
}: {
    description: string;
    keywords?: string;
    style?: string;
    extension?: string;
    count?: number;
    requireDomains?: boolean;
    temperature?: number;
}): Promise<string[]> {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const [maxLength, maxWords] = STYLE_CONSTRAINTS[style] || STYLE_CONSTRAINTS.auto;
    const styleDesc = STYLES[style] || STYLES.auto;

    const desc = sanitize(description).slice(0, 600);
    const kw = sanitize(keywords).slice(0, 180);

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
                            content: `Generate ${batchSize} names, do not add the extensions to the end of the names, names should only contain alphabet, names should be at least 3 letters, names should not exceed ${maxLength}, 20% of the generated names should not be based on the 'Product description,' 'Keywords,' or 'Naming style. Every name in the array should be unique. Most importantly, ensure that the names are easy to pronounce and spell, and that they don't end with double letters like 'xx', 'oo', 'ee', etc. names should not end with 'q'. ${kw ? `60% of the names should be based on the 'Keywords'` : ""}`,
                        },
                        {
                            role: "user",
                            content: `Generate ${batchSize} company names with the following criteria:\n- Product description: ${desc}\n- Keywords: ${kw || "None"}\n- Name length: Ensure name doesn't exceed 5 to ${maxLength} characters\n- Maximum number of words: ${maxWords}\n- Naming style: ${styleDesc}\n- Extensions: ${extension}\n- Syllables: Ensure all names have maximum of ${maxLength > 12 ? 4 : 3} syllables.\n- Domain availability: ${requireDomains ? `Ensure the names are likely available as domains in the following extensions: (${extension}). Utilize common prefixes and suffixes to increase domain availability.` : "Do not consider domain extensions."}\n- Pronunciation and spelling: Ensure all names are easy to pronounce and spell.`,
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
                    if (validateName(n) && !triedNames.has(n.toLowerCase())) {
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
        throw new Error(
            `Could not fill domain quota after ${MAX_ROUNDS} rounds: ` +
            `got ${available.length}/${count} available names on .${extension}. ` +
            `Check that RAPIDAPI_KEY is valid and the domain checker endpoint is reachable. ` +
            `To skip domain checking, pass requireDomains=false or use --no-domains.`
        );
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
