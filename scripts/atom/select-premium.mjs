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

    // Filter out placeholders only — our JSON has no price field so never filter by price
    const real = names.filter((n) => n.name && n.name !== "PLACEHOLDER");
    if (real.length === 0) return [];

    const briefLower = (brief || "").toLowerCase();
    const industryLower = (industry || "").toLowerCase();

    // Score each name by relevance
    const scored = real.map((entry) => {
        let score = 0;

        // Specific industry match — highest priority
        const industries = entry.industry?.map((i) => i.toLowerCase()) || [];
        if (industryLower && industries.some((ind) => industryLower.includes(ind) || ind.includes(industryLower))) {
            score += 10;
        }

        // Brief keyword overlap
        if (industries.some((ind) => briefLower.includes(ind))) score += 5;

        // Generalist names always get a guaranteed base score so they serve as fallback
        // when no specific industry match exists
        if (industries.includes("general")) score += 3;

        // Name appears literally in brief (bonus)
        if (briefLower.includes(entry.name.toLowerCase())) score += 8;

        // Short names score higher (atom.com clients prefer them)
        score += Math.max(0, 10 - entry.name.length);

        return { ...entry, score };
    });

    // Sort by score descending, then alphabetically for stable ordering
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    // Always return real premium names — never fewer than requested
    // (the full list has 43 so we can always fill `count`)
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
