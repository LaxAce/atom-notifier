import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { scrapeContestPage, parseContestHtml, parseBriefWithAI, pickNameStyle, BriefData } from "./parse-brief";
import { generateNames } from "./generate-names";
import { selectPremiumNames } from "./select-premium";
import { submitEntries } from "./submit-entries";
import { DEFAULT_SUBMISSION_LIMIT, computeLimits } from "./submission-limits";

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
    {
        dryRun = false,
        requireDomains = true,
        testNames = null as string[] | null,
        likedNames = "",
        dislikedNames = "",
        likedWords = "",
        dislikedWords = "",
        submissionLimit = DEFAULT_SUBMISSION_LIMIT,
    } = {}
): Promise<Record<string, any>> {
    if (contestUrl.includes("/logo-design-contest/")) {
        throw new Error(
            `Skipping logo design contest — this tool only submits names for naming/branding contests. URL: ${contestUrl}`
        );
    }

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
        const aiParsed = await parseBriefWithAI(parsed.rawBrief, parsed.title, parsed.industry);
        const fallbackStyle = pickNameStyle(parsed.styleHints, parsed.contestType);
        briefData = {
            ...parsed,
            compressedBrief: aiParsed.description,
            suggestedStyle: aiParsed.suggestedStyle || fallbackStyle,
            keywords: aiParsed.keywords || parsed.keywords,
            nameQualities: aiParsed.nameQualities,
            avoid: aiParsed.avoid,
            alreadyRejected: aiParsed.alreadyRejected,
        };

        log.steps.parseBrief = {
            success: true,
            title: briefData.title,
            contestType: briefData.contestType,
            industry: briefData.industry,
            keywords: briefData.keywords,
            nameQualities: briefData.nameQualities,
            avoid: briefData.avoid,
            alreadyRejectedCount: briefData.alreadyRejected?.split(",").filter(Boolean).length || 0,
            suggestedStyle: briefData.suggestedStyle,
            premiumAllowed: briefData.premiumAllowed,
        };
        console.error(`  Title: ${briefData.title}`);
        console.error(`  Type: ${briefData.contestType}`);
        console.error(`  Industry: ${briefData.industry}`);
        console.error(`  Domain required: ${briefData.domainRequired}`);
        console.error(`  Premium domains allowed: ${briefData.premiumAllowed}`);
        console.error(`  Suggested style: ${briefData.suggestedStyle}`);
        console.error(`  Keywords: ${briefData.keywords}`);
        console.error(`  Name qualities: ${briefData.nameQualities}`);
        console.error(`  Avoid: ${briefData.avoid}`);
        console.error(`  Already rejected (${log.steps.parseBrief.alreadyRejectedCount}): ${briefData.alreadyRejected?.slice(0, 80)}...`);
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
            submissionResult = await submitEntries(contestUrl, testNames, {
                dryRun,
                brief: briefData.compressedBrief,
                contestTitle: briefData.title,
            });
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

    const { ai: aiLimit, premium: premiumLimit } = computeLimits(submissionLimit);

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
        const nameOnlyContest = !briefData.domainRequired;
        // Name-only and premium-disallowed: all slots go to AI
        const aiCount = (nameOnlyContest || !briefData.premiumAllowed) ? submissionLimit : aiLimit;

        if (nameOnlyContest) {
            console.error(`\nStep 2/5: Name-only contest — generating ${aiCount} names via OpenAI (no domain check)...`);
        } else {
            console.error(`\nStep 2/5: Generating ${aiCount} names via OpenAI${briefData.premiumAllowed ? ` (${aiLimit} AI + ${premiumLimit} premium, total ${submissionLimit})` : ` (${submissionLimit} AI, premium not allowed)`}...`);
        }

        try {
            aiNames = await generateNames({
                description: briefData.compressedBrief,
                keywords: briefData.keywords,
                style: briefData.suggestedStyle,
                extension: briefData.extension || "com",
                count: aiCount,
                requireDomains: nameOnlyContest ? false : requireDomains,
                temperature: 0.7,
                nameQualities: briefData.nameQualities,
                avoid: briefData.avoid,
                alreadyRejected: briefData.alreadyRejected,
                likedNames,
                dislikedNames,
                likedWords,
                dislikedWords,
            });

            log.steps.generateNames = { success: true, count: aiNames.length, names: aiNames };
            console.error(`  Generated ${aiNames.length} names: ${aiNames.slice(0, 5).join(", ")}...`);
        } catch (err) {
            log.steps.generateNames = { success: false, error: (err as any).message };
            saveLog(log);
            throw new Error(`Failed to generate names: ${(err as any).message}`);
        }

        if (nameOnlyContest) {
            console.error(`\nStep 3/5: Skipping premium listings (name-only contest, no domain needed)`);
            log.steps.selectPremium = { success: true, count: 0, names: [], skipped: "name-only contest" };
        } else if (!briefData.premiumAllowed) {
            console.error(`\nStep 3/5: Skipping premium listings (contest does not accept premium domains)`);
            log.steps.selectPremium = { success: true, count: 0, names: [], skipped: "contest does not accept premium domains" };
        } else {
            console.error(`\nStep 3/5: Selecting ${premiumLimit} premium listings...`);
            try {
                premiumNames = selectPremiumNames(briefData.compressedBrief, briefData.industry, premiumLimit);
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

    const allEntries = dedup([...premiumNames, ...aiNames]).slice(0, submissionLimit);
    console.error(`\nStep 4/5: Prepared ${allEntries.length} entries total`);
    console.error(`  Premium: ${premiumNames.length} | AI: ${aiNames.length}`);
    console.error(`  All entries: ${allEntries.join(", ")}`);

    log.steps.prepare = { success: true, totalEntries: allEntries.length, allEntries };

    console.error(`\nStep 5/5: Submitting ${allEntries.length} entries to atom.com...`);
    let submissionResult = { submitted: [] as string[], failed: [] as any[], alreadySubmitted: [] as string[] };
    try {
        submissionResult = await submitEntries(contestUrl, allEntries, {
            dryRun,
            brief: briefData.compressedBrief,
            contestTitle: briefData.title,
        });

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
        const likedNamesArg = args.find((a) => a.startsWith("--liked-names="));
        const likedNames = likedNamesArg ? likedNamesArg.slice("--liked-names=".length) : "";
        const dislikedNamesArg = args.find((a) => a.startsWith("--disliked-names="));
        const dislikedNames = dislikedNamesArg ? dislikedNamesArg.slice("--disliked-names=".length) : "";
        const likedWordsArg = args.find((a) => a.startsWith("--liked-words="));
        const likedWords = likedWordsArg ? likedWordsArg.slice("--liked-words=".length) : "";
        const dislikedWordsArg = args.find((a) => a.startsWith("--disliked-words="));
        const dislikedWords = dislikedWordsArg ? dislikedWordsArg.slice("--disliked-words=".length) : "";
        const submissionLimitArg = args.find((a) => a.startsWith("--submission-limit="));
        const submissionLimit = submissionLimitArg
            ? parseInt(submissionLimitArg.slice("--submission-limit=".length), 10)
            : DEFAULT_SUBMISSION_LIMIT;

        if (!contestUrl) {
            console.error("Usage: npx tsx run-contest.ts <contest-url> [--dry-run] [--no-domains] [--submission-limit=N] [--test-names=Name1,...] [--liked-names=Name1,...] [--disliked-names=Name1,...] [--liked-words=word1,...] [--disliked-words=word1,...]");
            process.exit(1);
        }

        const result = await runContest(contestUrl, { dryRun, requireDomains, testNames, likedNames, dislikedNames, likedWords, dislikedWords, submissionLimit });
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.result?.success ? 0 : 1);
    })();
}
