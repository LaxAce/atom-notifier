import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { scrapeContestPage, parseContestHtml, compressBrief, pickNameStyle, BriefData } from "./parse-brief";
import { generateNames } from "./generate-names";
import { selectPremiumNames } from "./select-premium";
import { submitEntries } from "./submit-entries";

const ENTRIES_PER_CONTEST = 25;
const NAMES_FROM_AI = 20;
const NAMES_FROM_PREMIUM = 5;
const NAMES_FROM_AI_NO_PREMIUM = 25;

const CACHE_FILE = path.join(__dirname, "logs", "names-cache.json");

function loadNamesCache(): Record<string, any> {
    if (!existsSync(CACHE_FILE)) return {};
    try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}

function saveNamesCache(cache: Record<string, any>): void {
    mkdirSync(path.join(__dirname, "logs"), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function contestCacheKey(url: string): string {
    const m = url.match(/\/(\d+)\//);
    return m ? m[1] : url;
}

async function runContest(
    contestUrl: string,
    { dryRun = false, requireDomains = true, testNames = null as string[] | null } = {}
): Promise<Record<string, any>> {
    const startTime = Date.now();
    console.error(`\n${"=".repeat(60)}`);
    console.error(`Atom Contest Automation`);
    console.error(`URL: ${contestUrl}`);
    console.error(`Dry run: ${dryRun} | Domain check: ${requireDomains}`);
    console.error(`${"=".repeat(60)}\n`);

    const log: Record<string, any> = {
        contestUrl,
        startedAt: new Date().toISOString(),
        dryRun,
        steps: {},
        result: null,
    };

    console.error("Step 1/5: Fetching and parsing contest brief...");
    let briefData: BriefData & { compressedBrief: string; suggestedStyle: string };
    try {
        const html = await scrapeContestPage(contestUrl);
        const parsed = parseContestHtml(html, contestUrl);
        const compressedBrief = await compressBrief(parsed.rawBrief, parsed.title, parsed.industry);
        const suggestedStyle = pickNameStyle(parsed.styleHints, parsed.contestType);
        briefData = { ...parsed, compressedBrief, suggestedStyle };

        log.steps.parseBrief = {
            success: true,
            title: briefData.title,
            contestType: briefData.contestType,
            industry: briefData.industry,
            compressedBriefLength: briefData.compressedBrief.length,
            suggestedStyle: briefData.suggestedStyle,
            premiumAllowed: briefData.premiumAllowed,
        };
        console.error(`  Title: ${briefData.title}`);
        console.error(`  Type: ${briefData.contestType}`);
        console.error(`  Industry: ${briefData.industry}`);
        console.error(`  Premium domains allowed: ${briefData.premiumAllowed}`);
        console.error(`  Suggested style: ${briefData.suggestedStyle}`);
        console.error(`  Compressed brief (${briefData.compressedBrief.length} chars): ${briefData.compressedBrief.slice(0, 100)}...`);
    } catch (err) {
        log.steps.parseBrief = { success: false, error: (err as any).message };
        saveLog(log);
        throw new Error(`Failed to parse brief: ${(err as any).message}`);
    }

    if (testNames && testNames.length > 0) {
        console.error(`\nSteps 2–4: Using ${testNames.length} provided test names — skipping OpenAI/RapidAPI`);
        console.error(`  Test names: ${testNames.join(", ")}`);
        log.steps.generateNames = { success: true, count: testNames.length, names: testNames, testMode: true };
        log.steps.selectPremium = { success: true, count: 0, names: [], skipped: "test mode" };
        log.steps.prepare = { success: true, totalEntries: testNames.length, allEntries: testNames };

        console.error(`\nStep 5/5: Submitting ${testNames.length} test entries to atom.com...`);
        let submissionResult = { submitted: [] as string[], failed: [] as any[], alreadySubmitted: [] as string[] };
        try {
            submissionResult = await submitEntries(contestUrl, testNames, { dryRun });
        } catch (err) {
            log.steps.submit = { success: false, error: (err as any).message };
            saveLog(log);
            throw err;
        }
        log.steps.submit = {
            success: true,
            submitted: submissionResult.submitted.length,
            failed: submissionResult.failed.length,
            alreadySubmitted: submissionResult.alreadySubmitted.length,
        };
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
        log.result = { success: true, submitted: submissionResult.submitted.length, failed: submissionResult.failed.length, elapsed, finishedAt: new Date().toISOString() };
        saveLog(log);
        return log;
    }

    const cacheKey = contestCacheKey(contestUrl);
    const namesCache = loadNamesCache();
    const cached = namesCache[cacheKey];

    let aiNames: string[] = [];
    let premiumNames: string[] = [];

    if (cached) {
        console.error(`\nStep 2/5: Using cached names for contest ${cacheKey} (saved ${cached.cachedAt})`);
        aiNames = cached.aiNames || [];
        premiumNames = cached.premiumNames || [];
        log.steps.generateNames = { success: true, count: aiNames.length, names: aiNames, fromCache: true };
        log.steps.selectPremium = { success: true, count: premiumNames.length, names: premiumNames, fromCache: true };
        console.error(`  AI names (${aiNames.length}): ${aiNames.slice(0, 5).join(", ")}...`);
        console.error(`  Premium names (${premiumNames.length}): ${premiumNames.join(", ")}`);
    } else {
        const aiCount = briefData.premiumAllowed ? NAMES_FROM_AI : NAMES_FROM_AI_NO_PREMIUM;
        console.error(`\nStep 2/5: Generating ${aiCount} names via OpenAI${briefData.premiumAllowed ? " (20 AI + 5 premium)" : " (25 AI, premium not allowed)"}...`);
        try {
            aiNames = await generateNames({
                description: briefData.compressedBrief,
                keywords: briefData.keywords,
                style: briefData.suggestedStyle,
                extension: briefData.extension || "com",
                count: aiCount,
                requireDomains,
                temperature: 0.7,
            });

            log.steps.generateNames = { success: true, count: aiNames.length, names: aiNames };
            console.error(`  Generated ${aiNames.length} names: ${aiNames.slice(0, 5).join(", ")}...`);
        } catch (err) {
            log.steps.generateNames = { success: false, error: (err as any).message };
            saveLog(log);
            throw new Error(`Failed to generate names: ${(err as any).message}`);
        }

        if (!briefData.premiumAllowed) {
            console.error(`\nStep 3/5: Skipping premium listings (contest does not accept premium domains)`);
            log.steps.selectPremium = { success: true, count: 0, names: [], skipped: "contest does not accept premium domains" };
        } else {
            console.error(`\nStep 3/5: Selecting ${NAMES_FROM_PREMIUM} premium listings...`);
            try {
                premiumNames = selectPremiumNames(briefData.compressedBrief, briefData.industry, NAMES_FROM_PREMIUM);
                const industryNote = briefData.industry || "no industry detected — using generalist names";
                log.steps.selectPremium = { success: true, count: premiumNames.length, names: premiumNames, industryNote };
                console.error(`  Premium names (${industryNote}): ${premiumNames.join(", ")}`);
            } catch (err) {
                log.steps.selectPremium = { success: false, error: (err as any).message };
                console.error(`  Warning: premium selection failed — ${(err as any).message}`);
            }
        }

        namesCache[cacheKey] = { aiNames, premiumNames, cachedAt: new Date().toISOString() };
        saveNamesCache(namesCache);
        console.error(`  Names cached for contest ${cacheKey}`);
    }

    const allEntries = dedup([...premiumNames, ...aiNames]).slice(0, ENTRIES_PER_CONTEST);
    console.error(`\nStep 4/5: Prepared ${allEntries.length} entries total`);
    console.error(`  Premium: ${premiumNames.length} | AI: ${aiNames.length}`);
    console.error(`  All entries: ${allEntries.join(", ")}`);

    log.steps.prepare = { success: true, totalEntries: allEntries.length, allEntries };

    console.error(`\nStep 5/5: Submitting ${allEntries.length} entries to atom.com...`);
    let submissionResult = { submitted: [] as string[], failed: [] as any[], alreadySubmitted: [] as string[] };
    try {
        submissionResult = await submitEntries(contestUrl, allEntries, { dryRun });

        log.steps.submit = {
            success: true,
            submitted: submissionResult.submitted.length,
            failed: submissionResult.failed.length,
            alreadySubmitted: submissionResult.alreadySubmitted.length,
        };

        console.error(`\n  Submitted: ${submissionResult.submitted.length}`);
        console.error(`  Failed: ${submissionResult.failed.length}`);
        if (submissionResult.failed.length) {
            submissionResult.failed.forEach((f: any) => console.error(`    - ${f.name}: ${f.error}`));
        }
    } catch (err) {
        log.steps.submit = { success: false, error: (err as any).message };
        console.error(`  Submission failed: ${(err as any).message}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const submitStep = log.steps.submit;
    log.result = {
        success: (submitStep?.success !== false) && (submissionResult.submitted.length > 0 || dryRun),
        submitted: submissionResult.submitted.length,
        failed: submissionResult.failed.length,
        elapsed: `${elapsed}s`,
        finishedAt: new Date().toISOString(),
    };

    saveLog(log);

    console.error(`\n${"=".repeat(60)}`);
    console.error(`Done in ${elapsed}s`);
    console.error(`Submitted: ${submissionResult.submitted.length}/${allEntries.length}`);
    console.error(`${"=".repeat(60)}\n`);

    return log;
}

function dedup(arr: string[]): string[] {
    const seen = new Set<string>();
    return arr.filter((x) => {
        const lower = x.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
    });
}

function saveLog(log: Record<string, any>): void {
    const logsDir = path.join(__dirname, "logs");
    mkdirSync(logsDir, { recursive: true });
    const filename = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json";
    writeFileSync(path.join(logsDir, filename), JSON.stringify(log, null, 2));
}

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const contestUrl = args.find((a) => a.startsWith("http"));
        const dryRun = args.includes("--dry-run");
        const requireDomains = !args.includes("--no-domains");
        const testNamesArg = args.find((a) => a.startsWith("--test-names="));
        const testNames = testNamesArg ? testNamesArg.slice("--test-names=".length).split(",").map((n) => n.trim()).filter(Boolean) : null;

        if (!contestUrl) {
            console.error("Usage: npx tsx run-contest.ts <contest-url> [--dry-run] [--no-domains] [--test-names=Name1,Name2,...]");
            process.exit(1);
        }

        const result = await runContest(contestUrl, { dryRun, requireDomains, testNames });
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.result?.success ? 0 : 1);
    })();
}
