/**
 * Atom.com submission limits — update these when your account limits change.
 *
 * To update: tell Claude "update submission limits: X premium, Y AI" and it will
 * change only this file and raise a PR.
 */

/** AI-generated names with domain availability check (when premium domains are allowed) */
export const NAMES_FROM_AI = 20;

/** Premium domain listings to include (only when contest allows premium domains) */
export const NAMES_FROM_PREMIUM = 5;

/** AI-generated names when contest does NOT allow premium domains */
export const NAMES_FROM_AI_NO_PREMIUM = NAMES_FROM_AI + NAMES_FROM_PREMIUM;

/** Hard cap on total entries submitted per contest */
export const ENTRIES_PER_CONTEST = NAMES_FROM_AI + NAMES_FROM_PREMIUM;
