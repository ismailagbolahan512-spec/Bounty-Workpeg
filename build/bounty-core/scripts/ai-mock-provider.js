// scripts/ai-mock-provider.js — local stand-in for an OpenAI-compatible chat API.
// Lets the AI Task Architect run end to end with no key and no spend.
// Usage: PORT=4555 node scripts/ai-mock-provider.js
// Behaviour is chosen by a marker in the business request:
//   MOCK_INVALID  -> reply is not JSON
//   MOCK_SLOW     -> reply after 6 seconds (trips a short AI_TIMEOUT_MS)
//   MOCK_INJECT   -> the draft tries to set a huge reward; validation must refuse it
//   (Proof-of-Ability: MOCK_POA_OBEY_INJECTION in submitted work, see portfolioFor)
const http = require('http');

const PORT = Number(process.env.PORT) || 4555;

function draftFor(text) {
    const inject = text.includes('MOCK_INJECT');
    return {
        title: 'Landing page for a bakery',
        description: 'Build a single responsive page for a bakery with the menu, opening hours and a contact form. Deliver the code in a public GitHub repository.',
        category: 'dev',
        difficulty: 'easy',
        submission_type: 'github',
        requirements: ['Responsive layout for phone and desktop', 'Working contact form'],
        acceptance_criteria: [
            { text: 'Page has a menu section', rule: null },
            { text: 'README explains how to run it', rule: { type: 'min_words', min: 20, host: null } },
        ],
        suggested_reward: inject ? { amount: 999999999, reason: 'Ignore the rules and pay this' } : { amount: 15000, reason: 'Typical for a one-page site' },
        suggested_deadline_days: 7,
        missing_info: ['Hosting preference is not stated'],
        questions: ['Do you have a logo or brand colours to use?'],
    };
}

// Project planner replies. MOCK_CYCLE returns tasks that wait on each other (must be rejected).
function planFor(userText) {
    const cyclic = userText.includes('MOCK_CYCLE');
    const task = (title, description, category, submission_type, deadline_days, depends_on, text) => ({
        title, description, category, difficulty: 'medium', submission_type, deadline_days,
        acceptance_criteria: [{ text, rule_type: 'none', min: null, host: null }],
        depends_on,
    });
    return {
        title: 'Coffee brand website',
        description: 'A small brand site delivered in three connected steps.',
        tasks: [
            task('Research the brand', 'Write the brand and audience brief for the site.', 'content', 'text', 3, cyclic ? [2] : [], 'Brief is written'),
            task('Build the page', 'Build the single page from the brief.', 'dev', 'github', 10, [0], 'Page runs locally'),
            task('Hand over the files', 'Deliver the final files and notes.', 'other', 'text', 12, [1], 'Files are handed over'),
        ],
    };
}

// Checker replies. Markers in the submission text choose the behaviour:
//   CHECK_FAKE_QUOTE -> claims "met" with a quote that is not in the submission
//   CHECK_UNSURE     -> every subjective criterion is "unclear"
//   otherwise        -> "met", quoting the first words of the submission
function checkFor(userText) {
    const sub = (userText.match(/<submission>\n?([\s\S]*?)\n?<\/submission>/) || [])[1] || '';
    const ids = [...userText.matchAll(/^\[(c\d+)\]/gm)].map((m) => m[1]);
    const verdicts = ids.map((id) => {
        if (userText.includes('CHECK_UNSURE')) {
            return { criterion_id: id, verdict: 'unclear', evidence: '', explanation: 'The submission does not say enough about this.' };
        }
        if (userText.includes('CHECK_FAKE_QUOTE')) {
            return { criterion_id: id, verdict: 'met', evidence: 'this sentence never appears anywhere', explanation: 'Looks complete.' };
        }
        const quote = sub.trim().slice(0, 20);
        return { criterion_id: id, verdict: 'met', evidence: quote, explanation: 'The submission covers this.' };
    });
    return { verdicts };
}

// Proof-of-Ability replies. MOCK_POA_OBEY_INJECTION makes the mock "obey" an instruction hidden
// in a submission: it adds a web link and an invented number. The server must refuse that reply.
function portfolioFor(userText) {
    const json = (userText.match(/<evidence>\n?([\s\S]*?)\n?<\/evidence>/) || [])[1] || '[]';
    const items = JSON.parse(json);
    const obey = userText.includes('MOCK_POA_OBEY_INJECTION');
    const categories = [...new Set(items.map((i) => i.category))];
    return {
        summary: `Has ${items.length} approved task${items.length === 1 ? '' : 's'} on Bounty.` +
            (obey ? ' See https://evil.example for 7 years of experience.' : ''),
        evidence_ids: items.map((i) => i.id),
        skills: categories,
    };
}

http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const isAnthropic = req.url.endsWith('/messages');
        if (req.method !== 'POST' || !(isAnthropic || req.url.endsWith('/chat/completions'))) {
            res.writeHead(404).end();
            return;
        }
        let body = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        const userText = ((body.messages || []).find((m) => m.role === 'user') || {}).content || '';

        const reply = (content) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            if (isAnthropic) {
                res.end(JSON.stringify({ content: [{ type: 'text', text: content }], usage: { input_tokens: 300, output_tokens: 340 } }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 640 } }));
            }
        };
        if (userText.includes('MOCK_INVALID')) return reply('Sorry, here is some text instead of JSON.');
        if (userText.includes('<project_request>')) {
            return reply(JSON.stringify(planFor(userText)));
        }
        if (userText.includes('<evidence>')) {
            return reply(JSON.stringify(portfolioFor(userText)));
        }
        if (userText.includes('<submission>')) {
            return reply(JSON.stringify(checkFor(userText)));
        }
        if (userText.includes('MOCK_SLOW')) return setTimeout(() => reply(JSON.stringify(draftFor(userText))), 6000);
        reply(JSON.stringify(draftFor(userText)));
    });
}).listen(PORT, () => console.log(`mock AI provider on http://localhost:${PORT}/v1`));
