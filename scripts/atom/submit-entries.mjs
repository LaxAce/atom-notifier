/**
 * Submit name entries to an atom.com contest using Playwright.
 *
 * atom.com submission flow:
 *   1. Click "SUBMIT YOUR ENTRY" button to open the entry panel
 *   2. Fill "Domain Name" input
 *   3. Click the Submit button in the panel
 *   4. Wait for the input to clear (confirms submission)
 *   5. Repeat for each name
 *
 * Usage:
 *   node submit-entries.mjs --contest-url "https://atom.com/contest/..." --names "Name1,Name2,..."
 */

import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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

async function dumpPageState(page, label) {
    console.error(`\n── PAGE STATE: ${label} ──`);

    // All visible buttons
    const btns = await page.locator("button, input[type='submit'], a.btn, [role='button']").all();
    console.error(`Buttons (${btns.length}):`);
    for (const b of btns.slice(0, 20)) {
        const text = (await b.textContent().catch(() => "")).trim().slice(0, 60);
        const type = await b.getAttribute("type").catch(() => "");
        const cls = (await b.getAttribute("class").catch(() => "") || "").slice(0, 60);
        const vis = await b.isVisible().catch(() => false);
        if (vis) console.error(`  [visible] "${text}" type="${type}" class="${cls}"`);
    }

    // All visible inputs
    const inputs = await page.locator("input").all();
    console.error(`Inputs (${inputs.length}):`);
    for (const inp of inputs.slice(0, 20)) {
        const vis = await inp.isVisible().catch(() => false);
        if (!vis) continue;
        const type = await inp.getAttribute("type").catch(() => "text");
        const name = await inp.getAttribute("name").catch(() => "");
        const placeholder = await inp.getAttribute("placeholder").catch(() => "");
        const id = await inp.getAttribute("id").catch(() => "");
        const cls = (await inp.getAttribute("class").catch(() => "") || "").slice(0, 60);
        console.error(`  [visible] type="${type}" name="${name}" id="${id}" placeholder="${placeholder}" class="${cls}"`);
    }
    console.error(`──────────────────────────────────────`);
}

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

    // Auto-dismiss any browser alert dialogs
    page.on("dialog", async (dialog) => {
        console.error(`Dialog: "${dialog.message()}" → dismissing`);
        await dialog.accept();
    });

    try {
        console.error(`Navigating to contest: ${contestUrl}`);
        await page.goto(contestUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(3000);

        await dumpPageState(page, "after page load");

        // Click "SUBMIT YOUR ENTRY" to open the entry panel
        const openFormSelectors = [
            "button:has-text('SUBMIT YOUR ENTRY')",
            "a:has-text('SUBMIT YOUR ENTRY')",
            "[class*='submit']:has-text('SUBMIT')",
            "button:has-text('Submit Your Entry')",
            "a:has-text('Submit Your Entry')",
        ];
        let formOpened = false;
        for (const sel of openFormSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.count() > 0 && await btn.isVisible()) {
                    await btn.click();
                    console.error(`Opened entry panel via: ${sel}`);
                    await page.waitForTimeout(3000);
                    formOpened = true;
                    break;
                }
            } catch { /* ignore */ }
        }
        if (!formOpened) {
            console.error("Warning: 'SUBMIT YOUR ENTRY' button not found — panel may already be open or URL needs #tab-2");
        }

        await dumpPageState(page, "after opening entry panel");

        // Dismiss Intercom chat widget — it appears as a floating iframe that
        // intercepts pointer events on the input field after the first submission.
        await page.evaluate(() => {
            const ic = document.getElementById("intercom-container");
            if (ic) ic.style.display = "none";
            const icFrame = document.getElementById("intercom-frame");
            if (icFrame) icFrame.style.display = "none";
        });
        console.error("Intercom widget hidden");

        // Detect expired session: login modal or sign-in link appeared
        const loginSignals = await page.locator(
            "[class*='login']:visible, [class*='signin']:visible, " +
            "a:has-text('Sign In'):visible, a:has-text('Log In'):visible, " +
            "button:has-text('Sign In'):visible, button:has-text('Log In'):visible, " +
            "input[type='email']:visible, input[type='password']:visible"
        ).count();
        if (loginSignals > 0) {
            throw new Error(
                "Session expired: login prompt detected. CONTEST_COOKIES needs to be refreshed in GitHub Secrets."
            );
        }

        // Find the domain name input — log all candidates
        // NOTE: generic input[type='text'] intentionally omitted to avoid filling login/search boxes
        async function findDomainInput() {
            const selectors = [
                "input[name*='domain' i]",
                "input[placeholder*='domain' i]",
                "input[placeholder*='name' i]",
                "input[name*='entry' i]",
                "input[name*='suggestion' i]",
                "input[placeholder*='brand' i]",
                "input[placeholder*='word' i]",
                "input[placeholder*='idea' i]",
                "input[placeholder*='suggest' i]",
            ];
            for (const sel of selectors) {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    console.error(`Domain input found via: ${sel}`);
                    return loc;
                }
            }
            return null;
        }

        // Find the Submit button — try multiple strategies
        async function findSubmitButton() {
            const selectors = [
                "button.entry_form_submit",
                "[class*='entry_form_submit']",
                "button[type='submit']",
                "input[type='submit']",
                "button:has-text('Submit')",
                "button:has-text('SUBMIT')",
                "button:has-text('submit')",
                "[class*='submit-btn']",
                "[class*='btn-submit']",
                "[class*='submit'][type='button']",
            ];
            for (const sel of selectors) {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    const text = (await loc.textContent().catch(() => "")).trim();
                    console.error(`Submit button found via: ${sel} (text: "${text}")`);
                    return loc;
                }
            }
            // Last resort: find any button near the domain input that looks like a submit
            console.error("Submit button not found via selectors — trying last visible button");
            const allBtns = await page.locator("button:visible").all();
            if (allBtns.length > 0) {
                const last = allBtns[allBtns.length - 1];
                const text = (await last.textContent().catch(() => "")).trim();
                console.error(`Using last visible button: "${text}"`);
                return last;
            }
            return null;
        }

        const firstInput = await findDomainInput();
        if (!firstInput) {
            const html = await page.content();
            mkdirSync(path.join(__dirname, "logs"), { recursive: true });
            writeFileSync(path.join(__dirname, "logs", "debug-page.html"), html);
            throw new Error("Could not find Domain Name input. HTML dumped to logs/debug-page.html.");
        }

        // Submit names one by one — simpler and works regardless of slot count
        for (const name of names) {
            if (alreadySubmitted.includes(name)) continue;

            try {
                const input = await findDomainInput();
                if (!input) throw new Error("Domain input disappeared");

                // Re-hide Intercom in case it reappeared since the panel was opened
                await page.evaluate(() => {
                    const ic = document.getElementById("intercom-container");
                    if (ic) ic.style.display = "none";
                }).catch(() => {});

                // Clear and fill — force:true bypasses Intercom iframe pointer interception
                await input.click({ force: true });
                await input.clear();
                await input.fill(name);
                await sleep(300);

                // Verify fill worked
                const val = await input.inputValue().catch(() => "");
                if (!val) {
                    // Try triple-click + type as fallback for React inputs
                    await input.click({ clickCount: 3 });
                    await input.type(name, { delay: 50 });
                    await sleep(300);
                }
                console.error(`Filled: ${name}`);

                // Trigger blur to fire the domain availability XHR (contests.php?action=entry_available).
                // atom.com validates on blur — without this the Submit button does nothing.
                await input.press("Tab");
                console.error(`Triggered blur for availability check: ${name}`);

                // Wait for the availability XHR to complete — atom.com shows:
                //   ✓ "Ok to submit. <name>.com is available."  → proceed
                //   ✗ "not available" / "not accepting"          → skip this entry
                // We wait up to 5s; timeout means we can't confirm either way → submit anyway.
                try {
                    await page.waitForFunction(
                        () => {
                            const body = document.body.innerText.toLowerCase();
                            return (
                                body.includes("ok to submit") ||
                                body.includes("is available") ||
                                body.includes("not available") ||
                                body.includes("not accepting") ||
                                body.includes("already taken") ||
                                body.includes("domain is not")
                            );
                        },
                        { timeout: 5000 }
                    );
                    // Check if the result was negative
                    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
                    const isUnavailable =
                        bodyText.includes("not available") ||
                        bodyText.includes("not accepting") ||
                        bodyText.includes("already taken") ||
                        bodyText.includes("domain is not");
                    if (isUnavailable) {
                        console.error(`✗ Skipped (domain unavailable on atom.com): ${name}`);
                        failed.push({ name, error: "Domain not available per atom.com availability check" });
                        continue;
                    }
                    console.error(`Availability confirmed: ${name}`);
                } catch {
                    console.error(`Availability check timed out — submitting anyway: ${name}`);
                }

                // Click the submit button via force-click (bypasses hidden-xs/React visibility issues),
                // falling back to JS evaluate click.
                let submitClicked = false;
                try {
                    await page.locator(".entry_form_submit").first().click({ force: true, timeout: 3000 });
                    console.error(`Clicked Submit for: ${name} (force .entry_form_submit)`);
                    submitClicked = true;
                } catch {
                    // force-click failed — try JS evaluate as last resort
                    submitClicked = await page.evaluate(() => {
                        const btn = document.querySelector(".entry_form_submit") ||
                                    document.querySelector("button[type='submit']") ||
                                    document.querySelector("form .btn-primary");
                        if (btn) { btn.click(); return true; }
                        return false;
                    });
                    if (submitClicked) {
                        console.error(`Clicked Submit for: ${name} (JS evaluate)`);
                    } else {
                        await input.press("Enter");
                        console.error(`Pressed Enter for: ${name} (no submit button found)`);
                    }
                }

                // Wait for form to process
                await page.waitForTimeout(2000);

                // Check for error messages — use allTextContents() so we don't wait 30s for elements that aren't there
                const errEls = await page.locator("[class*='error']:visible, [class*='alert']:visible, [class*='danger']:visible").allTextContents().catch(() => []);
                const errEl = errEls.join(" ").trim();
                if (errEl && /error|invalid|failed|not accept/i.test(errEl)) {
                    throw new Error(errEl.slice(0, 200));
                }

                // Positive confirmation: after a real submission atom.com clears the input field.
                // If the value is still our name, the form didn't process — count as failed.
                const inputAfter = await findDomainInput();
                const valAfter = inputAfter ? await inputAfter.inputValue().catch(() => name) : "";
                if (valAfter === name) {
                    throw new Error(`Input not cleared after submit — atom.com may not have accepted the entry`);
                }

                submitted.push(name);
                console.error(`✓ Submitted: ${name}`);

                // After submission atom.com closes the entry panel (shows a confirmation).
                // We need to re-open it by clicking "SUBMIT YOUR ENTRY" again.
                await sleep(1500);
                const reopenSelectors = [
                    "button:has-text('SUBMIT YOUR ENTRY')",
                    "a:has-text('SUBMIT YOUR ENTRY')",
                    "button:has-text('Submit Your Entry')",
                    "a:has-text('Submit Your Entry')",
                ];
                let panelReopened = false;
                for (const sel of reopenSelectors) {
                    try {
                        const btn = page.locator(sel).first();
                        if (await btn.count() > 0 && await btn.isVisible()) {
                            await btn.click();
                            console.error(`Re-opened entry panel via: ${sel}`);
                            await page.waitForTimeout(2000);
                            panelReopened = true;
                            break;
                        }
                    } catch { /* ignore */ }
                }
                if (!panelReopened) {
                    console.error(`Could not re-open entry panel — input may still be visible`);
                }

                // Re-hide Intercom after panel re-open
                await page.evaluate(() => {
                    const ic = document.getElementById("intercom-container");
                    if (ic) ic.style.display = "none";
                }).catch(() => {});

            } catch (err) {
                console.error(`✗ Failed: ${name} — ${err.message}`);
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
