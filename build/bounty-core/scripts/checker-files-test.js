// scripts/checker-files-test.js — unit tests for reading PDF and Word text into the submission check.
// No database and no AI provider: loadFileText takes a fake db, and criteria are empty so no AI runs.
// Run: npm run test:checker-files
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFileText, runSubmissionCheck } = require('../services/checker');

const fakeDb = (rows) => ({ query: async (sql, params) => { assert.match(sql, /submission_id = \$1/); assert.deepEqual(params, ['sub-1']); return { rows }; } });

test('loadFileText counts finished jobs as read and everything else as unread', async () => {
    const files = await loadFileText(fakeDb([
        { original_name: 'plan.pdf', status: 'done', extracted_text: 'Phase one is due in May.' },
        { original_name: 'draft.docx', status: 'queued', extracted_text: null },
        { original_name: 'photo.png', status: null, extracted_text: null },
        { original_name: 'broken.pdf', status: 'failed', extracted_text: null },
    ]), 'sub-1');
    assert.equal(files.read, 1);
    assert.equal(files.unread, 3);
    assert.match(files.text, /\[plan\.pdf\]\nPhase one is due in May\./);
    assert.doesNotMatch(files.text, /draft|photo|broken/);
});

test('loadFileText with no files returns empty text and zero counts', async () => {
    const files = await loadFileText(fakeDb([]), 'sub-1');
    assert.deepEqual(files, { text: '', read: 0, unread: 0 });
});

test('the check notes say what was read and what was not', async () => {
    const report = await runSubmissionCheck('user-1', { title: 'T', description: 'D' }, [], { text: '[a.pdf]\nhello', read: 2, unread: 1 });
    const notes = report.notes.join(' | ');
    assert.match(notes, /2 PDF or Word file\(s\) were read/);
    assert.match(notes, /1 file\(s\) could not be read as text/);
    assert.doesNotMatch(notes, /not supported yet/);
});

test('with no files, the check gives no file notes and still runs', async () => {
    const report = await runSubmissionCheck('user-1', { title: 'T', description: 'D' }, []);
    assert.equal(report.notes.some((n) => /file/.test(n)), false);
    assert.equal(report.ai_used, false);
});
