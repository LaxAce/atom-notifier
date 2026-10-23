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

        // atom.com: click "SUBMIT YOUR ENTRY" to open the side panel with the entry form
        const openFormSelectors = [
            "a:has-text('SUBMIT YOUR ENTRY')",
            "button:has-text('SUBMIT YOUR ENTRY')",
            "a:has-text('Submit Your Entry')",
            "button:has-text('Submit Your Entry')",
        ];
        let formOpened = false;
        for (const sel of openFormSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.count() > 0 && await btn.isVisible()) {
                    await btn.click();
                    console.error(`Opened entry form via: ${sel}`);
                    await page.waitForTimeout(2000);
                    formOpened = true;
                    break;
                }
            } catch { /* ignore */ }
        }
        if (!formOpened) console.error("Warning: could not find 'SUBMIT YOUR ENTRY' button — form may already be open");

        // The form has a "Domain Name" labeled input — find it
        // Log all visible inputs for debugging
        const allInputs = await page.locator("input[type='text'], input:not([type='hidden']):not([type='checkbox']):not([type='radio'])").all();
        console.error(`Found ${allInputs.length} text input(s) visible after opening form`);
        for (const inp of allInputs.slice(0, 10)) {
            const placeholder = await inp.getAttribute("placeholder").catch(() => "");
            const nm = await inp.getAttribute("name").catch(() => "");
            const id = await inp.getAttribute("id").catch(() => "");
            const cls = await inp.getAttribute("class").catch(() => "");
            console.error(`  input: name="${nm}" id="${id}" placeholder="${placeholder}" class="${cls?.slice(0, 80)}"`);
        }

        // Selector priority: labeled "Domain Name", common name/domain field names, then any visible text input
        const inputSelectors = [
            "input[placeholder*='domain' i]",
            "input[placeholder*='name' i]",
            "input[name*='domain' i]",
            "input[name*='name' i]",
            "input[name*='entry' i]",
            "#entry-name",
            "#domain_name",
            "#name_suggestion",
            ".entry-form input[type='text']",
            ".submit-panel input[type='text']",
            "[class*='submit'] input[type='text']",
            "[class*='entry'] input[type='text']",
        ];

        async function findDomainInput() {
            for (const sel of inputSelectors) {
                const loc = page.locator(sel);
                if (await loc.count() > 0) {
                    const visible = await loc.first().isVisible().catch(() => false);
                    if (visible) {
                        console.error(`Found domain input: ${sel}`);
                        return loc.first();
                    }
                }
            }
            // Last resort: first visible text input on page
            const anyInput = page.locator("input[type='text']").first();
            if (await anyInput.isVisible().catch(() => false)) {
                console.error("Found domain input via fallback: first visible text input");
                return anyInput;
            }
            return null;
        }

        const firstInput = await findDomainInput();
        if (!firstInput) {
            const html = await page.content();
            const debugFile = path.join(__dirname, "logs", "debug-page.html");
            const { mkdirSync, writeFileSync } = await import("fs");
            mkdirSync(path.join(__dirname, "logs"), { recursive: true });
            writeFileSync(debugFile, html);
            throw new Error(`Could not find Domain Name input on ${contestUrl}. HTML dumped to ${debugFile}.`);
        }

        // Get already-submitted names to avoid duplicates
        const existingEntries = await page.locator(".my-entries .entry-name, .submitted-entries li, .my-submissions .name").allTextContents();
        const existingSet = new Set(existingEntries.map((n) => n.trim().toLowerCase()));
        console.error(`Already submitted ${existingEntries.length} entries in this contest`);

        // Submit one name at a time:
        // fill Domain Name input → click orange Submit button → repeat
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
                // Find the input fresh each iteration (panel may re-render)
                const inputLocator = await findDomainInput();
                if (!inputLocator) throw new Error("Domain Name input disappeared");

                await inputLocator.clear();
                await inputLocator.fill(name);
                await sleep(300);

                // Click the orange "Submit" button in the panel
                const submitBtn = page.locator("button:has-text('Submit'), input[type='submit'][value*='Submit' i]").first();
                if (await submitBtn.count() > 0 && await submitBtn.isVisible()) {
                    await submitBtn.click();
                } else {
                    await inputLocator.press("Enter");
                }

                await page.waitForTimeout(1500);

                // Check for error
                const errorMsg = await page.locator(".error-message, .alert-danger, .submission-error").first().textContent().catch(() => "");
                if (errorMsg && errorMsg.toLowerCase().includes("error")) {
                    throw new Error(errorMsg.trim());
                }

                console.error(`Submitted: ${name}`);
                submitted.push(name);
                existingSet.add(name.toLowerCase());

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
