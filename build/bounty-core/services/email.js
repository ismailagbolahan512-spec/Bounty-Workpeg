// services/email.js — transactional email (verification and password reset).
//
// Env vars:
//   RESEND_API_KEY  API key from resend.com (required in production)
//   EMAIL_FROM      Sender, e.g. "Bounty <no-reply@yourdomain.com>" (the domain must be verified in Resend)
//   APP_URL         Public site address, e.g. "https://bounty.onrender.com" (used in email links)
//
// Development without RESEND_API_KEY: the email is printed to the server console
// so the flow can be tested locally. Production without the key: sendEmail throws.

const RESEND_URL = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, text }) {
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
        if (process.env.NODE_ENV === 'production') {
            const err = new Error('Email is not configured on the server');
            err.status = 503;
            throw err;
        }
        console.log(`\n--- [dev email, not sent] to: ${to}\nSubject: ${subject}\n${text}\n---\n`);
        return { devOnly: true };
    }

    const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: process.env.EMAIL_FROM || 'Bounty <onboarding@resend.dev>',
            to: [to],
            subject,
            text,
        }),
        signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Email provider rejected the message (${res.status}): ${detail}`);
    }
    return res.json();
}

function appUrl() {
    return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

module.exports = { sendEmail, appUrl };
