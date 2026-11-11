# Bounty (Workpeg hospitality hackathon)

A Workpeg peg for hospitality teams: managers post small jobs (housekeeping,
kitchen, events, maintenance, front desk), staff submit finished work, and
managers approve or reject it. Built from the Workpeg project scaffold.

Data lives in Workpeg tables (`bounties` and `submissions`). The `function/`
folder is scaffolded but not yet used.

```text
AGENTS.md        how a coding agent should build this peg (CLAUDE.md imports it)
workpeg.json     the manifest: namespace, function entrypoint, runtime
ui/              the interface, a Scaffold app (workpeg ui serve ui/ --fake-cloud)
function/        the backend (workpeg function run --path function/)
```

## Working on it

```bash
workpeg ui build ui/                         # compile the UI into ui/dist/
workpeg ui serve ui/ --fake-cloud            # see it signed in, as a dev install
workpeg doctor ui/ --offline                 # check the project
workpeg function run --path function/        # run the function locally
```

`ui/` starts as a working app: the Workpeg Scaffold, a home page, and a
bounty list with its detail page. Keep the shape, replace the example.
`AGENTS.md` explains why each file is the way it is.

`workpeg project submit` will eventually review and release both halves
together to `<namespace>.workpeg.com`. It does not exist yet; until it does,
each half ships through its own command.
