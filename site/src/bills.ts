// Real bills from the team building Mergelight, for one month. 2 developers, 3 repos.
// Numbers only: never publish the invoices themselves, or say whose they are.
export const DEVELOPERS = 2;

export const CODERABBIT_BILL = 443;
export const CODERABBIT_SEATS = 120; // Team plan: 2 seats at $60
export const CODERABBIT_PRS = 461;

export const COPILOT_BILL = 720.86; // "GitHub Copilot Usage" on the receipt for October 2026
export const COPILOT_LIST = 19; // Copilot Business, per seat
export const COPILOT_PRS = 346;

export const REVIEW_BILLS = CODERABBIT_BILL + COPILOT_BILL;

export const MERGELIGHT_PER_DEV = 9; // planned price
export const MERGELIGHT_BILL = MERGELIGHT_PER_DEV * DEVELOPERS;
export const ACTIONS_ESTIMATE = 42; // about 7,000 runner minutes at $0.006, not measured on a full month
