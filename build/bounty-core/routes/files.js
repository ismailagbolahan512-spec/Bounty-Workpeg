// routes/files.js — private original files on a submission.
//   POST /api/submissions/:id/files                  upload (the worker, while pending or needing revision)
//   GET  /api/submissions/:id/files                  list (the worker, or an admin)
//   GET  /api/submissions/:id/files/:fileId/download download (the worker, or an admin)
// Businesses cannot download originals. Releasing an original requires verified payment, which is not built yet.

const express = require('express');
const crypto = require('crypto');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { pool } = require('../db');
const { assertActiveAccount, logAudit } = require('../services/protection');
const storage = require('../services/files');
const previews = require('../services/previews');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_TYPE_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

function unavailable(message) {
    const err = httpError(503, message);
    err.expose = true;
    return err;
}

function canSeeFiles(user, ownerId) {
    return user.id === ownerId || user.is_admin === true;
}

function checkId(value, label) {
    if (!UUID_RE.test(value)) throw httpError(400, `Invalid ${label} id`);
}

// Runs before the body is read, so a restricted or suspended account is refused without an upload.
async function requireActiveAccount(req, res, next) {
    try {
        await assertActiveAccount(req.user.id);
        next();
    } catch (err) { next(err); }
}

router.post('/:id/files',
    authenticate,
    requireRole('worker'),
    requireActiveAccount,
    express.raw({ type: () => true, limit: storage.MAX_BYTES }),
    async(req, res, next) => {
        const client = await pool.connect();
        try {
            const id = req.params.id;
            checkId(id, 'submission');
            if (!storage.storageEnabled()) throw unavailable('File storage is not configured yet');

            const body = req.body;
            if (!Buffer.isBuffer(body) || body.length === 0) throw httpError(400, 'Send the file as the request body');

            const rawName = req.get('x-file-name') || '';
            let decoded = rawName;
            try { decoded = decodeURIComponent(rawName); } catch (_) { decoded = rawName; }
            const name = storage.sanitizeName(decoded);
            if (!name) throw httpError(400, 'Send the file name in the X-File-Name header');
            if (storage.isBlockedName(name)) throw httpError(400, 'This file type is not accepted');

            const declared = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
            const contentType = CONTENT_TYPE_RE.test(declared) && declared.length <= 127 ? declared : 'application/octet-stream';

            // The submission row is locked, so two uploads at once cannot go past the file limit.
            await client.query('BEGIN');
            const sub = await client.query('SELECT worker_id, status FROM submissions WHERE id = $1 FOR UPDATE', [id]);
            if (sub.rows.length === 0) throw httpError(404, 'Submission not found');
            if (sub.rows[0].worker_id !== req.user.id) throw httpError(403, 'This is not your submission');
            if (!['pending', 'revision_requested'].includes(sub.rows[0].status)) {
                throw httpError(409, 'Files can only be added while the submission is pending or needs revision');
            }
            const count = await client.query('SELECT COUNT(*)::int AS n FROM submission_files WHERE submission_id = $1', [id]);
            if (count.rows[0].n >= storage.MAX_FILES_PER_SUBMISSION) {
                throw httpError(409, `A submission can have at most ${storage.MAX_FILES_PER_SUBMISSION} files`);
            }

            const fileId = crypto.randomUUID();
            const key = storage.storageKey(id, fileId);
            const digest = storage.sha256Hex(body);
            await storage.putOriginal(key, body, contentType);
            await client.query(
                `INSERT INTO submission_files (id, submission_id, uploader_id, storage_key, original_name, content_type, size_bytes, sha256)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [fileId, id, req.user.id, key, name, contentType, body.length, digest]
            );

            // PDF and Word files get text extracted by the Python worker (migration 022). Same transaction,
            // so a job exists if and only if the file does.
            const extractable = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
            if (extractable.includes(contentType)) {
                await client.query('INSERT INTO file_jobs (submission_file_id) VALUES ($1)', [fileId]);
            }

            // A watermarked preview is made when the type supports one. If it cannot be made, the upload still succeeds.
            const preview = await previews.makePreview(body, contentType);
            if (preview) {
                const previewKey = storage.previewKey(id, fileId);
                await storage.putOriginal(previewKey, preview.buffer, preview.contentType);
                await client.query(
                    `INSERT INTO submission_file_previews (file_id, storage_key, content_type, size_bytes)
                     VALUES ($1, $2, $3, $4)`,
                    [fileId, previewKey, preview.contentType, preview.buffer.length]
                );
            }

            await logAudit(client.query.bind(client), req.user.id, 'submission_file.uploaded', 'submission', id, {
                file_id: fileId, size_bytes: body.length, sha256: digest, has_preview: Boolean(preview),
            });
            await client.query('COMMIT');

            res.status(201).json({
                id: fileId, original_name: name, content_type: contentType, size_bytes: body.length, sha256: digest, has_preview: Boolean(preview),
            });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            next(err);
        } finally {
            client.release();
        }
    });

router.get('/:id/files', authenticate, async(req, res, next) => {
    try {
        const id = req.params.id;
        checkId(id, 'submission');
        const sub = await pool.query('SELECT worker_id FROM submissions WHERE id = $1', [id]);
        if (sub.rows.length === 0) throw httpError(404, 'Submission not found');
        if (!canSeeFiles(req.user, sub.rows[0].worker_id)) throw httpError(403, 'You can only see files on your own submissions');
        const { rows } = await pool.query(
            `SELECT f.id, f.original_name, f.content_type, f.size_bytes, f.sha256, f.created_at,
                    (p.file_id IS NOT NULL) AS has_preview
             FROM submission_files f
             LEFT JOIN submission_file_previews p ON p.file_id = f.id
             WHERE f.submission_id = $1 ORDER BY f.created_at`,
            [id]
        );
        res.json({ files: rows });
    } catch (err) { next(err); }
});

router.get('/:id/files/:fileId/download', authenticate, async(req, res, next) => {
    try {
        const { id, fileId } = req.params;
        checkId(id, 'submission');
        checkId(fileId, 'file');
        const { rows } = await pool.query(
            `SELECT f.id, f.original_name, f.content_type, f.size_bytes, f.sha256, f.storage_key, s.worker_id
             FROM submission_files f JOIN submissions s ON s.id = f.submission_id
             WHERE f.id = $1 AND f.submission_id = $2`,
            [fileId, id]
        );
        if (rows.length === 0) throw httpError(404, 'File not found');
        const file = rows[0];
        if (!canSeeFiles(req.user, file.worker_id)) throw httpError(403, 'You can only download files from your own submissions');

        // Every download is recorded before any bytes are sent.
        await logAudit(pool.query.bind(pool), req.user.id, 'submission_file.downloaded', 'submission_file', fileId, {
            submission_id: id, sha256: file.sha256,
        });

        const body = await storage.getOriginal(file.storage_key);
        res.set({
            'Content-Type': file.content_type,
            'Content-Length': String(file.size_bytes),
            'Content-Disposition': storage.contentDisposition(file.original_name),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
        });

        // The stored fingerprint is checked against what is actually sent. A mismatch is logged for review.
        const hash = crypto.createHash('sha256');
        body.on('data', (chunk) => hash.update(chunk));
        body.on('end', () => {
            if (hash.digest('hex') !== file.sha256) console.error('✗ File integrity mismatch for file', fileId);
        });
        body.on('error', () => res.destroy());
        body.pipe(res);
    } catch (err) { next(err); }
});

// Preview: the worker, an admin, or the business that posted the task. Inline, but sandboxed, so the
// page cannot run scripts. The original is never sent to a business.
router.get('/:id/files/:fileId/preview', authenticate, async(req, res, next) => {
    try {
        const { id, fileId } = req.params;
        checkId(id, 'submission');
        checkId(fileId, 'file');
        const { rows } = await pool.query(
            `SELECT f.id, s.worker_id, b.business_id, p.storage_key, p.content_type, p.size_bytes
             FROM submission_files f
             JOIN submissions s ON s.id = f.submission_id
             JOIN bounties b ON b.id = s.bounty_id
             LEFT JOIN submission_file_previews p ON p.file_id = f.id
             WHERE f.id = $1 AND f.submission_id = $2`,
            [fileId, id]
        );
        if (rows.length === 0) throw httpError(404, 'File not found');
        const file = rows[0];
        const allowed = canSeeFiles(req.user, file.worker_id) || req.user.id === file.business_id;
        if (!allowed) throw httpError(403, 'Only the business that posted this task, the worker, or an admin can see this preview');
        if (!file.storage_key) throw httpError(404, 'No preview is available for this file type');

        await logAudit(pool.query.bind(pool), req.user.id, 'submission_file.previewed', 'submission_file', fileId, {
            submission_id: id,
        });

        const body = await storage.getOriginal(file.storage_key);
        res.set({
            'Content-Type': file.content_type,
            'Content-Length': String(file.size_bytes),
            'Content-Disposition': 'inline',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
        });
        body.on('error', () => res.destroy());
        body.pipe(res);
    } catch (err) { next(err); }
});

module.exports = router;
