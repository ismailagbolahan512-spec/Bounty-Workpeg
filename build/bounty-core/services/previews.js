// services/previews.js — watermarked preview copies for business review.
//
// A preview is a smaller, marked copy of an original. It is a review aid and a deterrent, never protection:
// a watermark can be cropped or removed, and the UI says so.
//   images: reduced to 1000px wide, JPEG, with a tiled watermark
//   PDFs:   first two pages only, with a diagonal watermark
// Other file types get no preview. If a file cannot be read, or is too large to preview safely,
// makePreview returns null and the upload still succeeds without a preview.

const path = require('path');
const { Jimp, loadFont } = require('jimp');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const PREVIEW_IMAGE_WIDTH = 1000;
const PREVIEW_PDF_PAGES = 2;
// Decoding an image uses memory in proportion to its pixel count, so images get a tighter limit.
const MAX_IMAGE_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_SOURCE_BYTES = 25 * 1024 * 1024;
const WATERMARK_TEXT = 'PREVIEW ONLY - BOUNTY';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/bmp', 'image/gif']);

const fontFile = path.join(
    path.dirname(require.resolve('@jimp/plugin-print/package.json')),
    'fonts/open-sans/open-sans-32-black/open-sans-32-black.fnt'
);
let fontPromise = null;
function font() {
    if (!fontPromise) fontPromise = loadFont(fontFile);
    return fontPromise;
}

function previewable(contentType) {
    return IMAGE_TYPES.has(contentType) || contentType === 'application/pdf';
}

async function imagePreview(buffer) {
    const image = await Jimp.read(buffer);
    if (image.bitmap.width > PREVIEW_IMAGE_WIDTH) image.resize({ w: PREVIEW_IMAGE_WIDTH });
    const { width, height } = image.bitmap;
    const f = await font();

    // The watermark is drawn on a transparent layer, then blended over the image at reduced opacity.
    const layer = new Jimp({ width, height, color: 0x00000000 });
    for (let y = 60; y < height; y += 180) {
        for (let x = -60 + ((y / 180) % 2) * 220; x < width; x += 440) {
            layer.print({ font: f, x: Math.max(0, x), y, text: WATERMARK_TEXT });
        }
    }
    image.composite(layer, 0, 0, { opacitySource: 0.35, opacityDest: 1 });
    return { buffer: await image.getBuffer('image/jpeg', { quality: 80 }), contentType: 'image/jpeg' };
}

async function pdfPreview(buffer) {
    const source = await PDFDocument.load(buffer);
    const count = Math.min(PREVIEW_PDF_PAGES, source.getPageCount());
    if (count === 0) return null;
    const out = await PDFDocument.create();
    const pages = await out.copyPages(source, [...Array(count).keys()]);
    pages.forEach((page) => out.addPage(page));
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    for (const page of out.getPages()) {
        const { width, height } = page.getSize();
        for (let y = 0; y < height + 120; y += 160) {
            for (let x = -120; x < width + 120; x += 320) {
                page.drawText(WATERMARK_TEXT, {
                    x, y, size: 26, font: bold, color: rgb(0.45, 0.45, 0.45), opacity: 0.3, rotate: degrees(35),
                });
            }
        }
    }
    return { buffer: Buffer.from(await out.save()), contentType: 'application/pdf' };
}

// Returns { buffer, contentType } or null. Never throws, so an unreadable file does not block an upload.
async function makePreview(buffer, contentType) {
    try {
        if (IMAGE_TYPES.has(contentType)) {
            if (buffer.length > MAX_IMAGE_SOURCE_BYTES) return null;
            return await imagePreview(buffer);
        }
        if (contentType === 'application/pdf') {
            if (buffer.length > MAX_PDF_SOURCE_BYTES) return null;
            return await pdfPreview(buffer);
        }
        return null;
    } catch (_) {
        return null;
    }
}

module.exports = { previewable, makePreview, PREVIEW_IMAGE_WIDTH, PREVIEW_PDF_PAGES };
