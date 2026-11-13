// scripts/fake-s3.js — a local stand-in for the S3-compatible bucket, used only by the test runner.
// It stores objects in memory and does not check signatures. The real AWS SDK still builds and signs
// every request, so the server's storage code runs unchanged. Path-style URLs: /<bucket>/<key>.
const http = require('http');

const PORT = Number(process.env.PORT || 4566);
const objects = new Map();

function xmlError(res, status, code, message) {
    res.writeHead(status, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return xmlError(res, 400, 'InvalidRequest', 'Path must be /<bucket>/<key>');
    const bucket = parts[0];
    const key = parts.slice(1).map(decodeURIComponent).join('/');
    const store = `${bucket}/${key}`;

    if (req.method === 'PUT') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            objects.set(store, { body, contentType: req.headers['content-type'] || 'application/octet-stream' });
            res.writeHead(200, { ETag: '"fake"' });
            res.end();
        });
        return;
    }
    if (req.method === 'GET') {
        const obj = objects.get(store);
        if (!obj) return xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        res.writeHead(200, { 'Content-Type': obj.contentType, 'Content-Length': obj.body.length });
        res.end(obj.body);
        return;
    }
    if (req.method === 'DELETE') {
        objects.delete(store);
        res.writeHead(204);
        res.end();
        return;
    }
    xmlError(res, 405, 'MethodNotAllowed', 'Unsupported method');
});

server.listen(PORT, () => console.log(`fake S3 listening on ${PORT}`));
