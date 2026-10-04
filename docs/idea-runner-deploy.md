# Idea Runner — deployment runbook

How to get the agent running against `seoapp`. Roughly 30 minutes, most of it
waiting on a CI run.

Everything below is done by you. The commands are exact; nothing is a sketch.

---

## Before you start

| Fact | Value |
|---|---|
| Monitoring repo | `Ofirm84u/monitoring` — **public** |
| Sandbox repo | `Ofirm84u/seoapp` — private |
| Server | `ofir@34.165.51.161`, key `~/.ssh/gcp_vm` |
| App path | `/home/ofir/monitor`, pm2 process `monitor` |
| Branch | `main` |

Two things that will bite if you skip them:

- **`repository_dispatch` only triggers workflows on the default branch.** The
  caller has to land on seoapp's `main` or it will never fire.
- **Pushing to seoapp's `main` deploys production.** `deploy.yml` ignores
  `docs/**` and `**.md`, but not `.github/**`. Fix that in the same commit.

---

## 1 · Generate the shared secret

One shell for the whole runbook, so `$AGENT_SECRET` stays in scope. It must be
byte-identical in two places, and a mismatch shows up later as an unexplained
401 on the packet fetch.

**Verify its length every time you write it somewhere — 64, always.** The server
copy and the GitHub secret are the two places, and a placeholder pasted through
by mistake is silent: `getSecret()` rejects anything under 32 characters, so the
app fails closed and `dispatch` answers `unconfigured` with no hint as to why.

```bash
AGENT_SECRET=$(openssl rand -hex 32)
echo "$AGENT_SECRET"
```

---

## 2 · Push the monitoring branch

```bash
cd /Volumes/CODEAI/MonitoringApp
git push origin main
```

Don't merge to `main` yet — this branch also carries unpushed pm-hub work.

---

## 3 · Deploy the server

```bash
ssh -i ~/.ssh/gcp_vm ofir@34.165.51.161
cd /home/ofir/monitor

# Back up the database before migrating. NOT with cp: the database runs in WAL
# mode, so app.db itself is 4KB of header and the live data sits in app.db-wal.
# A copied app.db restores an empty database. SQLite's backup API checkpoints
# the WAL into one consistent file, which is the only copy worth keeping.
node -e '
const D = require("better-sqlite3");
const name = "app.db.backup-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
new D("./app.db").backup(name).then(() => console.log("wrote", name));
'

# Prove it holds the data before trusting it. A 4KB file is the failure mode.
ls -la app.db.backup-*

# Write the real value, not a placeholder. Run this from the Mac shell that
# still holds $AGENT_SECRET, so nothing has to be retyped:
#
#   ssh -i ~/.ssh/gcp_vm ofir@34.165.51.161 bash -s <<EOF
#   cd /home/ofir/monitor
#   grep -q '^AGENT_SECRET=' .env.production \
#     && sed -i 's|^AGENT_SECRET=.*|AGENT_SECRET=${AGENT_SECRET}|' .env.production \
#     || echo 'AGENT_SECRET=${AGENT_SECRET}' >> .env.production
#   echo 'APP_BASE_URL=https://mon.m84.me' >> .env.production
#   awk -F= '/^AGENT_SECRET=/{print "server length: " length(\$2)}' .env.production
#   EOF
#
# Then CHECK IT. 64 is the only acceptable answer:
awk -F= '/^AGENT_SECRET=/{print "server length: " length($2)}' .env.production

git fetch origin
git checkout main
git pull
npm ci --legacy-peer-deps
SQLITE_PATH=/home/ofir/monitor/app.db npx drizzle-kit migrate
npm run build
pm2 restart monitor --update-env
pm2 logs monitor --lines 20 --nostream
```

**`SQLITE_PATH` on that migrate line is not optional, and the reason is nasty.**
`SQLITE_PATH` is *unset* in `.env.production` — the app falls back to
`/home/ofir/monitor/app.db` in `src/db/index.ts`, while `drizzle.config.ts` falls
back to `./.data/app.db`. The two defaults disagree, so a bare `drizzle-kit
migrate` creates a brand new empty database under `.data/`, migrates that, and
reports success while the real database is untouched. Nothing warns you. Always
pass the path, and afterwards check that no `.data/` directory appeared.

Confirm the migration landed where you meant:

```bash
node -e '
const db = new (require("better-sqlite3"))("./app.db");
console.log("tables:", db.prepare("select count(*) c from sqlite_master where type=?").get("table").c);
console.log(db.prepare("select name from pragma_table_info(?)").all("agent_checks").map(r => r.name).join(", "));
'
```

**`GITHUB_TOKEN` must also be in `.env.production`.** `dispatch.ts` reads it to call
`repository_dispatch`, to resolve the default branch head for the baseline, and to merge or
close a pull request once you decide. A fine-grained PAT scoped to the target repos with
**Contents: read and write** plus **Pull requests: read and write** is enough — no `workflow`
scope, which `repository_dispatch` does not need. Write it without it reaching your shell
history:

```bash
read -rs GHTOKEN
printf '\nGITHUB_TOKEN=%s\n' "$GHTOKEN" | \
  ssh -i ~/.ssh/gcp_vm ofir@34.165.51.161 'cat >> /home/ofir/monitor/.env.production'
unset GHTOKEN
```

Run `read` on its own and paste at the blank line it leaves: pasted as one block, `read`
swallows the next line of the paste instead of waiting for you.

**`--legacy-peer-deps` is required**, and it is not optional either. `package.json`
pins `nodemailer@8`, while `next-auth@5.0.0-beta.31` and `@auth/core` declare a
`peerOptional` dependency on `nodemailer@^7.0.7`. A plain `npm ci` aborts on that
conflict, leaving `next-auth` and `drizzle-orm` uninstalled — and the next
`npm run build` then fails with a wall of "Module not found" that looks like a
code problem and isn't. The peer exists for Auth.js's Email provider, which this
app does not use; it signs in with Google, and `src/lib/email.ts` drives
nodemailer directly.

It only ever shows up on a clean install, which is what a server does and a
laptop with a warm `node_modules` never does.

**The migration is not optional.** Without it `/defects` returns 500 on first
load.

Confirm it came up:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mon.m84.me/api/status   # 401 is correct — it means auth is working
```

---

## 4 · Wire up seoapp

```bash
cd /Volumes/CODEAI/seoapp
git stash                       # your feat/ai-query-segmentation work
git checkout main && git pull

mkdir -p .github/workflows
cp /Volumes/CODEAI/MonitoringApp/docs/idea-agent-caller.yml \
   .github/workflows/idea-agent.yml

```

Now edit `.github/workflows/deploy.yml` and add `.github/**` under
`paths-ignore`, so CI-only changes stop redeploying production.

```bash
gh secret set AGENT_SECRET --repo Ofirm84u/seoapp --body "$AGENT_SECRET"
gh secret set ANTHROPIC_API_KEY --repo Ofirm84u/seoapp   # paste when prompted

git add .github/workflows/
git commit -m "ci: add Idea Runner caller; skip deploy on CI-only changes"
git push
git stash pop
```

`ANTHROPIC_API_KEY` is only needed for a real run. A dry run works without it.

### Two repository settings, without which nothing runs

Both were discovered the hard way, and both are needed in **every** target repo. Neither
produces a readable error: the first fails the run in under a second with no logs and no
annotation the API will show you, and the second fails after G0 has already passed.

```bash
gh api -X PUT repos/Ofirm84u/seoapp/actions/permissions/workflow \
  -F default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=true
```

- **`default_workflow_permissions=write`** — the agent job asks for `contents: write` and
  `pull-requests: write`, and a workflow can never hold more than the repository default.
  Left at `read`, the job is rejected before it exists: `startup_failure` in 0s.
- **`can_approve_pull_request_reviews=true`** — misleadingly named. This one boolean governs
  *creating* pull requests as well as approving them; GitHub does not separate them. Without
  it the run dies at `gh pr create` with *"GitHub Actions is not permitted to create or
  approve pull requests"*.

Both widen what every workflow in that repo can do, `deploy.yml` included. The second also
lets a workflow approve a pull request, which grants nothing while a repo has no branch
protection but would matter the moment a rule requires one approval. The alternative worth
building is to have the server open the PR with its own token and leave the runner to push
and report — then both settings can stay restrictive.

Verify:

```bash
gh secret list --repo Ofirm84u/seoapp   # AGENT_SECRET and ANTHROPIC_API_KEY beside the four DEPLOY_*
gh api repos/Ofirm84u/seoapp/actions/permissions/workflow   # both values as set above
```

---

## 5 · Dry run — this is the one that matters

The dry run opens an empty PR, but that is not its point. **It is how seoapp's
baseline gets measured on a real runner.** Until G0 passes there, a real run is
refused with `unmeasured_baseline`.

Get a step to dispatch, either from an article:

```bash
curl -s -X POST https://mon.m84.me/api/articles/<articleId>/activate \
  -H "X-Bot-Token: $BOT_API_TOKEN" | jq '{runId, steps}'
```

…or from a defect — report one at https://mon.m84.me/defects, then press
**Plan a fix**, or:

```bash
curl -s -X POST https://mon.m84.me/api/defects/<defectId>/activate \
  -H "X-Bot-Token: $BOT_API_TOKEN" | jq
```

Then dispatch:

```bash
curl -s -X POST https://mon.m84.me/api/agent/dispatch \
  -H "X-Bot-Token: $BOT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"stepId":"<stepId>","dryRun":true}' | jq
```

Watch it — expect about five minutes, mostly `pip install` and `next build`:

```bash
gh run watch --repo Ofirm84u/seoapp
```

### Read the G0 result carefully

That line is the real finding.

- **Green** — seoapp's `main` builds and tests clean on a fresh runner. The
  baseline is genuinely measured and a real run becomes possible.
- **Red** — CI has a problem a laptop didn't: a missing environment variable, a
  test that needs a service, a Python version drift. Worth knowing *before* an
  agent ever runs, and exactly what G0 exists to catch.

You should end with an empty PR in seoapp and the step at `awaiting_decision`.

---

## 6 · A real run

Only after G0 has passed, and after setting `measured: true` for the project in
`src/lib/projects.ts` if it is not already.

```bash
curl -s -X POST https://mon.m84.me/api/agent/dispatch \
  -H "X-Bot-Token: $BOT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"stepId":"<stepId>","dryRun":false}' | jq
```

This runs the implementer. For a defect it must produce a commit prefixed
`test(idea-runner):` that fails when applied to the baseline, or G5 blocks the
step. Nothing merges on its own:

```bash
# Until Phase 4, read the token out of the database
sqlite3 /home/ofir/monitor/app.db \
  "SELECT token FROM agent_decisions WHERE used_at IS NULL ORDER BY rowid DESC LIMIT 1;"

curl -s -X POST https://mon.m84.me/api/agent/decision \
  -H "X-Bot-Token: $BOT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"token":"<token>","action":"merge"}' | jq
```

`action` is `merge`, `reject`, or `answer` (with an `answer` field, when the
agent asked a question). That database lookup is precisely what the Telegram
card replaces in Phase 4.

---

## When something doesn't fire

| Symptom | Cause |
|---|---|
| `409 unmeasured_baseline` | Working as designed — dry run first |
| `ok:true` but no workflow run | Caller isn't on seoapp's **default** branch |
| Packet fetch returns 401 | `AGENT_SECRET` differs between server and repo secret |
| `workflow was not found` | the ref in the caller does not exist on the monitoring repo |
| `409 locked` | A step is already running on that repo; it holds the lock until it settles |
| `startup_failure` in 0s, no logs | A workflow-file issue, usually input types. `client_payload` values arrive as strings, and `dry_run` is declared `boolean` — the caller must wrap it in `fromJSON()` |
| G0 fails during install | Python version — the runner takes it from the packet, and seoapp needs 3.12 |
| `ANTHROPIC_API_KEY is not set` | Secret missing, or a caller copied before it forwarded the key |
| `/defects` returns 500 | The migration in step 3 didn't run |
| `startup_failure` in 0s, no logs | `default_workflow_permissions` is `read` — see step 4 |
| `not permitted to create or approve pull requests` | `can_approve_pull_request_reviews` is false — see step 4 |
| `refusing to allow a GitHub App to create or update workflow` | The branch is cut from a baseline older than a workflow-file change on the default branch. `GITHUB_TOKEN` can never hold that permission; re-dispatch so the baseline is re-resolved |
| Push rejected as non-fast-forward | A previous attempt left the branch behind. The workflow force-pushes its own `idea/`/`fix/` branch, so this means the workflow itself is stale |
| A step stays `dispatched` and the repo answers `409 locked` | The workflow never reported — most likely it never started. `POST /api/agent/steps/<id>/abort` frees the repo |

---

## What is deliberately not automated

- **Nothing merges without a decision.** A verified callback from the workflow
  cannot land a PR; that needs an authenticated caller and a single-use token.
- **The agent cannot install dependencies.** `package.json`, `requirements.txt`
  and the rest are on G2's denylist, so adding Playwright to a repo is a human
  task, done once.
- **Tier C defects have no automated proof.** Purely visual bugs get a
  before/after render and a person decides. No assertion expresses "the button
  overlaps", and pretending otherwise would be the weakest part of the design.
