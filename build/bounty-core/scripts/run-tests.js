// scripts/run-tests.js — runs the suites one at a time, each against a fresh server.
//
// Usage:
//   npm test                    # rules/off suites, plus browser suites when Playwright is installed
//   npm test -- --with-mock     # also starts the mock AI provider (port 4555) for the mock suites
//   npm test -- --only=smoke    # run one suite by name
//
// Needs DATABASE_URL in the environment (or .env). A fresh server per suite is required:
// the auth limiter is in memory and would otherwise leak between suites.
// Browser suites need Playwright; set PLAYWRIGHT_NODE_PATH or install it under node_modules.
// Suites that need the mock are skipped, with the reason printed, unless --with-mock is given.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3100;
const MOCK_PORT = 4555;
const S3_PORT = 4566;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bounty-tests-'));
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_NODE_PATH || '/opt/npm-tools/node_modules';

const MOCK = `http://localhost:${MOCK_PORT}`;
const AI_ENV = {
    rules: { AI_PROVIDER: 'rules' },
    off: { AI_PROVIDER: 'off' },
    mock: { AI_PROVIDER: 'openai', AI_BASE_URL: MOCK, AI_API_KEY: 'mock-key', AI_MODEL: 'mock-model', AI_TIMEOUT_MS: '3000' },
};
const TEST_AI_MODE = { rules: 'rules', off: 'unconfigured', mock: 'mock' };

// Suites run in two phases: first with no mock running (project-test starts its own stub on the
// mock port, so it must run before the shared mock is started), then with the shared mock.
const SUITES = [
    { name: 'smoke', file: 'scripts/smoke-test.js', ai: 'rules' },
    { name: 'signin-limit', file: 'scripts/signin-limit-test.js', ai: 'rules' },
    { name: 'signin-ip-cap', file: 'scripts/signin-ip-cap-test.js', ai: 'rules', server: { AUTH_IP_LIMIT: '5' } },
    { name: 'workspace', file: 'scripts/workspace-test.js', ai: 'rules' },
    { name: 'coordinator', file: 'scripts/coordinator-test.js', ai: 'rules' },
    // project-test expects AI_MODE=unconfigured (no provider) and starts its own stub for the mock mode.
    { name: 'project', file: 'scripts/project-test.js', ai: 'off', testMode: 'unconfigured' },
    // Its own stub on port 4555 stands in for the legacy URL planner; the shared mock must not be running.
    { name: 'project-legacy', file: 'scripts/project-test.js', ai: 'off', testMode: 'mock',
        server: { AI_PROVIDER_URL: 'http://127.0.0.1:4555/plan' } },
    { name: 'review-trust', file: 'scripts/review-trust-test.js', ai: 'rules' },
    { name: 'execution-modes', file: 'scripts/execution-modes-test.js', ai: 'rules' },
    { name: 'phase1', file: 'scripts/phase1-test.js', ai: 'rules' },
    { name: 'phase2', file: 'scripts/phase2-test.js', ai: 'rules' },
    { name: 'phase2-ui', file: 'scripts/phase2-ui-test.js', ai: 'rules', browser: true },
    { name: 'phase3', file: 'scripts/phase3-test.js', ai: 'rules' },
    { name: 'phase3-ui', file: 'scripts/phase3-ui-test.js', ai: 'rules', browser: true },
    { name: 'phase4', file: 'scripts/phase4-test.js', ai: 'rules' },
    { name: 'phase4-ui', file: 'scripts/phase4-ui-test.js', ai: 'rules', browser: true },
    { name: 'security', file: 'scripts/security-test.js', ai: 'rules' },
    { name: 'creator-protection', file: 'scripts/creator-protection-test.js', ai: 'rules' },
    { name: 'phase1-ui', file: 'scripts/phase1-ui-test.js', ai: 'rules', browser: true },
    { name: 'execution-ui', file: 'scripts/execution-ui-test.js', ai: 'rules', browser: true },
    { name: 'ai-modes', file: 'scripts/ai-modes-test.js', ai: 'rules' },
    { name: 'integration', file: 'scripts/integration-test.js', ai: 'rules' },
    { name: 'ui', file: 'scripts/ui-test.js', ai: 'rules', browser: true },
    { name: 'workspace-ui', file: 'scripts/workspace-ui-test.js', ai: 'rules', browser: true },
    { name: 'agreement-ui', file: 'scripts/agreement-ui-test.js', ai: 'rules', browser: true },
    { name: 'protection-ui', file: 'scripts/protection-ui-test.js', ai: 'rules', browser: true },
    { name: 'files', file: 'scripts/files-test.js', ai: 'rules' },
    { name: 'payments-webhook', file: 'scripts/payments-webhook-test.js', ai: 'rules' },
    { name: 'coordinator-ui', file: 'scripts/coordinator-ui-test.js', ai: 'rules', browser: true },
    { name: 'projects-ui', file: 'scripts/projects-ui-test.js', ai: 'rules', browser: true },
    { name: 'project-ui', file: 'scripts/project-ui-test.js', ai: 'rules', browser: true },
    { name: 'ai-architect', file: 'scripts/ai-architect-test.js', ai: 'mock', mock: true,
        server: { AI_DAILY_LIMIT: '6', AI_RATE_PER_MINUTE: '50' } },
    { name: 'checker', file: 'scripts/checker-test.js', ai: 'mock', mock: true,
        server: { AI_DAILY_LIMIT: '100', AI_RATE_PER_MINUTE: '10' } },
    { name: 'checker-ui', file: 'scripts/checker-ui-test.js', ai: 'mock', mock: true, browser: true,
        server: { AI_DAILY_LIMIT: '100', AI_RATE_PER_MINUTE: '10' } },
    { name: 'portfolio', file: 'scripts/portfolio-test.js', ai: 'mock', mock: true },
    { name: 'portfolio-ui', file: 'scripts/portfolio-ui-test.js', ai: 'mock', mock: true, browser: true },
    { name: 'integration-mock', file: 'scripts/integration-test.js', ai: 'mock', mock: true },
];

const args = process.argv.slice(2);
const withMock = args.includes('--with-mock');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);

const playwrightOk = fs.existsSync(path.join(PLAYWRIGHT_PATH, 'playwright'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startProcess(script, env, logPath) {
    const log = fs.openSync(logPath, 'w');
    return spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', log, log] });
}

function stopProcess(child) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
    });
}

async function waitForServer(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fetch(url);
            return true;
        } catch (_) {
            await sleep(250);
        }
    }
    return false;
}

function runSuite(suite, mockUp) {
    return new Promise(async (resolve) => {
        const serverLog = path.join(OUT_DIR, `${suite.name}-server.log`);
        const env = {
            ...process.env,
            PORT: String(PORT),
            JWT_SECRET: process.env.JWT_SECRET || 'local-test-only-secret',
            B2_KEY_ID: 'test-key-id',
            B2_APPLICATION_KEY: 'test-application-key',
            B2_BUCKET: 'bounty-test-private',
            B2_ENDPOINT: 's3.us-east-005.backblazeb2.com',
            B2_TEST_ENDPOINT_URL: `http://localhost:${S3_PORT}`,
            PANDASCROW_SECRET_KEY: 'sktest-local-test-secret',
            ...AI_ENV[suite.ai],
            ...(suite.server || {}),
        };
        const server = startProcess('index.js', env, serverLog);
        if (!(await waitForServer(BASE, 20000))) {
            await stopProcess(server);
            return resolve({ name: suite.name, status: 'fail', reason: `server did not start, see ${serverLog}` });
        }

        const testEnv = {
            ...process.env,
            BASE,
            LOG_FILE: serverLog,
            AI_MODE: suite.testMode || TEST_AI_MODE[suite.ai],
            AI_API_KEY_VALUE: suite.ai === 'mock' ? 'mock-key' : '',
        };
        if (suite.browser) testEnv.NODE_PATH = [PLAYWRIGHT_PATH, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

        const started = Date.now();
        const test = spawn(process.execPath, [path.join(ROOT, suite.file)], { cwd: ROOT, env: testEnv, stdio: 'inherit' });
        test.on('exit', async (code) => {
            await stopProcess(server);
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            resolve({ name: suite.name, status: code === 0 ? 'pass' : 'fail', reason: code === 0 ? `${seconds}s` : `exit code ${code}; server log ${serverLog}` });
        });
    });
}

async function main() {
    if (!process.env.DATABASE_URL && !fs.existsSync(path.join(ROOT, '.env'))) {
        console.error('DATABASE_URL is not set and there is no .env file. Set DATABASE_URL to a test database.');
        process.exit(2);
    }

    const results = [];
    const selected = SUITES.filter((s) => !only || s.name === only);
    if (only && selected.length === 0) {
        console.error(`No suite named "${only}". Names: ${SUITES.map((s) => s.name).join(', ')}`);
        process.exit(2);
    }

    const skip = (s, reason) => results.push({ name: s.name, status: 'skip', reason });
    const plan = (s) => {
        if (s.browser && !playwrightOk) return 'Playwright not found (set PLAYWRIGHT_NODE_PATH)';
        if (s.mock && !withMock) return 'needs the mock AI provider (run with --with-mock)';
        return null;
    };

    const phases = [selected.filter((s) => !s.mock), selected.filter((s) => s.mock)];
    const s3 = startProcess('scripts/fake-s3.js', { ...process.env, PORT: String(S3_PORT) }, path.join(OUT_DIR, 's3.log'));
    await sleep(300);
    for (const [i, phase] of phases.entries()) {
        let mock = null;
        const runnable = phase.filter((s) => {
            const why = plan(s);
            if (why) skip(s, why);
            return !why;
        });
        if (runnable.length && i === 1) {
            mock = startProcess('scripts/ai-mock-provider.js', { ...process.env, PORT: String(MOCK_PORT) }, path.join(OUT_DIR, 'mock.log'));
            if (!(await waitForServer(MOCK, 5000))) {
                await stopProcess(mock);
                for (const s of runnable) results.push({ name: s.name, status: 'fail', reason: 'mock provider did not start' });
                continue;
            }
        }
        for (const s of runnable) {
            console.log(`\n=== ${s.name} ===`);
            results.push(await runSuite(s, Boolean(mock)));
        }
        await stopProcess(mock);
    }

    await stopProcess(s3);
    console.log('\n=== Summary ===');
    for (const r of results) {
        const mark = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
        console.log(`${mark}  ${r.name.padEnd(18)} ${r.reason}`);
    }
    const failed = results.filter((r) => r.status === 'fail');
    const passed = results.filter((r) => r.status === 'pass').length;
    const skipped = results.filter((r) => r.status === 'skip').length;
    console.log(`\n${passed} passed, ${failed.length} failed, ${skipped} skipped. Logs: ${OUT_DIR}`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
