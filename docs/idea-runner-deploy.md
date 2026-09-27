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
| Branch | `feat/idea-runner` (local only until step 2) |

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

```bash
AGENT_SECRET=$(openssl rand -hex 32)
echo "$AGENT_SECRET"
```

---

## 2 · Push the monitoring branch

```bash
cd /Volumes/CODEAI/MonitoringApp
git push -u origin feat/idea-runner
```

Don't merge to `main` yet — this branch also carries unpushed pm-hub work.

---

## 3 · Deploy the server

```bash
ssh -i ~/.ssh/gcp_vm ofir@34.165.51.161
cd /home/ofir/monitor

# Back up the database before migrating. Seven tables are being added.
cp app.db "app.db.bak-$(date +%F)"

cat >> .env.production <<'EOF'
AGENT_SECRET=PASTE_FROM_STEP_1
APP_BASE_URL=https://mon.m84.me
EOF

git fetch origin
git checkout feat/idea-runner
git pull
npm ci
SQLITE_PATH=/home/ofir/monitor/app.db npx drizzle-kit migrate
npm run build
pm2 restart monitor
pm2 logs monitor --lines 20 --nostream
```

Check `SQLITE_PATH` in `.env.production` first and use that path if it differs
from the default above.

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

# Point at the branch until it merges to main
sed -i '' 's|idea-agent.yml@main|idea-agent.yml@feat/idea-runner|' \
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

Verify:

```bash
gh secret list --repo Ofirm84u/seoapp   # AGENT_SECRET and ANTHROPIC_API_KEY beside the four DEPLOY_*
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
| `workflow was not found` | `@feat/idea-runner` not pushed, or the ref in the caller is wrong |
| `409 locked` | A step is already running on that repo; it holds the lock until it settles |
| G0 fails during install | Python version — the runner takes it from the packet, and seoapp needs 3.12 |
| `ANTHROPIC_API_KEY is not set` | Secret missing, or a caller copied before it forwarded the key |
| `/defects` returns 500 | The migration in step 3 didn't run |

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
