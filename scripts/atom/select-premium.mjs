/**
 * Select the 5 most relevant premium listings for a given contest.
 * Scores by keyword overlap and industry match.
 *
 * Usage:
 *   node select-premium.mjs --brief "..." --industry "tech"
 *
 * Outputs JSON to stdout: { selected: [...5 names] }
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function selectPremiumNames(brief, industry, count = 5) {
    const listingsFile = path.join(__dirname, "premium-listings.json");
    if (!existsSync(listingsFile)) return [];

    const data = JSON.parse(readFileSync(listingsFile, "utf8"));
    const names = data.names || [];

    // Filter out placeholder
    const real = names.filter((n) => n.name !== "PLACEHOLDER" && n.price > 0);
    if (real.length === 0) return [];

    const briefLower = (brief || "").toLowerCase();
    const industryLower = (industry || "").toLowerCase();

    // Score each name by relevance
    const scored = real.map((entry) => {
        let score = 0;

        // Industry match
        if (entry.industry?.some((ind) => industryLower.includes(ind.toLowerCase()))) {
            score += 10;
        }

        // Name appears in brief keywords (unlikely but bonus)
        if (briefLower.includes(entry.name.toLowerCase())) score += 5;

        // Short names score higher (atom.com clients prefer them)
        score += Math.max(0, 10 - entry.name.length);

        return { ...entry, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, count).map((e) => e.name);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : ""; };

    const brief = get("--brief");
    const industry = get("--industry");

    const selected = selectPremiumNames(brief, industry);
    console.log(JSON.stringify({ selected }));
}
