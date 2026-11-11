// services/files.js — private original files, stored in a Backblaze B2 bucket through its S3-compatible API.
//
// Everything in the bucket is private. The server is the only thing that reads it, and it does so
// only after the access rules in routes/files.js pass. Keys are opaque ids, never user file names.
// Required environment variables: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT
// (for example s3.us-east-005.backblazeb2.com). Use a key restricted to this bucket, never the master key.

const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FILES_PER_SUBMISSION = 5;
// Executables and installers are refused, since buyers and reviewers open these files.
const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|com|scr|msi|dll|vbs|ps1|sh|jar|app|apk|dmg)$/i;

function config() {
    const { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT } = process.env;
    if (!B2_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET || !B2_ENDPOINT) return null;
    // The test runner points storage at a local stand-in. Ignored in production.
    const testUrl = process.env.NODE_ENV !== 'production' ? process.env.B2_TEST_ENDPOINT_URL : null;
    const match = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(B2_ENDPOINT.trim());
    if (!match) throw new Error('B2_ENDPOINT must look like s3.<region>.backblazeb2.com');
    return {
        bucket: B2_BUCKET,
        endpoint: testUrl || 'https://' + B2_ENDPOINT.trim(),
        region: match[1].toLowerCase(),
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY,
    };
}

let client = null;
function s3() {
    if (client) return client;
    const c = config();
    client = new S3Client({
        endpoint: c.endpoint,
        region: c.region,
        forcePathStyle: true,
        credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
        // Backblaze does not support the newer default checksums, so only send them when required.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return client;
}

function storageEnabled() {
    return config() !== null;
}

function bucketName() {
    return config().bucket;
}

function storageKey(submissionId, fileId) {
    return `submissions/${submissionId}/${fileId}`;
}

// Previews are kept under their own prefix, apart from originals.
function previewKey(submissionId, fileId) {
    return `previews/${submissionId}/${fileId}`;
}

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Keeps only the base name, with control characters and path separators removed.
function sanitizeName(raw) {
    const base = String(raw || '').split(/[\\/]/).pop();
    // eslint-disable-next-line no-control-regex
    return base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 255);
}

function isBlockedName(name) {
    return BLOCKED_EXTENSIONS.test(name);
}

// Download header: always an attachment, with the name encoded so any character is safe.
function contentDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function putOriginal(key, body, contentType) {
    await s3().send(new PutObjectCommand({
        Bucket: bucketName(),
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
    }));
}

async function getOriginal(key) {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
    return res.Body;
}

module.exports = {
    MAX_BYTES,
    MAX_FILES_PER_SUBMISSION,
    storageEnabled,
    storageKey,
    previewKey,
    sha256Hex,
    sanitizeName,
    isBlockedName,
    contentDisposition,
    putOriginal,
    getOriginal,
};
