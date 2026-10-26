import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
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

export async function submitEntries(
    contestUrl: string,
    names: string[],
    { dryRun = false } = {}
): Promise<{ submitted: string[]; failed: { name: string; error: string }[]; alreadySubmitted: string[] }> {
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

        // Accept NDA if required — without this, the submission form won't appear
        const ndaAccepted = await acceptNdaIfRequired(page);
        if (ndaAccepted) {
            await page.waitForTimeout(2000);
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

        const firstInput = await findDomainInput();
        if (!firstInput) {
            const html = await page.content();
            mkdirSync(path.join(__dirname, "logs"), { recursive: true });
            writeFileSync(path.join(__dirname, "logs", "debug-page.html"), html);
            throw new Error("Could not find Domain Name input. HTML dumped to logs/debug-page.html.");
        }

        for (const name of names) {
            if (alreadySubmitted.includes(name)) continue;

            try {
                const input = await findDomainInput();
                if (!input) throw new Error("Domain input disappeared");

                await page.evaluate(() => {
                    const ic = document.getElementById("intercom-container");
                    if (ic) (ic as HTMLElement).style.display = "none";
                }).catch(() => {});

                await input.click({ force: true });
                await input.clear();
                await input.fill(name);
                await sleep(300);

                const val = await input.inputValue().catch(() => "");
                if (!val) {
                    await input.click({ clickCount: 3 });
                    await input.type(name, { delay: 50 });
                    await sleep(300);
                }
                console.error(`Filled: ${name}`);

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

        if (!contestUrl || !namesStr) {
            console.error("Usage: npx tsx submit-entries.ts --contest-url <url> --names <comma-separated-names>");
            process.exit(1);
        }

        const names = namesStr.split(",").map((n) => n.trim()).filter(Boolean);
        console.error(`Submitting ${names.length} names to ${contestUrl}${dryRun ? " (DRY RUN)" : ""}...`);

        const result = await submitEntries(contestUrl, names, { dryRun });
        console.log(JSON.stringify(result, null, 2));
        console.error(`Done: ${result.submitted.length} submitted, ${result.failed.length} failed, ${result.alreadySubmitted.length} already submitted`);
    })();
}
