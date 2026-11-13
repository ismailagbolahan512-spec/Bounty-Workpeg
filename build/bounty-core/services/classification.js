// services/classification.js — the task classification matrix.
//
// Industries and job types are plain data. To add one, append an entry; nothing else
// needs to change. A job type's recommended mode is a suggestion: the business keeps
// the final choice (see modeFit), except where a rule in routes/bounties.js makes the
// configuration impossible.

const EXECUTION_MODES = {
    first_valid: {
        label: 'First Valid Submission',
        short: 'First verified submission wins.',
        explanation: 'Several workers may start. The first submission that passes verification wins, and every other participant is closed out. Submission time alone never decides it.',
        examples: 'Fixing a specific bug, a scoped penetration test, locating a specified document.',
        use_cases: 'When you need one correct result and speed matters more than comparing options.',
        icon: 'bolt',
    },
    competitive: {
        label: 'Competitive Selection',
        short: 'Compare submissions and choose the best.',
        explanation: 'Workers each produce their own version. You review the submissions side by side and choose one or more winners before the deadline.',
        examples: 'A logo, a video edit, a set of landing-page designs, a copywriting brief.',
        use_cases: 'When quality is subjective and you want options to compare.',
        icon: 'scale',
    },
    team: {
        label: 'Team / Parallel Execution',
        short: 'Multiple workers build one larger project.',
        explanation: 'A large project is split into components. Each component is assigned to a worker, dependencies are tracked, and the completed parts are combined into one deliverable. Set up from a project.',
        examples: 'A web application, an e-commerce platform, a full video production.',
        use_cases: 'When one outcome needs several specialists working in parallel.',
        icon: 'layers',
    },
    independent: {
        label: 'Independent Assessment',
        short: 'Receive several independent results.',
        explanation: 'Several workers assess the same subject separately. Each accepted report counts toward the number you asked for, and you can compare the findings.',
        examples: 'Independent security audits, market research, AI output evaluation.',
        use_cases: 'When you want independent opinions or cross-checks, not a single answer.',
        icon: 'grid',
    },
};

const INDUSTRIES = [
    { id: 'software', title: 'Software Development' },
    { id: 'cybersecurity', title: 'Cybersecurity' },
    { id: 'design', title: 'Graphics and Creative Design' },
    { id: 'video', title: 'Video and Animation' },
    { id: 'writing', title: 'Writing and Content' },
    { id: 'marketing', title: 'Marketing and Advertising' },
    { id: 'data', title: 'Data and Analytics' },
    { id: 'research', title: 'Research and Consulting' },
    { id: 'it', title: 'IT and Technical Support' },
    { id: 'operations', title: 'Business Operations and Administration' },
    { id: 'hospitality', title: 'Hospitality and Hotels' },
];

// requires_authorization: the business must give written authorization and rules of
// engagement, and each worker must accept an NDA before working on the task.
const JOB_TYPES = [
    // Software Development
    { id: 'sw-bug-fix', industry: 'software', title: 'Bug reproduction and fix', keywords: ['bug', 'fix', 'crash', 'error', 'reproduce', 'broken'],
        description: 'Reproduce a specific defect and deliver a verified fix.', recommended: 'first_valid', alternatives: ['competitive'], workers: 2, multiple_winners: false,
        deliverables: ['Code change or patch', 'Steps to reproduce', 'Test evidence'], verification: 'Tests run against the fix and the criteria are checked.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'sw-api-repair', industry: 'software', title: 'Broken API endpoint repair', keywords: ['api', 'endpoint', '500', 'route', 'webhook'],
        description: 'Restore a failing endpoint so it returns correct responses.', recommended: 'first_valid', alternatives: ['competitive'], workers: 2, multiple_winners: false,
        deliverables: ['Code change', 'Request and response evidence'], verification: 'The endpoint is called with the agreed requests.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'sw-feature-build', industry: 'software', title: 'Feature or page build', keywords: ['build', 'feature', 'page', 'component', 'implement', 'landing'],
        description: 'Build a defined feature or page to an agreed specification.', recommended: 'competitive', alternatives: ['team'], workers: 3, multiple_winners: false,
        deliverables: ['Working code or link', 'Short description of the approach'], verification: 'Criteria are checked; the business reviews the result.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'sw-full-app', industry: 'software', title: 'Full application or platform', keywords: ['platform', 'web application', 'e-commerce', 'full app', 'system', 'saas'],
        description: 'Build a larger product from several connected parts.', recommended: 'team', alternatives: ['competitive'], workers: 5, multiple_winners: false,
        deliverables: ['Components list', 'Combined deliverable', 'Handover notes'], verification: 'Each component is checked before the combined build is approved.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'sw-qa-audit', industry: 'software', title: 'Software quality assurance', keywords: ['qa', 'quality', 'test', 'testing', 'cross-device', 'audit code'],
        description: 'Test the same product independently and report what you find.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Test report', 'Reproduction steps for each issue'], verification: 'Each report is checked against the criteria.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Cybersecurity
    { id: 'sec-pentest-scoped', industry: 'cybersecurity', title: 'Penetration test (defined scope)', keywords: ['pentest', 'penetration', 'scope', 'exploit'],
        description: 'Test a named system within a written scope and report findings.', recommended: 'first_valid', alternatives: ['independent'], workers: 2, multiple_winners: false,
        deliverables: ['Findings report', 'Evidence for each finding', 'Remediation notes'], verification: 'Findings are reproduced by the business or a qualified reviewer.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },
    { id: 'sec-pentest-independent', industry: 'cybersecurity', title: 'Independent penetration test', keywords: ['independent pentest', 'second opinion', 'assessment of security'],
        description: 'Several testers assess the same scope separately to compare coverage.', recommended: 'independent', alternatives: ['first_valid'], workers: 3, multiple_winners: true,
        deliverables: ['Independent report per tester', 'Evidence for each finding'], verification: 'Each report is checked. Critical findings need qualified human review.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },
    { id: 'sec-vuln-discovery', industry: 'cybersecurity', title: 'Vulnerability discovery', keywords: ['vulnerability', 'vulnerabilities', 'cve', 'discover'],
        description: 'Find a specific class of vulnerability in an approved target.', recommended: 'first_valid', alternatives: ['competitive'], workers: 2, multiple_winners: false,
        deliverables: ['Proof of concept', 'Impact description', 'Fix recommendation'], verification: 'The business reproduces the issue before approval.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },
    { id: 'sec-misconfig', industry: 'cybersecurity', title: 'Security misconfiguration check', keywords: ['misconfiguration', 'config', 'headers', 'exposed', 'permissions'],
        description: 'Identify security settings that are wrong on an approved system.', recommended: 'first_valid', alternatives: ['independent'], workers: 2, multiple_winners: false,
        deliverables: ['List of misconfigurations', 'Evidence and severity'], verification: 'Each item is checked against the approved scope.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },
    { id: 'sec-audit', industry: 'cybersecurity', title: 'Independent security audit', keywords: ['audit', 'security review', 'compliance security'],
        description: 'A structured review of security controls by several independent auditors.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Audit report', 'Control-by-control results'], verification: 'Each report is checked. Critical findings need qualified human review.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },

    // Graphics and Creative Design
    { id: 'design-logo', industry: 'design', title: 'Logo and brand identity', keywords: ['logo', 'brand', 'branding', 'identity', 'colors'],
        description: 'Design a logo or brand identity for comparison.', recommended: 'competitive', alternatives: [], workers: 5, multiple_winners: false,
        deliverables: ['Logo files (SVG and PNG)', 'Short rationale', 'Colour and type notes'], verification: 'The business judges the designs.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'design-ui', industry: 'design', title: 'UI and UX design', keywords: ['ui', 'ux', 'mockup', 'prototype', 'screens', 'interface'],
        description: 'Design screens or a user flow for an app or website.', recommended: 'competitive', alternatives: ['team'], workers: 4, multiple_winners: false,
        deliverables: ['Design file or link', 'Flow notes'], verification: 'The business judges the design against the brief.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'design-photo', industry: 'design', title: 'Photography and photo editing', keywords: ['photo', 'photography', 'retouch', 'photos', 'edit photos'],
        description: 'Shoot or edit photos to a brief.', recommended: 'competitive', alternatives: [], workers: 3, multiple_winners: false,
        deliverables: ['Edited images', 'Originals or RAW files on request'], verification: 'The business judges the images.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Video and Animation
    { id: 'video-edit', industry: 'video', title: 'Video editing', keywords: ['video', 'edit', 'cut', 'reel', 'footage', 'youtube'],
        description: 'Edit footage into a finished video to a brief.', recommended: 'competitive', alternatives: ['team'], workers: 3, multiple_winners: false,
        deliverables: ['Finished video link', 'Project notes'], verification: 'The business reviews the video against the brief.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'video-animation', industry: 'video', title: 'Animation', keywords: ['animation', 'animate', 'motion graphics', 'explainer'],
        description: 'Create an animated sequence to a brief.', recommended: 'competitive', alternatives: ['team'], workers: 3, multiple_winners: false,
        deliverables: ['Animation file or link', 'Storyboard'], verification: 'The business reviews the animation against the brief.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'video-production', industry: 'video', title: 'Large video production', keywords: ['production', 'series', 'documentary', 'campaign video', 'multi-episode'],
        description: 'Produce several connected videos or episodes.', recommended: 'team', alternatives: ['competitive'], workers: 5, multiple_winners: false,
        deliverables: ['Episode list', 'Final videos', 'Handover notes'], verification: 'Each component is checked before the combined release.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Writing and Content
    { id: 'writing-copy', industry: 'writing', title: 'Copywriting', keywords: ['copy', 'copywriting', 'headline', 'ad copy', 'sales page'],
        description: 'Write persuasive copy for a product, page or campaign.', recommended: 'competitive', alternatives: [], workers: 5, multiple_winners: false,
        deliverables: ['Copy document', 'Variants where asked'], verification: 'The business chooses the copy that fits the brief.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'writing-content', industry: 'writing', title: 'Content creation', keywords: ['article', 'blog', 'content', 'post', 'newsletter'],
        description: 'Write articles or posts to an outline.', recommended: 'competitive', alternatives: [], workers: 4, multiple_winners: false,
        deliverables: ['Finished articles', 'Word count and sources'], verification: 'The business reviews each piece against the outline.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'writing-script', industry: 'writing', title: 'Scriptwriting', keywords: ['script', 'screenplay', 'scriptwriting', 'dialogue', 'episode script'],
        description: 'Write a script or screenplay to a brief.', recommended: 'competitive', alternatives: [], workers: 3, multiple_winners: false,
        deliverables: ['Script document'], verification: 'The business reviews the script against the brief.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Marketing and Advertising
    { id: 'marketing-strategy', industry: 'marketing', title: 'Marketing strategy', keywords: ['strategy', 'marketing plan', 'go-to-market', 'positioning'],
        description: 'Propose a marketing strategy for a product or market.', recommended: 'competitive', alternatives: ['team'], workers: 3, multiple_winners: false,
        deliverables: ['Strategy document', 'Channel plan', 'Budget outline'], verification: 'The business compares the strategies.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'marketing-campaign', industry: 'marketing', title: 'Creative campaign', keywords: ['campaign', 'advertising', 'ads', 'social media campaign'],
        description: 'Plan and produce a multi-part marketing campaign.', recommended: 'team', alternatives: ['competitive'], workers: 4, multiple_winners: false,
        deliverables: ['Campaign plan', 'Assets for each channel'], verification: 'Each asset is checked before launch.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Data and Analytics
    { id: 'data-find-dataset', industry: 'data', title: 'Find a specified dataset', keywords: ['dataset', 'data set', 'find data', 'source data'],
        description: 'Locate a dataset that matches a stated specification.', recommended: 'first_valid', alternatives: ['competitive'], workers: 3, multiple_winners: false,
        deliverables: ['Dataset link', 'Source and licence', 'Field description'], verification: 'The dataset is checked against the specification.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'data-error', industry: 'data', title: 'Identify a specific data error', keywords: ['data error', 'mismatch', 'discrepancy', 'wrong data', 'duplicate records'],
        description: 'Find and document a particular error in a dataset.', recommended: 'first_valid', alternatives: ['independent'], workers: 2, multiple_winners: false,
        deliverables: ['Error description', 'Affected rows', 'Reproduction query'], verification: 'The business reproduces the error.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'data-verify-fact', industry: 'data', title: 'Verify a particular fact', keywords: ['verify', 'fact check', 'confirm', 'is it true'],
        description: 'Check a specific claim against reliable sources.', recommended: 'first_valid', alternatives: ['independent'], workers: 2, multiple_winners: false,
        deliverables: ['Verdict', 'Sources with links'], verification: 'Sources are checked by the business.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'data-processing', industry: 'data', title: 'Large-scale data processing', keywords: ['processing', 'pipeline', 'etl', 'millions of rows', 'large dataset'],
        description: 'Process a large dataset in parallel parts.', recommended: 'team', alternatives: ['competitive'], workers: 4, multiple_winners: false,
        deliverables: ['Processed output', 'Method notes'], verification: 'Each part is checked before the combined output is approved.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'data-ai-eval', industry: 'data', title: 'AI output evaluation', keywords: ['evaluate', 'evaluation', 'model output', 'rate responses', 'ai output'],
        description: 'Rate AI outputs against a rubric, independently.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Scored rubric per item', 'Notes on disagreements'], verification: 'Scores are compared for agreement.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Research and Consulting
    { id: 'research-locate-doc', industry: 'research', title: 'Locate a specified document', keywords: ['document', 'paper', 'report copy', 'locate', 'find the report'],
        description: 'Find a specific document or publication.', recommended: 'first_valid', alternatives: ['competitive'], workers: 3, multiple_winners: false,
        deliverables: ['Link to the document', 'Citation'], verification: 'The document is checked against the citation.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'research-market', industry: 'research', title: 'Market research', keywords: ['market research', 'market', 'competitors', 'survey', 'landscape'],
        description: 'Research a market and report findings independently.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Research report', 'Sources'], verification: 'Sources and figures are checked for each report.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'research-business-plan', industry: 'research', title: 'Business plan', keywords: ['business plan', 'feasibility', 'financial model', 'pitch plan'],
        description: 'Write a business plan for an idea or venture.', recommended: 'competitive', alternatives: ['team'], workers: 3, multiple_winners: false,
        deliverables: ['Business plan document', 'Assumptions list'], verification: 'The business compares the plans.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'research-complex', industry: 'research', title: 'Complex research project', keywords: ['research project', 'study', 'multi-part research', 'literature review'],
        description: 'Research split into several connected parts.', recommended: 'team', alternatives: ['competitive'], workers: 4, multiple_winners: false,
        deliverables: ['Part reports', 'Combined final report'], verification: 'Each part is checked before the combined report is approved.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // IT and Technical Support
    { id: 'it-server-diagnosis', industry: 'it', title: 'Diagnose a server issue', keywords: ['server', 'diagnose', 'diagnosis', 'slow server', 'hosting'],
        description: 'Find the cause of a specific server problem.', recommended: 'first_valid', alternatives: ['competitive'], workers: 2, multiple_winners: false,
        deliverables: ['Root cause report', 'Commands and logs used'], verification: 'The business confirms the cause and the fix.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },
    { id: 'it-service-restore', industry: 'it', title: 'Restore a failed service', keywords: ['restore', 'down', 'outage', 'failed service', 'recover'],
        description: 'Bring a failed service back to working order.', recommended: 'first_valid', alternatives: [], workers: 2, multiple_winners: false,
        deliverables: ['Service status evidence', 'Summary of the change'], verification: 'The service is checked to be running correctly.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },
    { id: 'it-infrastructure', industry: 'it', title: 'Infrastructure problem', keywords: ['infrastructure', 'network', 'dns', 'deployment', 'cloud'],
        description: 'Resolve a specific infrastructure problem.', recommended: 'first_valid', alternatives: ['competitive'], workers: 2, multiple_winners: false,
        deliverables: ['Change record', 'Verification evidence'], verification: 'The business confirms the problem is resolved.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: true },

    // Business Operations and Administration
    { id: 'ops-admin', industry: 'operations', title: 'Administrative support', keywords: ['admin', 'administrative', 'data entry', 'spreadsheet', 'virtual assistant'],
        description: 'Routine admin work to a checklist.', recommended: 'competitive', alternatives: [], workers: 3, multiple_winners: false,
        deliverables: ['Completed checklist', 'Output file'], verification: 'The business reviews the output.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'ops-financial-assessment', industry: 'operations', title: 'Financial assessment', keywords: ['financial', 'finance', 'accounts', 'invoice review', 'budget review'],
        description: 'Assess financial records and report on them independently.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Assessment report', 'Supporting calculations'], verification: 'Figures are checked against source records.', human_approval: true, confidentiality: 'Strict: NDA before access', requires_authorization: false },
    { id: 'ops-compliance-review', industry: 'operations', title: 'Compliance review', keywords: ['compliance', 'policy review', 'regulation', 'gdpr', 'checklist review'],
        description: 'Review a process or policy against a stated standard.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Review report', 'Findings with references'], verification: 'Findings are checked against the standard.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },

    // Hospitality and Hotels
    { id: 'hosp-housekeeping-audit', industry: 'hospitality', title: 'Housekeeping quality audit', keywords: ['housekeeping', 'room inspection', 'cleaning checklist', 'hotel audit', 'hygiene'],
        description: 'Inspect rooms or public areas against a checklist and report every gap with a photo.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Completed checklist', 'Photo of each gap'], verification: 'The business compares the findings with its checklist.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'hosp-menu-photography', industry: 'hospitality', title: 'Restaurant menu photography', keywords: ['menu photo', 'food photography', 'dishes', 'restaurant photos', 'menu shoot'],
        description: 'Photograph each dish on the menu in natural light, to an agreed style.', recommended: 'competitive', alternatives: ['first_valid'], workers: 3, multiple_winners: false,
        deliverables: ['Full-size JPG for each dish', 'Dish list with file names'], verification: 'The business checks each shot against the dish list.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'hosp-mystery-guest', industry: 'hospitality', title: 'Mystery-guest service review', keywords: ['mystery guest', 'guest review', 'service visit', 'secret shopper', 'breakfast service'],
        description: 'Visit as a guest, time the service, and report on what the guest experiences.', recommended: 'independent', alternatives: ['competitive'], workers: 3, multiple_winners: true,
        deliverables: ['Timed service report', 'Photos of the buffet or lobby'], verification: 'The business checks the report against the visit brief.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
    { id: 'hosp-event-staffing', industry: 'hospitality', title: 'Event staffing plan', keywords: ['event staffing', 'staff schedule', 'banquet', 'rota', 'event plan'],
        description: 'Plan shifts and roles for an event, sized to the expected number of guests.', recommended: 'competitive', alternatives: ['team'], workers: 2, multiple_winners: false,
        deliverables: ['Shift plan spreadsheet', 'Role list for each shift'], verification: 'The business checks staffing cover against the expected guest numbers.', human_approval: true, confidentiality: 'Standard', requires_authorization: false },
];

const CATEGORY_FALLBACK = { dev: 'sw-feature-build', design: 'design-logo', content: 'writing-content', marketing: 'marketing-strategy' };

function jobTypeById(id) {
    return JOB_TYPES.find((j) => j.id === id) || null;
}

function publicJobType(j) {
    return {
        id: j.id, industry: j.industry, title: j.title, description: j.description,
        recommended_mode: j.recommended, alternative_modes: j.alternatives,
        suggested_workers: j.workers, multiple_winners: j.multiple_winners,
        deliverables: j.deliverables, verification: j.verification,
        human_approval_required: j.human_approval, confidentiality: j.confidentiality,
        requires_authorization: j.requires_authorization,
    };
}

// The catalogue for the browser and for AI drafting. Nothing secret here.
function catalogue() {
    return {
        modes: Object.entries(EXECUTION_MODES).map(([id, m]) => ({ id, ...m })),
        industries: INDUSTRIES.map((i) => ({ ...i, job_types: JOB_TYPES.filter((j) => j.industry === i.id).map(publicJobType) })),
    };
}

// Best job type for a free-text description. Scores keyword matches; falls back to category.
function recommend(text, category) {
    const haystack = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9+#\s-]/g, ' ') + ' ';
    let best = null;
    let bestScore = 0;
    for (const job of JOB_TYPES) {
        const hits = job.keywords.filter((k) => haystack.includes(' ' + k + ' ') || haystack.includes(' ' + k + 's '));
        if (hits.length > bestScore) {
            best = { job, hits };
            bestScore = hits.length;
        }
    }
    if (!best) {
        const fallback = jobTypeById(CATEGORY_FALLBACK[category] || '');
        if (!fallback) return null;
        best = { job: fallback, hits: [] };
    }
    const j = best.job;
    const why = best.hits.length ?
        `Matched on "${best.hits.slice(0, 3).join('", "')}".` :
        `No close match in the description, so the ${category || 'category'} default was used.`;
    return {
        job_type: j.id,
        industry: j.industry,
        title: j.title,
        execution_mode: j.recommended,
        alternative_modes: j.alternatives,
        suggested_workers: j.workers,
        multiple_winners: j.multiple_winners,
        deliverables: j.deliverables,
        verification: j.verification,
        human_approval_required: j.human_approval,
        confidentiality: j.confidentiality,
        requires_authorization: j.requires_authorization,
        explanation: `${j.title}: ${EXECUTION_MODES[j.recommended].label} usually fits this work. ${why}`,
    };
}

// How a chosen mode fits a job type. Returns a note for the business, never a block.
function modeFit(jobType, mode) {
    if (!jobType) return { fit: 'unknown', note: null };
    if (mode === jobType.recommended) return { fit: 'recommended', note: null };
    if (jobType.alternatives.includes(mode)) return { fit: 'alternative', note: null };
    const suggested = EXECUTION_MODES[jobType.recommended].label;
    return {
        fit: 'unusual',
        note: `${jobType.title} usually works best as ${suggested}. You chose ${EXECUTION_MODES[mode].label}, which you are free to keep. ` +
            `Consider ${suggested} if you want ${mode === 'independent' ? 'one outcome rather than several opinions' : 'the work finished faster or more reliably'}.`,
    };
}

// Modes a draft may choose. Team is excluded: it is set up from a project.
const MODES_FOR_DRAFT = ['first_valid', 'competitive', 'independent'];

// A compact list of job types for the AI prompt. Only public catalogue data goes to a provider.
function classificationBrief() {
    const lines = JOB_TYPES.map((j) => `- ${j.id}: ${j.title} (usually ${j.recommended})`);
    return 'Classification. Pick job_type from this list, or null if none fits. ' +
        'execution_mode is one of first_valid, competitive, independent. ' +
        'Set suggested_workers (1-10) and explain your choice in execution_reason (one or two plain sentences).\n' +
        lines.join('\n');
}

module.exports = {
    EXECUTION_MODES, INDUSTRIES, JOB_TYPES, MODES_FOR_DRAFT, jobTypeById, publicJobType,
    catalogue, recommend, modeFit, classificationBrief,
};
