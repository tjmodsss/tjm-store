'use strict';
/**
 * The GitHub REST API for the mgu-install tests, on 127.0.0.1:
 *
 *   node fake_github.js <config.json> <log> <port file>
 *
 * config: { files: [<path>, ...], repos: { "<owner>/<repo>": { token (a
 * private repo's), catalog (the index of the catalog release's
 * catalog.json, or absent), releases: [{ draft, prerelease, assets:
 * [{ name, n }] }] } } }. Asset n is /repos/<o>/<r>/releases/assets/<n>,
 * which redirects to localhost (another host) for files[n]; fail: { "<n>":
 * ["500" | "cut", ...] } breaks file n's next downloads (an HTTP 500, or
 * the connection cut halfway), one each. Writes its port
 * to <port file> once listening; each request is a JSON line in <log>
 * ({ path, auth, accept }).
 */
const fs = require('fs');
const http = require('http');

const [configFile, log, portFile] = process.argv.slice(2);
const failed = {};   // config.fail answers given so far, by file

const server = http.createServer((req, res) => {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const auth = req.headers.authorization || null;
    fs.appendFileSync(log, `${JSON.stringify({ path: req.url, auth, accept: req.headers.accept })}\n`);
    const port = server.address().port;
    const send = (status, body, type) => {
        res.writeHead(status, { 'Content-Type': type || 'application/json' });
        res.end(body);
    };
    const blob = /^\/blob\/(\d+)$/.exec(req.url);
    if (blob) {
        const data = fs.readFileSync(config.files[Number(blob[1])]);
        // config.fail { "<n>": ["500" | "cut", ...] }: file n's next requests answer so, one each, then as usual
        const left = (config.fail || {})[blob[1]] || [];
        const used = (failed[blob[1]] || 0);
        if (used < left.length) {
            failed[blob[1]] = used + 1;
            if (left[used] === '500') {
                return send(500, '{"message":"Server Error"}');
            }
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
            return res.write(data.subarray(0, Math.floor(data.length / 2)), () => req.socket.destroy());
        }
        return send(200, data, 'application/octet-stream');
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/[^?]*)?/.exec(req.url);
    const repo = m && config.repos[m[1]];
    if (!repo || (repo.token && auth !== `Bearer ${repo.token}`)) {
        return send(404, '{"message":"Not Found"}');
    }
    const base = `http://127.0.0.1:${port}/repos/${m[1]}`;
    const assets = (list) => list.map((a) => ({ name: a.name, size: fs.statSync(config.files[a.n]).size, url: `${base}/releases/assets/${a.n}` }));
    const rest = m[2] || '';
    const asset = /^\/releases\/assets\/(\d+)$/.exec(rest);
    if (!rest) {
        return send(200, JSON.stringify({ full_name: m[1], private: !!repo.token, default_branch: 'main' }));
    }
    if (asset) {
        if (req.headers.accept !== 'application/octet-stream') {
            return send(200, JSON.stringify({ id: Number(asset[1]) }));
        }
        res.writeHead(302, { Location: `http://localhost:${port}/blob/${asset[1]}` });
        return res.end();
    }
    if (rest === '/releases/tags/catalog' && repo.catalog !== undefined) {
        return send(200, JSON.stringify({ tag_name: 'catalog', assets: assets([{ name: 'catalog.json', n: repo.catalog }]) }));
    }
    if (rest === '/releases') {
        return send(200, JSON.stringify((repo.releases || []).map((r) => Object.assign({}, r, { assets: assets(r.assets) }))));
    }
    return send(404, '{"message":"Not Found"}');
});

server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
