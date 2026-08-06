/**
 * The hard stops on a learning run: how much it may do, and where it may go.
 *
 * These are separate from risk tiering. Risk decides whether one control may
 * be touched; this decides how long the run may go on and which URLs are in
 * scope at all.
 */

export interface Budgets {
    maxPages: number;
    maxProbes: number;
    maxMs: number;
    /** Detail pages sampled to cross-validate field positions. Two is the
     *  minimum that can tell a page-type position from one item's quirk. */
    detailSamples: number;
}

export const DEFAULT_BUDGETS: Budgets = {
    maxPages: 12,
    maxProbes: 25,
    maxMs: 120_000,
    detailSamples: 2,
};

export class BudgetExceeded extends Error {
    constructor(public readonly limit: keyof Budgets) {
        super(`Budget exhausted: ${limit}`);
        this.name = 'BudgetExceeded';
    }
}

export class Budget {
    private pages = 0;
    private probes = 0;
    private readonly startedAt = Date.now();

    constructor(public readonly limits: Budgets = DEFAULT_BUDGETS) {}

    get elapsedMs(): number {
        return Date.now() - this.startedAt;
    }

    get spent(): { pages: number; probes: number; ms: number } {
        return { pages: this.pages, probes: this.probes, ms: this.elapsedMs };
    }

    /** True while there is room for another page visit. */
    canVisit(): boolean {
        return (
            this.pages < this.limits.maxPages &&
            this.elapsedMs < this.limits.maxMs
        );
    }

    canProbe(): boolean {
        return (
            this.probes < this.limits.maxProbes &&
            this.elapsedMs < this.limits.maxMs
        );
    }

    visit(): void {
        if (!this.canVisit()) {
            throw new BudgetExceeded(
                this.elapsedMs >= this.limits.maxMs ? 'maxMs' : 'maxPages',
            );
        }
        this.pages++;
    }

    probe(): void {
        if (!this.canProbe()) {
            throw new BudgetExceeded(
                this.elapsedMs >= this.limits.maxMs ? 'maxMs' : 'maxProbes',
            );
        }
        this.probes++;
    }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRules {
    /** Disallowed path prefixes for our user agent. */
    disallow: string[];
    allow: string[];
    /** True when robots.txt was missing or unreadable — nothing is blocked. */
    absent: boolean;
}

export const PERMISSIVE_ROBOTS: RobotsRules = {
    disallow: [],
    allow: [],
    absent: true,
};

/**
 * Fetches and parses the `User-agent: *` group. A missing or broken
 * robots.txt is treated as permissive, which is what the standard says.
 */
export async function fetchRobots(
    origin: string,
    timeoutMs = 5_000,
): Promise<RobotsRules> {
    try {
        const response = await fetch(new URL('/robots.txt', origin), {
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
        });
        if (!response.ok) return PERMISSIVE_ROBOTS;
        return parseRobots(await response.text());
    } catch {
        return PERMISSIVE_ROBOTS;
    }
}

export function parseRobots(text: string): RobotsRules {
    const disallow: string[] = [];
    const allow: string[] = [];
    let inStarGroup = false;
    let sawAnyGroup = false;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const [rawField, ...rest] = line.split(':');
        if (!rawField || rest.length === 0) continue;
        const field = rawField.trim().toLowerCase();
        const value = rest.join(':').trim();

        if (field === 'user-agent') {
            // A new group starts; we only care about the wildcard one.
            inStarGroup = value === '*';
            sawAnyGroup = true;
            continue;
        }
        if (!inStarGroup) continue;
        if (field === 'disallow' && value) disallow.push(value);
        if (field === 'allow' && value) allow.push(value);
    }

    return { disallow, allow, absent: !sawAnyGroup };
}

/** Longest matching rule wins, `Allow` beating `Disallow` on a tie. */
export function robotsPermits(rules: RobotsRules, pathname: string): boolean {
    const longest = (patterns: string[]) =>
        patterns
            .filter((p) => pathname.startsWith(p))
            .reduce((best, p) => Math.max(best, p.length), -1);

    const denied = longest(rules.disallow);
    if (denied < 0) return true;
    return longest(rules.allow) >= denied;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface Scope {
    origin: string;
    robots: RobotsRules;
}

export interface ScopeVerdict {
    allowed: boolean;
    reason: string;
}

export function inScope(scope: Scope, url: string): ScopeVerdict {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { allowed: false, reason: 'the URL could not be parsed' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
            allowed: false,
            reason: `the ${parsed.protocol} scheme is out of scope`,
        };
    }
    if (parsed.origin !== scope.origin) {
        return {
            allowed: false,
            reason: `${parsed.origin} is a different site`,
        };
    }
    if (!robotsPermits(scope.robots, parsed.pathname)) {
        return {
            allowed: false,
            reason: `robots.txt disallows ${parsed.pathname}`,
        };
    }
    return { allowed: true, reason: 'same origin and permitted by robots.txt' };
}
