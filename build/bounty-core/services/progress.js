// services/progress.js — the project progress view, computed from real data each time.
// Nothing is stored. A task's state comes from its bounty status, its submissions and its
// dependencies. Only the backend decides readiness: an AI suggestion never does.

const TERMINAL = ['completed', 'closed', 'expired'];

// tasks:    [{ id, title, status, deadline }]
// deps:     [{ bounty_id, depends_on_id }]   (bounty_id waits on depends_on_id)
// subCounts: Map(task id -> { pending, revision_requested, approved, rejected })
function computeProgress(tasks, deps, subCounts, now = Date.now()) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const waitsOn = new Map(tasks.map((t) => [t.id, []]));
    const blocks = new Map(tasks.map((t) => [t.id, []]));
    for (const d of deps) {
        if (waitsOn.has(d.bounty_id) && byId.has(d.depends_on_id)) {
            waitsOn.get(d.bounty_id).push(d.depends_on_id);
            blocks.get(d.depends_on_id).push(d.bounty_id);
        }
    }

    // Tasks created together share a timestamp, so order by dependency depth (steps in project order).
    const depth = new Map();
    const depthOf = (id, seen = new Set()) => {
        if (depth.has(id)) return depth.get(id);
        if (seen.has(id)) return 0;
        seen.add(id);
        const d = waitsOn.get(id).length ? 1 + Math.max(...waitsOn.get(id).map((x) => depthOf(x, seen))) : 0;
        depth.set(id, d);
        return d;
    };
    tasks.forEach((t) => depthOf(t.id));
    const ordered = tasks.slice().sort((a, b) => depth.get(a.id) - depth.get(b.id));

    const out = ordered.map((t) => {
        const counts = subCounts.get(t.id) || {};
        const unfinished = waitsOn.get(t.id).map((id) => byId.get(id)).filter((x) => x.status !== 'completed');
        let state;
        if (t.status === 'completed') state = 'completed';
        else if (t.status === 'closed' || t.status === 'expired') state = t.status;
        else if (unfinished.length > 0) state = 'blocked';
        else if ((counts.pending || 0) > 0) state = 'under_review';
        else if ((counts.revision_requested || 0) > 0) state = 'in_progress';
        else state = 'ready';

        const open = !TERMINAL.includes(state);
        return {
            id: t.id,
            title: t.title,
            state,
            overdue: open && new Date(t.deadline).getTime() < now,
            waiting_on: unfinished.map((u) => ({ id: u.id, title: u.title })),
            blocks_count: blocks.get(t.id).filter((id) => byId.get(id).status !== 'completed').length,
            submissions: {
                pending: counts.pending || 0,
                revision_requested: counts.revision_requested || 0,
                approved: counts.approved || 0,
                rejected: counts.rejected || 0,
            },
        };
    });

    const total = out.length;
    const completed = out.filter((t) => t.state === 'completed').length;
    const bottlenecks = out
        .filter((t) => t.state !== 'completed' && t.blocks_count > 0)
        .sort((a, b) => b.blocks_count - a.blocks_count)
        .slice(0, 3)
        .map((t) => ({ id: t.id, title: t.title, blocks_count: t.blocks_count }));

    // A blocked task whose prerequisite has no work submitted at all is the usual gap to chase.
    const missing = [];
    for (const t of out.filter((x) => x.state === 'blocked')) {
        for (const w of t.waiting_on) {
            const c = subCounts.get(w.id) || {};
            const anyWork = Object.values(c).some((n) => n > 0);
            if (!anyWork) missing.push({ task: t.title, needs: w.title, reason: 'Nobody has submitted work for this prerequisite yet.' });
        }
    }

    return {
        total,
        completed,
        percent: total ? Math.round((completed / total) * 100) : 0,
        overdue_count: out.filter((t) => t.overdue).length,
        tasks: out,
        bottlenecks,
        missing_prerequisites: missing,
    };
}

module.exports = { computeProgress };
