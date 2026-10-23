/**
 * Scrape and parse an atom.com contest brief.
 * Returns structured data: description, industry, style hints, extension preference, keywords.
 *
 * Usage:
 *   node parse-brief.mjs "https://atom.com/contest/12345"
 *
 * Outputs JSON to stdout.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── Scrape atom.com contest page ──────────────────────────────────────────────

export async function scrapeContestPage(url) {
    const cookieStr = process.env.CONTEST_COOKIES;
    if (!cookieStr) throw new Error("CONTEST_COOKIES env var is required");

    // Use Playwright to bypass Cloudflare bot detection on individual contest pages
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });

        // Parse and set cookies from the cookie string
        const cookiePairs = cookieStr.split(";").map((c) => c.trim()).filter(Boolean);
        const cookies = cookiePairs.map((pair) => {
            const eqIdx = pair.indexOf("=");
            return {
                name: pair.slice(0, eqIdx).trim(),
                value: pair.slice(eqIdx + 1).trim(),
                domain: ".atom.com",
                path: "/",
            };
        });
        await context.addCookies(cookies);

        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

        if (!response || !response.ok()) {
            throw new Error(`HTTP ${response?.status()} fetching contest page`);
        }

        const html = await page.content();
        return html;
    } finally {
        await browser.close();
    }
}

// ── Parse HTML into structured brief ─────────────────────────────────────────

export function parseContestHtml(html, url) {
    const $ = cheerio.load(html);

    // Contest title
    const title =
        $("h1.contest-title").text().trim() ||
        $(".project-name h1").text().trim() ||
        $("h1").first().text().trim() ||
        "";

    // Contest type (Company Name or Tagline)
    const typeText = $(".contest-type, .project-type").text().trim().toLowerCase();
    const contestType = typeText.includes("tagline") ? "tagline" : "company_name";

    // Full brief text — atom.com puts it in various containers
    const briefSelectors = [
        ".project-description",
        ".brief-description",
        ".contest-brief",
        ".project-details",
        "#project-description",
        ".description-content",
    ];
    let briefText = "";
    for (const sel of briefSelectors) {
        const text = $(sel).text().trim();
        if (text.length > 50) {
            briefText = text;
            break;
        }
    }
    // Fallback: find the largest text block on the page
    if (!briefText) {
        let maxLen = 0;
        $("p, div").each((_, el) => {
            const text = $(el).text().trim();
            if (text.length > maxLen && text.length < 5000) {
                maxLen = text.length;
                briefText = text;
            }
        });
    }

    // Industry
    const industrySelectors = [".industry", ".category", ".project-industry", ".contest-category"];
    let industry = "";
    for (const sel of industrySelectors) {
        const text = $(sel).text().trim();
        if (text) { industry = text; break; }
    }

    // Domain extension preference
    const domainText = $(".domain-preference, .preferred-extension, .tld-preference").text().toLowerCase();
    let extension = "com"; // default
    if (domainText.includes(".io")) extension = "io";
    else if (domainText.includes(".ai")) extension = "ai";
    else if (domainText.includes(".co")) extension = "co";

    // Style keywords from the brief text
    const styleHints = extractStyleHints(briefText + " " + title);

    // Keywords mentioned in the brief
    const keywords = extractKeywords(briefText, title);

    return {
        url,
        title,
        contestType,
        rawBrief: briefText,
        industry,
        extension,
        styleHints,
        keywords,
    };
}

function extractStyleHints(text) {
    const lower = text.toLowerCase();
    const hints = [];
    if (/(modern|tech|startup|innovative|digital|ai|saas|software)/.test(lower)) hints.push("modern_tech");
    if (/(traditional|classic|heritage|established|professional|trusted)/.test(lower)) hints.push("traditional");
    if (/(fun|playful|creative|quirky|bold|energetic)/.test(lower)) hints.push("playful");
    if (/(global|international|worldwide|universal)/.test(lower)) hints.push("global");
    if (/(health|wellness|medical|care|therapy)/.test(lower)) hints.push("health");
    if (/(finance|financial|invest|money|wealth)/.test(lower)) hints.push("finance");
    if (/(food|restaurant|culinary|chef|eat)/.test(lower)) hints.push("food");
    if (/(eco|green|sustainable|environment)/.test(lower)) hints.push("eco");
    return hints;
}

function extractKeywords(brief, title) {
    // Simple extraction: pull nouns/key terms from title and first 200 chars of brief
    const combined = `${title} ${brief.slice(0, 200)}`;
    const words = combined
        .replace(/[^a-zA-Z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && w.length <= 12)
        .map((w) => w.toLowerCase());

    const stopWords = new Set(["that", "this", "with", "have", "will", "your", "from", "they", "been", "were", "their", "what", "when", "where", "which", "about", "more", "into", "also", "some", "than", "then", "them", "these", "those", "each", "most", "over"]);
    const unique = [...new Set(words.filter((w) => !stopWords.has(w)))];
    return unique.slice(0, 8).join(",");
}

// ── Use GPT to compress brief to 600 chars ───────────────────────────────────

export async function compressBrief(rawBrief, title, industry) {
    if (rawBrief.length <= 600) return rawBrief;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const res = await openai.chat.completions.create({
        model,
        messages: [
            {
                role: "system",
                content: "You compress business descriptions into exactly 500-580 characters. Keep: what the business does, who it serves, core values. Remove: repetition, filler words, examples. Output one paragraph, no quotes.",
            },
            {
                role: "user",
                content: `Title: ${title}\nIndustry: ${industry}\nBrief:\n${rawBrief.slice(0, 3000)}`,
            },
        ],
        max_tokens: 200,
        temperature: 0.3,
    });

    const compressed = res.choices[0].message.content?.trim() || rawBrief.slice(0, 580);
    return compressed.slice(0, 600);
}

// ── Map style hints → AiNameIt style ─────────────────────────────────────────

export function pickNameStyle(styleHints, contestType) {
    if (contestType === "tagline") return "short_phrase";
    if (styleHints.includes("playful")) return "blends";
    if (styleHints.includes("traditional") || styleHints.includes("finance")) return "real_words";
    if (styleHints.includes("global")) return "non_english_words";
    return "auto"; // default — covers all styles
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const url = process.argv[2];
    if (!url) {
        console.error("Usage: node parse-brief.mjs <contest-url>");
        process.exit(1);
    }

    console.error(`Fetching contest brief from ${url}...`);
    const html = await scrapeContestPage(url);
    const parsed = parseContestHtml(html, url);

    console.error(`Raw brief length: ${parsed.rawBrief.length} chars`);
    console.error(`Compressing brief...`);

    const compressed = await compressBrief(parsed.rawBrief, parsed.title, parsed.industry);
    const style = pickNameStyle(parsed.styleHints, parsed.contestType);

    const result = {
        ...parsed,
        compressedBrief: compressed,
        suggestedStyle: style,
    };

    console.log(JSON.stringify(result, null, 2));
}
