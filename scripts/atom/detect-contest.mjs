/**
 * Detect new contests on atom.com.
 * Compares current latest contest ID against lastParticipatedId in GitHub Gist.
 * Writes CONTEST_URL and IS_NEW to GitHub Actions output.
 *
 * Uses lastParticipatedId (separate from the notifier's lastContestId) so the
 * notifier's 3-min detection cycle doesn't prevent this script from participating.
 */

import axios from "axios";
import { readFileSync, existsSync, appendFileSync } from "fs";
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

function writeOutput(key, value) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
        appendFileSync(outputFile, `${key}=${value}\n`);
    }
    console.error(`Output: ${key}=${value}`);
}

async function readStateFromGist() {
    const { GIST_ID, GIST_TOKEN, GIST_NAME } = process.env;
    if (!GIST_ID || !GIST_TOKEN) return {};

    try {
        const response = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { Authorization: `token ${GIST_TOKEN}`, "User-Agent": "atom-contest-bot" },
        });
        const content = response.data.files?.[GIST_NAME || "state.json"]?.content || "{}";
        return JSON.parse(content);
    } catch {
        return {};
    }
}

async function writeStateToGist(state) {
    const { GIST_ID, GIST_TOKEN, GIST_NAME } = process.env;
    if (!GIST_ID || !GIST_TOKEN) return;

    const fileName = GIST_NAME || "state.json";
    await axios.patch(
        `https://api.github.com/gists/${GIST_ID}`,
        { files: { [fileName]: { content: JSON.stringify(state, null, 2) } } },
        { headers: { Authorization: `token ${GIST_TOKEN}`, "User-Agent": "atom-contest-bot" } }
    );
}

async function detectContest() {
    const contestUrl = process.env.CONTEST_URL;
    const cookies = process.env.CONTEST_COOKIES;

    if (!contestUrl || !cookies) {
        console.error("CONTEST_URL and CONTEST_COOKIES are required");
        writeOutput("IS_NEW", "false");
        return;
    }

    // Fetch current contest list
    const response = await axios.get(contestUrl, {
        headers: { Cookie: cookies, "User-Agent": "Mozilla/5.0" },
        timeout: 15000,
    });

    const html = response.data;

    // Same regex as atom-notifier
    const match = html.match(
        /<ul class="content pull-left watching_contests">\s*<li[^>]*data-contest-id="([^"]+)"[^>]*>[\s\S]*?<div class="top clearfix">\s*<a href="([^"]+)">\s*([^<]+(?:\s*<span[^>]*>[^<]*<\/span>)?)\s*<\/a>[\s\S]*?<a[^>]*href="\/branding-marketing-naming-contests"[^>]*>Naming\s*<span>\/<\/span>\s*(Company Name|Tagline)\s*<\/a>/
    );

    if (!match) {
        console.error("No contests found in HTML");
        writeOutput("IS_NEW", "false");
        return;
    }

    const [, contestId, contestPath, contestTitle] = match;
    const fullContestUrl = `https://atom.com${contestPath}`;

    console.error(`Latest contest: ${contestId} — ${contestTitle}`);

    const state = await readStateFromGist();
    // Use a separate field from the notifier's lastContestId so they don't conflict.
    // The notifier writes lastContestId; we track lastParticipatedId independently.
    const lastParticipatedId = state.lastParticipatedId;

    if (contestId === lastParticipatedId) {
        console.error("No new contest (already participated).");
        writeOutput("IS_NEW", "false");
        return;
    }

    console.error(`NEW contest detected: ${contestId} — ${contestTitle}`);
    console.error(`URL: ${fullContestUrl}`);

    await writeStateToGist({ ...state, lastParticipatedId: contestId });

    writeOutput("IS_NEW", "true");
    writeOutput("CONTEST_URL", fullContestUrl);
    writeOutput("CONTEST_ID", contestId);
}

await detectContest();
