import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, report } from '../../src/cli/index.js';
import { EXIT, UsageError } from '../../src/cli/exit.js';
import {
    GraphNotFoundError,
    GraphValidationError,
} from '../../src/graph/store.js';
import { VocabularyError } from '../../src/graph/mutate.js';
import { ProbeRefused } from '../../src/analyzer/probe.js';
import { ZodError, z } from 'zod';

let home: string;
let out: string[];

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wgraph-cli-entry-'));
    process.env.WGRAPH_HOME = home;
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
    });
});

afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.WGRAPH_HOME;
    await rm(home, { recursive: true, force: true });
});

const printed = () => out.join('\n');

describe('main', () => {
    it('prints usage with no command', async () => {
        expect(await main([])).toBe(EXIT.OK);
        expect(printed()).toContain("wgraph — learn a website's structure");
    });

    it.each(['-h', '--help', 'help'])('prints usage for %s', async (flag) => {
        expect(await main([flag])).toBe(EXIT.OK);
        expect(printed()).toContain("wgraph — learn a website's structure");
    });

    it('dispatches to the session command', async () => {
        expect(await main(['session', 'list'])).toBe(EXIT.OK);
        expect(printed()).toMatch(/No saved sessions/);
    });

    it('dispatches to the graph command', async () => {
        expect(await main(['graph', 'list'])).toBe(EXIT.OK);
        expect(printed()).toMatch(/No sites learned yet/);
    });

    it('rejects an unknown command', async () => {
        await expect(main(['frobnicate'])).rejects.toThrow(UsageError);
    });

    it.each(['-h', '--help'])(
        'passes %s through to the "graph" subcommand',
        async (flag) => {
            expect(await main(['graph', flag])).toBe(EXIT.OK);
            expect(printed()).toContain('list');
            expect(printed()).toContain('apply');
        },
    );

    it.each(['-h', '--help'])(
        'passes %s through to the "session" subcommand',
        async (flag) => {
            expect(await main(['session', flag])).toBe(EXIT.OK);
            expect(printed()).toContain('list');
            expect(printed()).toContain('clear');
        },
    );

    it.each(['-h', '--help'])(
        'passes %s through to the "analyze" command',
        async (flag) => {
            expect(await main(['analyze', flag])).toBe(EXIT.OK);
            expect(printed()).toContain('wgraph analyze <url>');
        },
    );

    it('reproduces the issue: "graph apply --help" resolves instead of throwing', async () => {
        expect(await main(['graph', 'apply', '--help'])).toBe(EXIT.OK);
        expect(printed()).toContain('pages');
        expect(printed()).toContain('components');
        expect(printed()).toContain('fields');
        expect(printed()).toContain('edges');
    });

    it('prints usage for "session clear --help" instead of clearing a session named --help', async () => {
        expect(await main(['session', 'clear', '--help'])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph session clear <name>');
    });
});

describe('report', () => {
    it('reports a usage error', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(report(new UsageError('bad usage'))).toBe(EXIT.ERROR);
        spy.mockRestore();
    });

    it('reports a missing graph as a gap', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(report(new GraphNotFoundError('shop.example'))).toBe(EXIT.GAP);
        spy.mockRestore();
    });

    it('reports a refused probe as pending approval', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(report(new ProbeRefused('blocked', 'it posts'))).toBe(
            EXIT.PENDING_APPROVAL,
        );
        spy.mockRestore();
    });

    it('reports graph validation and vocabulary errors', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(report(new GraphValidationError(['bad entry']))).toBe(
            EXIT.ERROR,
        );
        expect(report(new VocabularyError('unknown kind'))).toBe(EXIT.ERROR);
        spy.mockRestore();
    });

    it('reports zod validation issues', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = z.object({ name: z.string() }).safeParse({});
        expect(result.success).toBe(false);
        expect(report(result.error as ZodError)).toBe(EXIT.ERROR);
        spy.mockRestore();
    });

    it('falls back to the error message for anything else', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(report(new Error('boom'))).toBe(EXIT.ERROR);
        expect(report('not an error')).toBe(EXIT.ERROR);
        spy.mockRestore();
    });
});
