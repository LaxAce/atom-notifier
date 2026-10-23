/**
 * Submit name entries to an atom.com contest using Playwright.
 * Navigates the contest page, fills in each name, and submits.
 *
 * Usage:
 *   node submit-entries.mjs --contest-url "https://atom.com/contest/..." --names "Name1,Name2,..."
 *
 * Returns JSON to stdout: { submitted: [...], failed: [...] }
 */

import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
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

function parseCookies(cookieStr) {
    return cookieStr.split(";").map((part) => {
        const [name, ...rest] = part.trim().split("=");
        return { name: name.trim(), value: rest.join("=").trim(), domain: ".atom.com", path: "/" };
    }).filter((c) => c.name && c.value);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function submitEntries(contestUrl, names, { dryRun = false } = {}) {
    const cookies = process.env.CONTEST_COOKIES;
    if (!cookies) throw new Error("CONTEST_COOKIES env var is required");

    console.error(`Launching browser (headless)...`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    await context.addCookies(parseCookies(cookies));

    const page = await context.newPage();
    const submitted = [];
    const failed = [];
    const alreadySubmitted = [];

    try {
        console.error(`Navigating to contest: ${contestUrl}`);
        // Use networkidle so React/JS fully renders the form before we look for inputs
        await page.goto(contestUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(2000);

        // atom.com hides the entry form behind a "SUBMIT YOUR ENTRY" button.
        // Click it to open the submission form/modal, then find the input inside.
        const submitBtnSelectors = [
            "a:has-text('SUBMIT YOUR ENTRY')",
            "a:has-text('Submit Your Entry')",
            "button:has-text('SUBMIT YOUR ENTRY')",
            "button:has-text('Submit Your Entry')",
            ".submit-entry-btn",
            "[href*='submit']",
        ];
        for (const sel of submitBtnSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.count() > 0 && await btn.isVisible()) {
                    await btn.click();
                    console.error(`Clicked "Submit Your Entry" button: ${sel}`);
                    await page.waitForTimeout(2000);
                    break;
                }
            } catch { /* ignore */ }
        }

        // Log all visible inputs for debugging
        const allInputs = await page.locator("input[type='text'], input:not([type]), textarea").all();
        console.error(`Found ${allInputs.length} text input(s) on page after opening form`);
        for (const inp of allInputs.slice(0, 10)) {
            const placeholder = await inp.getAttribute("placeholder").catch(() => "");
            const name = await inp.getAttribute("name").catch(() => "");
            const id = await inp.getAttribute("id").catch(() => "");
            const cls = await inp.getAttribute("class").catch(() => "");
            console.error(`  input: name="${name}" id="${id}" placeholder="${placeholder}" class="${cls?.slice(0, 80)}"`);
        }

        const submissionSelectors = [
            "input[placeholder*='name' i]",
            "input[placeholder*='entry' i]",
            "input[placeholder*='submit' i]",
            "input[placeholder*='type' i]",
            "input[placeholder*='suggest' i]",
            "input[placeholder*='brand' i]",
            "input[placeholder*='domain' i]",
            ".submission-input input",
            ".submit-entry input",
            ".entry-form input[type='text']",
            ".modal input[type='text']",
            "#entry-name",
            "#name_suggestion",
            "input[name='entry']",
            "input[name='name']",
            "input[name*='name']",
            "input[name*='entry']",
            "input[name*='domain']",
            "form input[type='text']",
        ];

        let inputLocator = null;
        for (const sel of submissionSelectors) {
            const loc = page.locator(sel);
            const count = await loc.count();
            if (count > 0) {
                const visible = await loc.first().isVisible().catch(() => false);
                if (visible) {
                    inputLocator = loc.first();
                    console.error(`Found submission input: ${sel}`);
                    break;
                }
            }
        }

        if (!inputLocator) {
            // Dump page HTML for debugging
            const html = await page.content();
            const debugFile = path.join(__dirname, "logs", "debug-page.html");
            const { mkdirSync, writeFileSync } = await import("fs");
            mkdirSync(path.join(__dirname, "logs"), { recursive: true });
            writeFileSync(debugFile, html);
            throw new Error(`Could not find submission input on ${contestUrl}. Dumped HTML to ${debugFile}. Update selectors in submit-entries.mjs.`);
        }

        // Get already-submitted names to avoid duplicates
        const existingEntries = await page.locator(".my-entries .entry-name, .submitted-entries li, .my-submissions .name").allTextContents();
        const existingSet = new Set(existingEntries.map((n) => n.trim().toLowerCase()));
        console.error(`Already submitted ${existingEntries.length} entries in this contest`);

        // Submit submit button selector
        const submitSelectors = [
            "button[type='submit']",
            ".submit-entry-btn",
            ".btn-submit",
            "button:has-text('Submit')",
            "button:has-text('Enter')",
        ];

        for (const name of names) {
            if (existingSet.has(name.toLowerCase())) {
                console.error(`Skip (already submitted): ${name}`);
                alreadySubmitted.push(name);
                continue;
            }

            if (dryRun) {
                console.error(`[DRY RUN] Would submit: ${name}`);
                submitted.push(name);
                continue;
            }

            try {
                // Clear and fill the input
                await inputLocator.clear();
                await inputLocator.fill(name);
                await sleep(500);

                // Find and click submit button
                let submitted_this = false;
                for (const sel of submitSelectors) {
                    const btn = page.locator(sel).first();
                    if (await btn.count() > 0 && await btn.isVisible()) {
                        await btn.click();
                        submitted_this = true;
                        break;
                    }
                }

                if (!submitted_this) {
                    // Try pressing Enter as fallback
                    await inputLocator.press("Enter");
                }

                // Wait for submission to register (success indicator or new entry in list)
                await page.waitForTimeout(1500);

                // Check for error message
                const errorMsg = await page.locator(".error-message, .alert-danger, .submission-error").first().textContent().catch(() => "");
                if (errorMsg && errorMsg.toLowerCase().includes("error")) {
                    throw new Error(errorMsg.trim());
                }

                console.error(`Submitted: ${name}`);
                submitted.push(name);
                existingSet.add(name.toLowerCase());

                // Polite delay between submissions (~2 seconds)
                await sleep(2000);
            } catch (err) {
                console.error(`Failed: ${name} — ${err.message}`);
                failed.push({ name, error: err.message });
            }
        }
    } finally {
        await browser.close();
    }

    return { submitted, failed, alreadySubmitted };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
    const has = (flag) => args.includes(flag);

    const contestUrl = get("--contest-url");
    const namesStr = get("--names") || "";
    const dryRun = has("--dry-run");

    if (!contestUrl || !namesStr) {
        console.error("Usage: node submit-entries.mjs --contest-url <url> --names <comma-separated-names>");
        process.exit(1);
    }

    const names = namesStr.split(",").map((n) => n.trim()).filter(Boolean);
    console.error(`Submitting ${names.length} names to ${contestUrl}${dryRun ? " (DRY RUN)" : ""}...`);

    const result = await submitEntries(contestUrl, names, { dryRun });
    console.log(JSON.stringify(result, null, 2));
    console.error(`Done: ${result.submitted.length} submitted, ${result.failed.length} failed, ${result.alreadySubmitted.length} already submitted`);
}
