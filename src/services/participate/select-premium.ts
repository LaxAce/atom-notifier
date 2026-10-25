import { readFileSync, existsSync } from "fs";
import path from "path";

interface PremiumEntry {
    name: string;
    domain: string;
    style: string;
    industry: string[];
}

export function selectPremiumNames(brief: string, industry: string, count = 5): string[] {
    const listingsFile = path.join(__dirname, "premium-listings.json");
    if (!existsSync(listingsFile)) return [];

    const data = JSON.parse(readFileSync(listingsFile, "utf8"));
    const names: PremiumEntry[] = data.names || [];

    const real = names.filter((n) => n.name && n.name !== "PLACEHOLDER");
    if (real.length === 0) return [];

    const briefLower = (brief || "").toLowerCase();
    const industryLower = (industry || "").toLowerCase();

    const scored = real.map((entry) => {
        let score = 0;

        const industries = entry.industry?.map((i) => i.toLowerCase()) || [];
        if (industryLower && industries.some((ind) => industryLower.includes(ind) || ind.includes(industryLower))) {
            score += 10;
        }

        if (industries.some((ind) => briefLower.includes(ind))) score += 5;
        if (industries.includes("general")) score += 3;
        if (briefLower.includes(entry.name.toLowerCase())) score += 8;
        score += Math.max(0, 10 - entry.name.length);

        return { ...entry, score };
    });

    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    return scored.slice(0, count).map((e) => e.name);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const get = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : ""; };

    const brief = get("--brief");
    const industry = get("--industry");

    const selected = selectPremiumNames(brief, industry);
    console.log(JSON.stringify({ selected }));
}
