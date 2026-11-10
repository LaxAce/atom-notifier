/**
 * Atom.com submission limits.
 *
 * To change the default: tell Claude "update submission limit to N" and it
 * will change DEFAULT_SUBMISSION_LIMIT and raise a PR.
 *
 * To override per-run: pass --submission-limit=N in the workflow dispatch input.
 *
 * Split formula:
 *   premium = min(floor(total * 0.30), PREMIUM_CAP)
 *   ai      = total - premium
 *
 * Examples:
 *   total=25 → ai=20, premium=5   (30% = 7.5 → capped at 5)
 *   total=70 → ai=65, premium=5   (30% = 21  → capped at 5)
 *   total=10 → ai=7,  premium=3   (30% = 3   → no cap hit)
 */

export const DEFAULT_SUBMISSION_LIMIT = 25;

/** Hard cap on premium domain entries regardless of total */
export const PREMIUM_CAP = 5;

export function computeLimits(total: number): { ai: number; premium: number } {
    const premium = Math.min(Math.floor(total * 0.3), PREMIUM_CAP);
    return { ai: total - premium, premium };
}
