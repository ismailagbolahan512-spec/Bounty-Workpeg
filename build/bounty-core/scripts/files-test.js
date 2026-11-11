// scripts/files-test.js — private originals: upload rules, access by role, limits, audit.
// Runs against the server started by scripts/run-tests.js, which points storage at scripts/fake-s3.js.
const crypto = require('crypto');
const { Jimp } = require('jimp');
const { PDFDocument } = require('pdf-lib');
const { pool } = require('../db');

const BASE = process.env.BASE || 'http://localhost:3100';
const stamp = Date.now();
let passed = 0;
let failed = 0;
function check(label, cond, extra) {
    if (cond) { passed++; console.log('  ✓', label); } else { failed++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}
async function api(method, path, body, token) {
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json, headers: res.headers };
}
async function uploadRaw(submissionId, token, buffer, name, type = 'application/octet-stream') {
    const res = await fetch(`${BASE}/api/submissions/${submissionId}/files`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
        body: buffer,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
}
async function download(submissionId, fileId, token) {
    const res = await fetch(`${BASE}/api/submissions/${submissionId}/files/${fileId}/download`, { headers: { authorization: 'Bearer ' + token } });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, bytes, headers: res.headers };
}
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

async function account(role, name, admin) {
    const email = `files-${role}-${name.replace(/\W/g, '').toLowerCase()}-${stamp}@example.com`;
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
    await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [r.body.id]);
    if (admin) await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [r.body.id]);
    await api('POST', '/api/protection/agreements/accept', { kind: role === 'business' ? 'creator_protection_business' : 'worker_submission_ip' }, r.body.token);
    return { id: r.body.id, token: r.body.token };
}

(async() => {
    console.log('\n=== Setup ===');
    const biz = await account('business', 'Files Biz');
    const worker = await account('worker', 'Files Worker');
    const other = await account('worker', 'Files Other');
    const admin = await account('worker', 'Files Admin', true);
    const restricted = await account('worker', 'Files Restricted');

    const bounty = await api('POST', '/api/bounties', {
        title: 'Files fixture task', description: 'A task for the private file tests.',
        category: 'dev', difficulty: 'easy', reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    const sub = await api('POST', '/api/submissions', {
        bounty_id: bounty.body.id, title: 'Files fixture work', description: 'Implemented the requested change and tested it before review.', github_link: 'https://github.com/example/files',
    }, worker.token);
    check('fixture submission created', sub.status === 201, sub.body);
    const subId = sub.body.id;

    const original = crypto.randomBytes(4096);
    const fingerprint = crypto.createHash('sha256').update(original).digest('hex');

    console.log('\n=== Upload rules ===');
    const up = await uploadRaw(subId, worker.token, original, 'design-final.pdf', 'application/pdf');
    check('the worker uploads an original file (201)', up.status === 201, up.body);
    check('the server computes the SHA-256 of the bytes it received', up.body && up.body.sha256 === fingerprint, up.body);
    check('the stored type is kept', up.body && up.body.content_type === 'application/pdf', up.body);
    const fileId = up.body && up.body.id;

    check('an empty upload is refused (400)', (await uploadRaw(subId, worker.token, Buffer.alloc(0), 'empty.txt')).status === 400);
    check('a missing file name is refused (400)', (await uploadRaw(subId, worker.token, Buffer.from('x'), '')).status === 400);
    check('an executable is refused (400)', (await uploadRaw(subId, worker.token, Buffer.from('MZ'), 'setup.exe')).status === 400);
    check('a file over 100 MB is refused (413)', (await uploadRaw(subId, worker.token, Buffer.alloc(100 * 1024 * 1024 + 1), 'big.bin')).status === 413);
    check('another worker cannot upload to this submission (403)', (await uploadRaw(subId, other.token, Buffer.from('x'), 'x.txt')).status === 403);
    check('a business cannot upload (403)', (await uploadRaw(subId, biz.token, Buffer.from('x'), 'x.txt')).status === 403);
    check('an unknown submission is refused (404)', (await uploadRaw(crypto.randomUUID(), worker.token, Buffer.from('x'), 'x.txt')).status === 404);

    const restrictedSub = await api('POST', '/api/submissions', {
        bounty_id: bounty.body.id, title: 'Files restricted work', description: 'Implemented the requested change and tested it before review.', github_link: 'https://github.com/example/files2',
    }, restricted.token);
    await pool.query("UPDATE users SET account_status = 'restricted' WHERE id = $1", [restricted.id]);
    check('a restricted account cannot upload (403)', (await uploadRaw(restrictedSub.body.id, restricted.token, Buffer.from('x'), 'x.txt')).status === 403);
    await pool.query("UPDATE users SET account_status = 'active' WHERE id = $1", [restricted.id]);

    console.log('\n=== File limit ===');
    for (let i = 2; i <= 5; i++) {
        const r = await uploadRaw(subId, worker.token, Buffer.from('file ' + i), `part-${i}.txt`, 'text/plain');
        check(`file ${i} of 5 uploads`, r.status === 201, r.body);
    }
    check('a sixth file is refused (409)', (await uploadRaw(subId, worker.token, Buffer.from('six'), 'six.txt')).status === 409);

    console.log('\n=== Listing ===');
    const ownList = await api('GET', `/api/submissions/${subId}/files`, undefined, worker.token);
    check('the owner lists the files', ownList.status === 200 && ownList.body.files.length === 5, ownList.body);
    check('the list does not expose the storage key', !JSON.stringify(ownList.body).includes('submissions/'), ownList.body);
    check('another worker cannot list the files (403)', (await api('GET', `/api/submissions/${subId}/files`, undefined, other.token)).status === 403);
    check('a business cannot list the files (403)', (await api('GET', `/api/submissions/${subId}/files`, undefined, biz.token)).status === 403);
    check('an admin can list the files', (await api('GET', `/api/submissions/${subId}/files`, undefined, admin.token)).status === 200);

    console.log('\n=== Download ===');
    const dl = await download(subId, fileId, worker.token);
    check('the owner downloads the original (200)', dl.status === 200, dl.status);
    check('the downloaded bytes match the upload exactly', dl.bytes.equals(original));
    check('the file is served as an attachment', /^attachment/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));
    check('the response is marked nosniff', dl.headers.get('x-content-type-options') === 'nosniff');
    check('the response is not cached', /no-store/.test(dl.headers.get('cache-control') || ''), dl.headers.get('cache-control'));
    check('a business cannot download the original (403)', (await download(subId, fileId, biz.token)).status === 403);
    check('another worker cannot download it (403)', (await download(subId, fileId, other.token)).status === 403);
    const adminDl = await download(subId, fileId, admin.token);
    check('an admin can download it (200)', adminDl.status === 200 && adminDl.bytes.equals(original));
    check('an unknown file is refused (404)', (await download(subId, crypto.randomUUID(), worker.token)).status === 404);

    console.log('\n=== Status rule ===');
    await pool.query("UPDATE submissions SET status = 'approved' WHERE id = $1", [subId]);
    check('no uploads after approval (409)', (await uploadRaw(subId, worker.token, Buffer.from('late'), 'late.txt')).status === 409);
    const afterApproval = await download(subId, fileId, worker.token);
    check('the owner can still download after approval', afterApproval.status === 200);
    await pool.query("UPDATE submissions SET status = 'pending' WHERE id = $1", [subId]);

    console.log('\n=== Records and audit ===');
    const { rows: stored } = await pool.query('SELECT COUNT(*)::int AS n FROM submission_files WHERE submission_id = $1', [subId]);
    check('five file records exist', stored[0].n === 5, stored);
    const { rows: uploadAudit } = await pool.query(
        "SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'submission_file.uploaded'", [subId]
    );
    check('uploads are recorded in the audit log', uploadAudit.length === 5, uploadAudit);
    const { rows: downloadAudit } = await pool.query(
        "SELECT action FROM audit_events WHERE action = 'submission_file.downloaded' AND details->>'submission_id' = $1", [subId]
    );
    check('downloads are recorded in the audit log', downloadAudit.length >= 1, downloadAudit);
    let edited = false;
    try { await pool.query('UPDATE submission_files SET original_name = $1 WHERE id = $2', ['changed.pdf', fileId]); edited = true; } catch (_) { edited = false; }
    check('file records cannot be edited', edited === false);

    console.log('\n=== Previews ===');
    const otherBiz = await account('business', 'Files Other Biz');
    const previewWorker = await account('worker', 'Files Preview Worker');
    const sub2 = await api('POST', '/api/submissions', {
        bounty_id: bounty.body.id, title: 'Files preview work', description: 'Implemented the requested change and tested it before review.', github_link: 'https://github.com/example/files3',
    }, previewWorker.token);
    check('a second worker submits for previews', sub2.status === 201, sub2.body);
    const sub2Id = sub2.body.id;

    const picture = new Jimp({ width: 2400, height: 1600, color: 0xff0000ff });
    const pictureBytes = await picture.getBuffer('image/png');
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) pdfDoc.addPage([612, 792]);
    const pdfBytes = Buffer.from(await pdfDoc.save());

    const pngUp = await uploadRaw(sub2Id, previewWorker.token, pictureBytes, 'picture.png', 'image/png');
    check('a PNG uploads and reports that a preview exists', pngUp.status === 201 && pngUp.body.has_preview === true, pngUp.body);
    const pdfUp = await uploadRaw(sub2Id, previewWorker.token, pdfBytes, 'report.pdf', 'application/pdf');
    check('a real PDF uploads and reports that a preview exists', pdfUp.status === 201 && pdfUp.body.has_preview === true, pdfUp.body);
    const txtUp = await uploadRaw(sub2Id, previewWorker.token, Buffer.from('plain notes'), 'notes.txt', 'text/plain');
    check('a text file uploads with no preview', txtUp.status === 201 && txtUp.body.has_preview === false, txtUp.body);
    

    const garbage = await uploadRaw(sub2Id, previewWorker.token, Buffer.from('not really a pdf'), 'fake.pdf', 'application/pdf');
    check('an unreadable PDF still uploads, with no preview', garbage.status === 201 && garbage.body.has_preview === false, garbage.body);

    async function fetchPreview(fileId, token) {
        const headers = token ? { authorization: 'Bearer ' + token } : {};
        const res = await fetch(`${BASE}/api/submissions/${sub2Id}/files/${fileId}/preview`, { headers });
        return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    }
    const pngId = pngUp.body.id;
    const pdfId = pdfUp.body.id;
    const txtId = txtUp.body.id;

    const bizPreview = await fetchPreview(pngId, biz.token);
    check('the business that posted the task sees the image preview (200)', bizPreview.status === 200, bizPreview.status);
    check('the preview is a JPEG', bizPreview.headers.get('content-type') === 'image/jpeg', bizPreview.headers.get('content-type'));
    check('the preview is reduced to 1000px wide', bizPreview.status === 200 && (await Jimp.read(bizPreview.bytes)).bitmap.width === 1000);
    check('the preview is not the original bytes', bizPreview.status === 200 && !bizPreview.bytes.equals(pictureBytes));
    check('the preview is sent inline with a sandbox policy', /sandbox/.test(bizPreview.headers.get('content-security-policy') || '') && bizPreview.headers.get('content-disposition') === 'inline');

    const pdfPrev = await fetchPreview(pdfId, biz.token);
    check('the business sees the PDF preview (200)', pdfPrev.status === 200, pdfPrev.status);
    check('the PDF preview keeps only two of three pages', pdfPrev.status === 200 && (await PDFDocument.load(pdfPrev.bytes)).getPageCount() === 2);

    check('a text file has no preview (404)', (await fetchPreview(txtId, biz.token)).status === 404);
    check('a business that did not post the task cannot see the preview (403)', (await fetchPreview(pngId, otherBiz.token)).status === 403);
    check('an unauthenticated request is refused (401)', (await fetchPreview(pngId, null)).status === 401);
    check('the owner worker sees the preview (200)', (await fetchPreview(pngId, previewWorker.token)).status === 200);
    check('another worker cannot see the preview (403)', (await fetchPreview(pngId, other.token)).status === 403);
    check('an admin sees the preview (200)', (await fetchPreview(pngId, admin.token)).status === 200);
    check('the business still cannot download the original (403)', (await download(sub2Id, pngId, biz.token)).status === 403);

    const listed = await api('GET', `/api/submissions/${sub2Id}/files`, undefined, previewWorker.token);
    const flags = listed.body.files ? listed.body.files.map((f) => f.has_preview) : [];
    check('the file list shows which files have a preview', flags.length === 4 && flags.filter(Boolean).length === 2, flags);

    const { rows: previewAudit } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'submission_file.previewed' AND details->>'submission_id' = $1", [sub2Id]
    );
    check('preview views are recorded in the audit log', previewAudit[0].n >= 3, previewAudit);

    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exit(failed ? 1 : 0);
})().catch(async(err) => {
    console.error('✗ unexpected error:', err);
    await pool.end().catch(() => {});
    process.exit(1);
});
