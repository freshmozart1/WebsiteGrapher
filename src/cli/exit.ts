/** Exit codes are part of the interface: the agent branches on them rather
 *  than parsing prose. */
export const EXIT = {
    OK: 0,
    ERROR: 1,
    /** The graph is sound but holds no answer or no route to one. Not a failure
     *  — it means "learn more", and the message says what is missing. */
    GAP: 2,
    /** Learning stopped at a checkpoint: probes need the user's approval. */
    PENDING_APPROVAL: 3,
} as const;

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

/** `parseArgs` runs in strict mode and throws on any option it does not know
 *  about, so `--help`/`-h` must be checked against the raw argv before a
 *  command calls `parseArgs` — otherwise "--help" itself is the crash. */
export function isHelpFlag(argv: string[]): boolean {
    return argv.includes('-h') || argv.includes('--help');
}
