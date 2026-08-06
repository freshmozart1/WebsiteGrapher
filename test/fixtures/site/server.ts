import { createServer, type Server } from 'node:http';
import { productsPage, routes } from './pages.js';

export interface FixtureSite {
    url: string;
    close: () => Promise<void>;
}

/**
 * Serves the fixture site on an ephemeral port. `?page=` is handled live so
 * pagination is a real navigation rather than a pre-rendered special case.
 */
export async function startFixtureSite(): Promise<FixtureSite> {
    const table = routes();

    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (req.method === 'POST') {
            // The contact form posts here. Nothing in the learner may ever reach it.
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><title>Sent</title><h1>Message sent</h1>');
            return;
        }

        if (url.pathname === '/products.html' && url.searchParams.has('page')) {
            const page = Number(url.searchParams.get('page')) || 1;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(productsPage(page));
            return;
        }

        const hit = table.get(url.pathname);
        if (!hit) {
            res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
                '<!doctype html><title>Not found</title><h1>Not found</h1>',
            );
            return;
        }
        res.writeHead(200, { 'content-type': hit.type });
        res.end(hit.body);
    });

    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('fixture site failed to bind a port');
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve())),
            ),
    };
}
