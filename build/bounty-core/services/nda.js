// services/nda.js — the confidentiality terms a business agrees to when it posts a task from Workpeg,
// and that every worker accepts before starting it. One source for the chat and the task record.
// Plain, mutual-style terms for a short engagement. Version it when the wording changes, so a record
// shows exactly which terms were agreed. Not legal advice: have counsel review before wide use.

const NDA_VERSION = '2026-11-14';

const NDA_CLAUSES = [
    '1. Confidential information means any non-public information about this task, the business that posted it, its premises, guests, staff, systems, prices or plans, that is shared through Bounty or Workpeg.',
    '2. The worker uses confidential information only to carry out this task, and discloses it only to people who need it for the task and are bound by the same obligations.',
    '3. The worker protects confidential information with at least reasonable care, and does not copy it beyond what the task requires.',
    '4. These obligations do not apply to information that is or becomes public without breach, that the recipient already lawfully held, that is independently developed, or that is lawfully received from a third party. Disclosure required by law is allowed after prompt notice, where the law permits it.',
    '5. Any personal data of guests or staff is handled only as needed for the task and in line with the Nigeria Data Protection Act 2023.',
    '6. On completion of the task, or when asked, the worker returns or securely deletes confidential information.',
    '7. These obligations last for two years after the task ends. For personal data, they last as long as the worker holds it.',
    '8. No licence or other right is granted by sharing information. Nothing here obliges either side to enter a further agreement.',
    '9. A breach may cause harm that money does not fully repair, so the affected party may seek an injunction in addition to other remedies.',
    '10. The laws of the Federal Republic of Nigeria govern these terms, and the courts of Lagos State have jurisdiction.',
];

const NDA_INTRO = 'By agreeing, the business confirms that it will share this task only on these terms, and that every worker who takes the task must accept the same terms on Bounty before starting.';

const NDA_TEXT = [NDA_INTRO].concat(NDA_CLAUSES).join('\n');

module.exports = { NDA_VERSION, NDA_CLAUSES, NDA_INTRO, NDA_TEXT };
