import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import OpenAI from "openai";
import { acceptNdaIfRequired } from "./parse-brief";

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

function parseCookies(cookieStr: string) {
    return cookieStr.split(";").map((part) => {
        const [name, ...rest] = part.trim().split("=");
        return { name: name.trim(), value: rest.join("=").trim(), domain: ".atom.com", path: "/" };
    }).filter((c) => c.name && c.value);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function dumpPageState(page: any, label: string): Promise<void> {
    console.error(`\n── PAGE STATE: ${label} ──`);
    const btns = await page.locator("button, input[type='submit'], a.btn, [role='button']").all();
    console.error(`Buttons (${btns.length}):`);
    for (const b of btns.slice(0, 20)) {
        const text = (await b.textContent().catch(() => "")).trim().slice(0, 60);
        const type = await b.getAttribute("type").catch(() => "");
        const cls = (await b.getAttribute("class").catch(() => "") || "").slice(0, 60);
        const vis = await b.isVisible().catch(() => false);
        if (vis) console.error(`  [visible] "${text}" type="${type}" class="${cls}"`);
    }
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

/**
 * Confirm the domain input's React event handlers are mounted before submitting.
 * Types a single character and verifies the input value updates — this only
 * succeeds once React's onChange handler is attached. Retries up to 8 times
 * with 1s gaps before giving up and proceeding anyway.
 */
async function waitForFormReady(
    page: any,
    findInput: () => Promise<any>
): Promise<void> {
    console.error("Waiting for form to be ready...");

    const domSelectors = [
        "input[name*='domain' i]",
        "input[placeholder*='domain' i]",
        "input[name*='company' i]",
        "input[placeholder*='name' i]",
        "input[name*='entry' i]",
        "input[name*='suggestion' i]",
    ];
    try {
        await page.waitForSelector(domSelectors.join(", "), {
            state: "visible",
            timeout: 15000,
        });
    } catch {
        console.error("  Warning: timed out waiting for input to appear in DOM");
    }

    for (let attempt = 1; attempt <= 8; attempt++) {
        const input = await findInput();
        if (!input) {
            console.error(`  Attempt ${attempt}/8: input not found — waiting 1s...`);
            await page.waitForTimeout(1000);
            continue;
        }

        await input.click({ force: true });
        await input.type("x", { delay: 50 });
        await page.waitForTimeout(200);
        const val = await input.inputValue().catch(() => "");

        await input.press("Control+a");
        await input.press("Delete");
        await page.waitForTimeout(100);

        if (val === "x") {
            console.error(`  Form ready — React handlers confirmed on attempt ${attempt}`);
            return;
        }

        console.error(`  Attempt ${attempt}/8: typed 'x' but value='${val}' — React not ready yet, waiting 1s...`);
        await page.waitForTimeout(1000);
    }

    console.error("  Warning: could not confirm form readiness after 8 attempts — proceeding anyway");
}

function stripAiTells(text: string): string {
    // Em dashes and en dashes are strong AI tells. Replace with a comma+space
    // so the sentence still reads naturally.
    return text
        .replace(/\s*[—–]\s*/g, ", ") // — and –
        .replace(/,\s*,/g, ",")               // clean up double commas
        .trim();
}

/**
 * Generate a short, human-sounding description for every name in one OpenAI
 * call. Returns a map of { name -> description }. Falls back gracefully to {}
 * if OPENAI_API_KEY is absent, brief is empty, or the call fails.
 */
async function generateDescriptions(
    names: string[],
    brief: string,
    contestTitle: string
): Promise<Record<string, string>> {
    if (!process.env.OPENAI_API_KEY || !brief || names.length === 0) return {};

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

        const res = await openai.chat.completions.create({
            model,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content:
                        "You write short submission notes for naming contest entries. " +
                        "For each name: 1-2 sentences, plain conversational tone, specific to the brief. " +
                        "NEVER use em dashes (—) or en dashes (–). Use commas or short sentences instead. " +
                        "No buzzwords. No filler phrases like 'this name captures' or 'embodies the essence of'. " +
                        "Max 45 words per name. Respond as JSON: { \"Name\": \"description\", ... }",
                },
                {
                    role: "user",
                    content:
                        `Contest: ${contestTitle}\n` +
                        `Brief: ${brief.slice(0, 500)}\n\n` +
                        `Names:\n${names.map((n) => `- ${n}`).join("\n")}\n\n` +
                        "Write a description for each name.",
                },
            ],
            max_tokens: 60 * names.length,
            temperature: 0.65,
        });

        const raw = res.choices[0].message.content?.trim() || "{}";
        const parsed = JSON.parse(raw) as Record<string, string>;

        // Strip any em/en dashes that slipped through despite the instruction.
        const cleaned: Record<string, string> = {};
        for (const [name, desc] of Object.entries(parsed)) {
            cleaned[name] = stripAiTells(String(desc));
        }

        console.error(`Generated descriptions for ${Object.keys(cleaned).length}/${names.length} names`);
        return cleaned;
    } catch (err) {
        console.error(`Warning: description generation failed — ${(err as any).message}`);
        return {};
    }
}

export async function submitEntries(
    contestUrl: string,
    names: string[],
    { dryRun = false, brief = "", contestTitle = "" } = {}
): Promise<{ submitted: string[]; failed: { name: string; error: string }[]; alreadySubmitted: string[] }> {
    const cookies = process.env.CONTEST_COOKIES;
    if (!cookies) throw new Error("CONTEST_COOKIES env var is required");

    if (dryRun) {
        console.error(`[DRY RUN] Would submit ${names.length} names to ${contestUrl}:`);
        names.forEach((n) => console.error(`  - ${n}`));
        return { submitted: [...names], failed: [], alreadySubmitted: [] };
    }

    console.error(`Generating name descriptions via OpenAI...`);
    const descriptions = await generateDescriptions(names, brief, contestTitle);

    console.error(`Launching browser (headless)...`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    await context.addCookies(parseCookies(cookies));
    const page = await context.newPage();
    const submitted: string[] = [];
    const failed: { name: string; error: string }[] = [];
    const alreadySubmitted: string[] = [];

    page.on("dialog", async (dialog: any) => {
        console.error(`Dialog: "${dialog.message()}" → dismissing`);
        await dialog.accept();
    });

    try {
        console.error(`Navigating to contest: ${contestUrl}`);
        await page.goto(contestUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(3000);

        const ndaAccepted = await acceptNdaIfRequired(page);
        if (ndaAccepted) {
            try {
                await page.waitForSelector(
                    "button:has-text('SUBMIT YOUR ENTRY'), a:has-text('SUBMIT YOUR ENTRY'), " +
                    "button:has-text('Submit Your Entry'), a:has-text('Submit Your Entry')",
                    { state: "visible", timeout: 10000 }
                );
            } catch {
                await page.waitForTimeout(2000);
            }
        }

        await dumpPageState(page, "after page load");

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

        await page.evaluate(() => {
            const ic = document.getElementById("intercom-container");
            if (ic) (ic as HTMLElement).style.display = "none";
            const icFrame = document.getElementById("intercom-frame");
            if (icFrame) (icFrame as HTMLElement).style.display = "none";
        });
        console.error("Intercom widget hidden");

        const loginSignals = await page.locator(
            "[class*='login']:visible, [class*='signin']:visible, " +
            "a:has-text('Sign In'):visible, a:has-text('Log In'):visible, " +
            "button:has-text('Sign In'):visible, button:has-text('Log In'):visible, " +
            "input[type='email']:visible, input[type='password']:visible"
        ).count();
        if (loginSignals > 0) {
            throw new Error("Session expired: login prompt detected. CONTEST_COOKIES needs to be refreshed in GitHub Secrets.");
        }

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

        async function findCompanyNameInput() {
            const selectors = [
                "input[name*='company' i]",
                "input[id*='company' i]",
                "input[placeholder*='company name' i]",
                "input[placeholder*='company' i]",
            ];
            for (const sel of selectors) {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    console.error(`Company name input found via: ${sel}`);
                    return loc;
                }
            }
            return null;
        }

        async function findDescriptionTextarea() {
            const selectors = [
                "textarea[placeholder*='Describe Your Name' i]",
                "textarea[placeholder*='meaning behind' i]",
                "textarea[placeholder*='describe' i]",
                "textarea[name*='description' i]",
                "textarea[name*='reason' i]",
                "textarea[name*='note' i]",
            ];
            for (const sel of selectors) {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    return loc;
                }
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

        await waitForFormReady(page, findDomainInput);

        const hasCompanyNameField = !!(await findCompanyNameInput());
        console.error(`Form layout: ${hasCompanyNameField ? "Company Name + Domain Name (two fields)" : "Domain Name only (one field)"}`);

        for (const name of names) {
            if (alreadySubmitted.includes(name)) continue;

            try {
                await page.evaluate(() => {
                    const ic = document.getElementById("intercom-container");
                    if (ic) (ic as HTMLElement).style.display = "none";
                }).catch(() => {});

                if (hasCompanyNameField) {
                    const companyInput = await findCompanyNameInput();
                    if (companyInput) {
                        await companyInput.click({ force: true });
                        await companyInput.press("Control+a");
                        await companyInput.press("Delete");
                        await companyInput.type(name, { delay: 30 });
                        await sleep(200);
                        console.error(`Filled company name: ${name}`);
                    }
                }

                const input = await findDomainInput();
                if (!input) throw new Error("Domain input disappeared");

                await input.click({ force: true });
                await input.press("Control+a");
                await input.press("Delete");
                await input.type(name, { delay: 30 });
                await sleep(300);

                console.error(`Filled domain name: ${name}`);

                await input.press("Tab");
                console.error(`Triggered blur for availability check: ${name}`);

                try {
                    await page.waitForFunction(
                        () => {
                            const body = (document.body as HTMLElement).innerText.toLowerCase();
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
                    const bodyText = await page.evaluate(() => (document.body as HTMLElement).innerText.toLowerCase());
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

                const description = descriptions[name] || "";
                if (description) {
                    const textarea = await findDescriptionTextarea();
                    if (textarea) {
                        await textarea.click({ force: true });
                        await textarea.press("Control+a");
                        await textarea.press("Delete");
                        await textarea.type(description, { delay: 15 });
                        console.error(`Filled description: ${description.slice(0, 80)}${description.length > 80 ? "..." : ""}`);
                        await sleep(150);
                    }
                }

                let submitClicked = false;
                try {
                    await page.locator(".entry_form_submit").first().click({ force: true, timeout: 3000 });
                    console.error(`Clicked Submit for: ${name} (force .entry_form_submit)`);
                    submitClicked = true;
                } catch {
                    submitClicked = await page.evaluate(() => {
                        const btn = document.querySelector(".entry_form_submit") ||
                                    document.querySelector("button[type='submit']") ||
                                    document.querySelector("form .btn-primary");
                        if (btn) { (btn as HTMLElement).click(); return true; }
                        return false;
                    });
                    if (submitClicked) {
                        console.error(`Clicked Submit for: ${name} (JS evaluate)`);
                    } else {
                        await input.press("Enter");
                        console.error(`Pressed Enter for: ${name} (no submit button found)`);
                    }
                }

                await page.waitForTimeout(2000);

                const errEls = await page.locator("[class*='error']:visible, [class*='alert']:visible, [class*='danger']:visible").allTextContents().catch(() => []);
                const errEl = (errEls as string[]).join(" ").trim();
                if (errEl && /error|invalid|failed|not accept/i.test(errEl)) {
                    throw new Error(errEl.slice(0, 200));
                }

                const inputAfter = await findDomainInput();
                const valAfter = inputAfter ? await inputAfter.inputValue().catch(() => name) : "";
                if (valAfter === name) {
                    throw new Error(`Input not cleared after submit — atom.com may not have accepted the entry`);
                }

                submitted.push(name);
                console.error(`✓ Submitted: ${name}`);

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

                await page.evaluate(() => {
                    const ic = document.getElementById("intercom-container");
                    if (ic) (ic as HTMLElement).style.display = "none";
                }).catch(() => {});

            } catch (err) {
                console.error(`✗ Failed: ${name} — ${(err as any).message}`);
                failed.push({ name, error: (err as any).message });
            }
        }

    } finally {
        await browser.close();
    }

    return { submitted, failed, alreadySubmitted };
}

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const get = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
        const has = (flag: string) => args.includes(flag);

        const contestUrl = get("--contest-url");
        const namesStr = get("--names") || "";
        const dryRun = has("--dry-run");
        const brief = get("--brief") || "";
        const contestTitle = get("--title") || "";

        if (!contestUrl || !namesStr) {
            console.error("Usage: npx tsx submit-entries.ts --contest-url <url> --names <comma-separated-names> [--brief <text>] [--title <text>]");
            process.exit(1);
        }

        const names = namesStr.split(",").map((n) => n.trim()).filter(Boolean);
        console.error(`Submitting ${names.length} names to ${contestUrl}${dryRun ? " (DRY RUN)" : ""}...`);

        const result = await submitEntries(contestUrl, names, { dryRun, brief, contestTitle });
        console.log(JSON.stringify(result, null, 2));
        console.error(`Done: ${result.submitted.length} submitted, ${result.failed.length} failed, ${result.alreadySubmitted.length} already submitted`);
    })();
}
