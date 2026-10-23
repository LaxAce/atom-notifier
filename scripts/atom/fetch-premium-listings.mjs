/**
 * Fetch the user's premium listing names from atom.com and save to premium-listings.json.
 *
 * Tries multiple URLs/selectors to find "My Listings" / "Marketplace names for sale".
 * Run via GitHub Actions (uses CONTEST_COOKIES secret) or locally with .env.atom.
 *
 * Usage:
 *   node fetch-premium-listings.mjs
 *   node fetch-premium-listings.mjs --debug   (dumps raw HTML to logs/)
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

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

const DEBUG = process.argv.includes("--debug");

// Candidate URLs for premium listings (atom.com / Squadhelp structure)
const LISTING_URLS = [
    "https://atom.com/my-account/marketplace",
    "https://atom.com/my-account/names-for-sale",
    "https://atom.com/seller/marketplace",
    "https://atom.com/account/listings",
    "https://atom.com/my-listings",
];

function parseCookies(cookieStr) {
    return cookieStr.split(";").map((part) => {
        const [name, ...rest] = part.trim().split("=");
        return { name: name.trim(), value: rest.join("=").trim(), domain: ".atom.com", path: "/" };
    }).filter((c) => c.name && c.value);
}

function debugDump(label, content) {
    if (!DEBUG) return;
    mkdirSync(path.join(__dirname, "logs"), { recursive: true });
    const file = path.join(__dirname, "logs", `debug-${label}.html`);
    writeFileSync(file, content);
    console.error(`[DEBUG] Dumped to ${file}`);
}

// ── Try axios first (fast, no JS rendering) ──────────────────────────────────

async function tryAxios(url, cookies) {
    try {
        const response = await axios.get(url, {
            headers: {
                Cookie: cookies,
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            timeout: 15000,
            maxRedirects: 3,
        });
        return response.data;
    } catch (err) {
        console.error(`  axios failed for ${url}: ${err.message}`);
        return null;
    }
}

// ── Extract listings from HTML ────────────────────────────────────────────────

function extractListings($) {
    const listings = [];

    // Try multiple selector patterns for atom.com listing cards
    const selectors = [
        // Pattern 1: card with name and price
        { container: ".listing-card, .name-card, .marketplace-item", nameEl: ".name, h3, .listing-name", priceEl: ".price, .listing-price" },
        // Pattern 2: table rows
        { container: "tr.listing-row, tr.name-row", nameEl: "td.name, td:first-child", priceEl: "td.price, td:nth-child(2)" },
        // Pattern 3: list items
        { container: "li.listing, li.name-item", nameEl: ".name, strong, b", priceEl: ".price" },
        // Pattern 4: generic data attributes
        { container: "[data-name], [data-listing-name]", nameEl: null, priceEl: null },
    ];

    for (const { container, nameEl, priceEl } of selectors) {
        $(container).each((_, el) => {
            let name = "";
            let price = 0;

            if (nameEl) {
                name = $(el).find(nameEl).first().text().trim();
            } else {
                name = $(el).attr("data-name") || $(el).attr("data-listing-name") || "";
            }

            if (priceEl) {
                const priceText = $(el).find(priceEl).first().text().replace(/[^0-9.]/g, "");
                price = parseFloat(priceText) || 0;
            }

            if (name && name.length >= 3 && name.length <= 25 && /^[a-zA-Z0-9\s]+$/.test(name)) {
                listings.push({ name: name.trim(), price });
            }
        });
        if (listings.length > 0) break;
    }

    return listings;
}

// ── Playwright fallback (handles JS-rendered content) ────────────────────────

async function tryPlaywright(cookies) {
    console.error("Falling back to Playwright (JS-rendered content)...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    await context.addCookies(parseCookies(cookies));
    const page = await context.newPage();
    const allListings = [];

    for (const url of LISTING_URLS) {
        try {
            console.error(`  Playwright: trying ${url}...`);
            await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });

            // Wait for content to load
            await page.waitForTimeout(2000);

            const html = await page.content();
            debugDump(`playwright-${url.split("/").pop()}`, html);

            const $ = cheerio.load(html);
            const listings = extractListings($);

            if (listings.length > 0) {
                console.error(`  Found ${listings.length} listings at ${url}`);
                allListings.push(...listings);
                break;
            }

            // Also try to find names in page text (any word that looks like a brand name)
            const pageText = await page.locator("body").innerText();
            const namePattern = /\b([A-Z][a-z]{2,}(?:[A-Z][a-z]*)?)\b/g;
            const matches = [...pageText.matchAll(namePattern)]
                .map((m) => m[1])
                .filter((n) => n.length >= 3 && n.length <= 15);

            if (matches.length > 2) {
                console.error(`  Found ${matches.length} potential names in page text`);
                // Store raw text for manual review
                mkdirSync(path.join(__dirname, "logs"), { recursive: true });
                writeFileSync(
                    path.join(__dirname, "logs", "playwright-page-text.txt"),
                    pageText
                );
                console.error(`  Page text saved to logs/playwright-page-text.txt — review manually`);
            }
        } catch (err) {
            console.error(`  Playwright error for ${url}: ${err.message}`);
        }
    }

    await browser.close();
    return allListings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function fetchPremiumListings() {
    const cookies = process.env.CONTEST_COOKIES;
    if (!cookies) throw new Error("CONTEST_COOKIES env var required");

    let allListings = [];

    // Try axios on each URL first
    for (const url of LISTING_URLS) {
        console.error(`Trying ${url}...`);
        const html = await tryAxios(url, cookies);
        if (!html) continue;

        debugDump(url.split("/").pop(), html);

        const $ = cheerio.load(html);

        // Quick check: did we land on a login page?
        const title = $("title").text().toLowerCase();
        if (title.includes("login") || title.includes("sign in")) {
            console.error("  Redirected to login — cookies may be expired");
            continue;
        }

        const listings = extractListings($);
        if (listings.length > 0) {
            console.error(`  Found ${listings.length} listings via axios`);
            allListings = listings;
            break;
        }

        console.error(`  No listings found at ${url} (page title: "${$("title").text().trim()}")`);
    }

    // Fall back to Playwright if axios found nothing
    if (allListings.length === 0) {
        allListings = await tryPlaywright(cookies);
    }

    if (allListings.length === 0) {
        console.error("\nCould not auto-detect listings. Possible causes:");
        console.error("  1. atom.com changed their HTML structure");
        console.error("  2. Cookies expired");
        console.error("  3. Listings page requires different navigation");
        console.error("\nCheck logs/ folder for debug HTML dumps.");
        console.error("You can also manually add names to scripts/atom/premium-listings.json");
        process.exit(1);
    }

    // Deduplicate
    const seen = new Set();
    const unique = allListings.filter((l) => {
        const key = l.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Save to premium-listings.json
    const outFile = path.join(__dirname, "premium-listings.json");
    const output = {
        _instructions: "Auto-fetched from atom.com. Re-run node fetch-premium-listings.mjs to refresh.",
        _lastUpdated: new Date().toISOString().split("T")[0],
        _refreshCommand: "node fetch-premium-listings.mjs",
        names: unique.map((l) => ({
            name: l.name,
            industry: ["general"],
            style: l.name.length <= 8 ? "brandable" : "compound",
            price: l.price,
        })),
    };

    writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.error(`\nSaved ${unique.length} premium listings to premium-listings.json`);
    console.log(JSON.stringify({ count: unique.length, names: unique.map((l) => l.name) }));
}

await fetchPremiumListings();
