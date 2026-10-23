/**
 * Submit name entries to an atom.com contest using Playwright.
 *
 * atom.com batches submissions: the form shows 3 "Domain Name" slots.
 * Fill all 3, click Submit, wait for reset, repeat.
 *
 * Usage:
 *   node submit-entries.mjs --contest-url "https://atom.com/contest/..." --names "Name1,Name2,..."
 *
 * Returns JSON to stdout: { submitted: [...], failed: [...], alreadySubmitted: [...] }
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

// Chunk array into groups of n
function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

const BATCH_SIZE = 3; // atom.com allows 3 entries per submission

export async function submitEntries(contestUrl, names, { dryRun = false } = {}) {
    const cookies = process.env.CONTEST_COOKIES;
    if (!cookies) throw new Error("CONTEST_COOKIES env var is required");

    if (dryRun) {
        console.error(`[DRY RUN] Would submit ${names.length} names to ${contestUrl}:`);
        names.forEach((n) => console.error(`  - ${n}`));
        return { submitted: [...names], failed: [], alreadySubmitted: [] };
    }

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

    // Dismiss any browser alert dialogs automatically
    page.on("dialog", async (dialog) => {
        console.error(`Dialog: "${dialog.message()}" → dismissing`);
        await dialog.accept();
    });

    try {
        console.error(`Navigating to contest: ${contestUrl}`);
        await page.goto(contestUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(2000);

        // Click "SUBMIT YOUR ENTRY" to open the side panel
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
                    console.error(`Opened entry panel via: ${sel}`);
                    await page.waitForTimeout(2000);
                    formOpened = true;
                    break;
                }
            } catch { /* ignore */ }
        }
        if (!formOpened) {
            console.error("Warning: could not find 'SUBMIT YOUR ENTRY' button — panel may already be open");
        }

        // Get already-submitted names to skip duplicates
        const existingEntries = await page.locator(".my-entries .entry-name, .submitted-entries li, .my-submissions .name").allTextContents();
        const existingSet = new Set(existingEntries.map((n) => n.trim().toLowerCase()));
        console.error(`Already submitted ${existingEntries.length} entries in this contest`);

        // Filter out already-submitted names
        const toSubmit = names.filter((n) => {
            if (existingSet.has(n.toLowerCase())) {
                console.error(`Skip (already submitted): ${n}`);
                alreadySubmitted.push(n);
                return false;
            }
            return true;
        });

        console.error(`Submitting ${toSubmit.length} names in batches of ${BATCH_SIZE}...`);

        // Submit in batches of 3
        const batches = chunk(toSubmit, BATCH_SIZE);
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx];
            console.error(`\nBatch ${batchIdx + 1}/${batches.length}: ${batch.join(", ")}`);

            // Find all visible "Domain Name" inputs in the panel
            // atom.com shows 3 numbered slots; fill each one
            const domainInputSelectors = [
                "input[placeholder*='domain' i]",
                "input[placeholder*='name' i]",
                "input[name*='domain' i]",
                "input[name*='name' i]",
                "input[name*='entry' i]",
                ".entry-form input[type='text']",
                ".submit-panel input[type='text']",
                "[class*='submit'] input[type='text']",
                "[class*='entry'] input[type='text']",
            ];

            // Collect all visible text inputs in the panel
            async function getVisibleInputs() {
                for (const sel of domainInputSelectors) {
                    const locs = page.locator(sel);
                    const count = await locs.count();
                    if (count > 0) {
                        const visible = [];
                        for (let i = 0; i < count; i++) {
                            if (await locs.nth(i).isVisible().catch(() => false)) {
                                visible.push(locs.nth(i));
                            }
                        }
                        if (visible.length > 0) {
                            console.error(`Found ${visible.length} input(s) via: ${sel}`);
                            return visible;
                        }
                    }
                }
                // Fallback: all visible text inputs
                const all = page.locator("input[type='text']");
                const count = await all.count();
                const visible = [];
                for (let i = 0; i < count; i++) {
                    if (await all.nth(i).isVisible().catch(() => false)) {
                        visible.push(all.nth(i));
                    }
                }
                if (visible.length > 0) {
                    console.error(`Found ${visible.length} input(s) via fallback`);
                    return visible;
                }
                return [];
            }

            // If batch has fewer names than BATCH_SIZE, we only fill that many slots
            const inputs = await getVisibleInputs();
            if (inputs.length === 0) {
                // Dump page for debugging
                const html = await page.content();
                const { mkdirSync, writeFileSync } = await import("fs");
                mkdirSync(path.join(__dirname, "logs"), { recursive: true });
                writeFileSync(path.join(__dirname, "logs", "debug-page.html"), html);
                const err = `No domain inputs found in batch ${batchIdx + 1}. HTML dumped to logs/debug-page.html`;
                console.error(err);
                batch.forEach((n) => failed.push({ name: n, error: err }));
                break;
            }

            // Fill slots — use min(batch.length, inputs.length) to avoid overflow
            const fillCount = Math.min(batch.length, inputs.length);
            let batchOk = true;
            for (let i = 0; i < fillCount; i++) {
                try {
                    await inputs[i].clear();
                    await inputs[i].fill(batch[i]);
                    await sleep(200);
                    console.error(`  Filled slot ${i + 1}: ${batch[i]}`);
                } catch (err) {
                    console.error(`  Failed to fill slot ${i + 1} (${batch[i]}): ${err.message}`);
                    failed.push({ name: batch[i], error: err.message });
                    batchOk = false;
                }
            }

            if (!batchOk) continue;

            // Click the Submit button (submits all filled slots at once)
            try {
                const submitBtn = page.locator("button:has-text('Submit'), input[type='submit'][value*='Submit' i]").first();
                if (await submitBtn.count() > 0 && await submitBtn.isVisible()) {
                    await submitBtn.click();
                    console.error(`  Clicked Submit`);
                } else {
                    // Press Enter on last filled input
                    await inputs[fillCount - 1].press("Enter");
                    console.error(`  Pressed Enter to submit`);
                }

                // Wait for form to process (dialog auto-accepted by listener above)
                await page.waitForTimeout(3000);

                // Check for inline error
                const errorMsg = await page.locator(".error-message, .alert-danger, .submission-error, [class*='error']").first().textContent().catch(() => "");
                if (errorMsg && /error|invalid|failed/i.test(errorMsg)) {
                    const errTrimmed = errorMsg.trim();
                    console.error(`  Submission error: ${errTrimmed}`);
                    batch.slice(0, fillCount).forEach((n) => failed.push({ name: n, error: errTrimmed }));
                    continue;
                }

                batch.slice(0, fillCount).forEach((n) => {
                    submitted.push(n);
                    existingSet.add(n.toLowerCase());
                });
                console.error(`  ✓ Batch submitted: ${batch.slice(0, fillCount).join(", ")}`);

            } catch (err) {
                console.error(`  Submit click failed: ${err.message}`);
                batch.slice(0, fillCount).forEach((n) => failed.push({ name: n, error: err.message }));
            }

            // Polite delay between batches
            await sleep(3000);
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
