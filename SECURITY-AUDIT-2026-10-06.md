# Security audit — MonitoringApp / Idea Runner

**Date:** 2026-10-06
**Scope:** `main` @ `f967e4a` — the 38 commits merged from `feat/idea-runner`, plus the
auth and middleware they run behind.
**Method:** OWASP Top 10:2025, static review plus passive dependency analysis. No live
probing beyond the owner's own endpoints.

---

## Inventory

| | |
|---|---|
| Stack | Next.js 15.5.15 (App Router), React 19.2.5, TypeScript strict |
| Data | Drizzle ORM 0.45.2 over better-sqlite3 12.11.1 — parameterized throughout |
| Auth | HMAC-signed password cookie (`mon_session`, key derived from `MONITOR_PASSWORD`); `X-Bot-Token` header for the bot; Auth.js 5.0.0-beta.31 present but Google unconfigured and unused |
| Agent auth | HMAC-SHA256 over raw request bytes (`x-agent-signature`, 5-min window); stateless packet tokens bound to step + attempt |
| Trust boundaries | 32 HTTP routes; GitHub Actions callbacks; article URL/PDF/text ingestion; defect image upload; Telegram callbacks; **LLM prompts built from fetched web content** |
| Edge | Caddy (container) terminating TLS for 10 hosts; app reached on `172.17.0.1:3040` |
| Audience | Single owner, internal tool |

---

## Findings

### H1 · Next.js is 12 patch versions behind, with middleware-bypass advisories — **High**

`package.json:next@15.5.15`. `npm audit` reports middleware/proxy bypass issues fixed in
later 15.5.x:

- *Middleware / Proxy bypass in App Router applications via segment-prefetch routes* (High, and an "Incomplete Fix Follow-Up" for the same class)
- *Middleware / Proxy bypass through dynamic route parameter injection* (High)

**Why it matters here specifically:** `src/middleware.ts` is the only gate in front of
every page. A bypass skips it.

**Why it is High and not Critical:** every API route authenticates independently
(verified — see A01 below), so a middleware bypass exposes page *shells*, not data. The
two Critical RCEs in the same advisory set do not apply: one is Windows-only, and the
other needs the Image Optimization API with AVIF — `next/image` is not used anywhere in
`src/`, and `next.config.ts` configures no remote patterns.

**Fix:** `npm install next@15.5.27` — same major, no breaking changes expected.

---

### H2 · Auth.js advisory describes the exact failure observed in production — **High**

`next-auth@5.0.0-beta.31`:

> *Auth.js: Configuration errors can cause existence-based auth checks to fail open (auth object populated with an error)*

This was not theoretical here. On 2026-10-04 production had no `AUTH_SECRET`, every
`auth()` call threw `MissingSecret`, and `src/middleware.ts:33` — `export default
auth((request) => …)` — returned **before** the gate logic ran. Every page served 200 to a
request carrying no cookies at all.

Configuring `AUTH_SECRET` fixed the symptom and the gate now closes (`/` and `/defects`
→ 307 `/login`). The *class* remains: a future config error fails open the same way.

**Fix:** `npm install next-auth@5.0.0-beta.32`, same major. Consider also asserting
`AUTH_SECRET` at boot so a misconfiguration fails loudly rather than silently.

---

### M1 · Untrusted web content reaches an implementer with repository write access — **Medium**

The chain is real and worth stating plainly:

```
article URL  →  src/lib/article-extract.ts:extractFromUrl  →  analyzeArticle
             →  planArticleImplementation  →  buildImplementerPrompt
             →  claude -p --permission-mode bypassPermissions   (in CI, GITHUB_TOKEN with contents:write)
```

Page content the owner did not write becomes instructions an agent acts on. Classic
indirect prompt injection.

**What constrains it** — and these are genuine, not hand-waving:

- `DENIED_PATHS` (`agent-packet.ts:22`) blocks `.github/workflows/**`, lockfiles,
  manifests, migrations, Dockerfiles and `.env*`; enforced **server-side** in
  `gates.ts:evaluateDiffBudget`, not in workflow bash
- Diff budget of 8 files / 400 lines, same place
- A diff made only of build artifacts fails G2 outright
- The verify command must still pass (G1)
- **Nothing merges without a human spending a single-use decision token.** A verified
  callback cannot land a PR
- Web tools are disabled for the implementer (`--disallowed-tools "WebFetch WebSearch"`)

So the worst realistic outcome is a malicious pull request that a person must approve.
That is the designed control and it holds. Rated Medium rather than High because the
merge gate is strong and server-side; rated Medium rather than Low because the reviewer
is being asked to catch hostile code in a diff that otherwise looks green — and
`PR #15` showed that a passing ladder still warrants reading the code.

**Recommended hardening:** treat article text as data in the prompt (delimit it and state
that content inside the delimiters is never an instruction), and keep G4's concerns on the
decision card, which is already done.

---

### M2 · nodemailer carries High advisories; only unreachable because email is broken — **Medium**

`nodemailer@8.0.5`, with advisories including arbitrary file read / SSRF via the
message-level `raw` option and two quadratic-time DoS parsers. Fix requires
`nodemailer@10.0.15` — a **major** bump, and `next-auth` declares a `peerOptional` on
`nodemailer@^7.0.7`, which is the conflict that forces `npm ci --legacy-peer-deps`.

Not currently exploitable: `GMAIL_USER` and `GMAIL_APP_PASSWORD` are absent from
`.env.production`, so `sendEmail()` throws before reaching nodemailer's parsers. That is
an accident of a broken feature, not a control. If email alerting is ever configured, this
becomes live — so fix it *before* adding the credentials, not after.

---

### L1 · SSRF: no private-range block on article URL fetching — **Low**

`src/lib/article-extract.ts:65` validates the protocol and nothing else, then fetches with
`redirect: "follow"`. Internal addresses (`127.0.0.1`, `10.x`, container names) are
reachable, and the extracted text is returned to the caller.

Low because: the route requires authentication and the only authenticated principal is the
owner; and GCP metadata at `169.254.169.254` requires a `Metadata-Flavor: Google` header
this fetch does not send, so credential theft via metadata is blocked.

**Fix:** resolve the host and reject private/link-local ranges before fetching, and re-check
after each redirect.

---

### L2 · `/_next/image` is excluded from the auth gate — **Low**

`src/middleware.ts:84` excludes `_next/image` from the matcher. With no remote patterns
configured the optimizer only serves local assets, so there is nothing sensitive behind it
today. Noted because the exclusion is permanent while the config is not.

---

### ✅ Fixed during this audit

**Four agent routes had no rate limiting** — `agent/runs`, `agent/runs/[id]`,
`agent/steps/[id]/abort`, `agent/steps/[id]/notify`. They were the only routes in the
codebase without one. Fixed in `f967e4a` with limits matched to what each route does
(60/min reads, 20/min abort, 10/min notify, since notify sends Telegram messages).
Verified in production: ten requests pass, the eleventh returns 429.

---

## Reviewed and clean

| Category | Result |
|---|---|
| **A01 Broken access control** | All 9 `/api/agent/*` routes authenticate despite `/api/agent` being public in middleware — three by HMAC signature, one by packet token, five by session-or-bot. Verified by enumeration, not by reading comments. The page gate closes correctly now `AUTH_SECRET` is set. |
| **A02 Cryptographic failures** | HMAC-SHA256 with `timingSafeEqual` (`agent-auth.ts:50-53`); signature computed over **raw request bytes**, never re-serialized JSON; 5-minute replay window; signature checked before expiry so probes learn nothing. Session tokens HMAC-signed. Decision tokens are 32-char base64url from `randomBytes(24)`, expiring, and spent by a conditional `UPDATE … WHERE used_at IS NULL` — verified live: replay returns "Decision already used", distinct from "not found". |
| **A03 Injection** | Drizzle parameterizes everything; no string-concatenated SQL anywhere. `eval` in the workflow runs `VERIFY_CMD` from `projects.ts`, which is server-owned config, not user input. |
| **A04 Insecure design** | The three-context separation (planner ≠ implementer ≠ verifier) and the server-computed verdict are the design's core. Gate results are computed server-side from runner *observations*; a runner cannot self-declare a pass. Readiness requires every blocking gate to be **present**, so silence no longer reads as success. |
| **A05 Security misconfiguration** | `.gitignore` covers `.env*`, `logs`, `*.db`; no `.env` is tracked. CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` set on every response by middleware. |
| **A06 Vulnerable components** | See H1, H2, M2. |
| **A07 Auth failures** | Rate limiting on all 32 routes (after this audit's fix). Bot token compared with a timing-safe helper. |
| **A08 Integrity failures** | Agent branches are force-pushed only within the `idea/` + `fix/` namespace; `deleteAgentBranch` refuses any other prefix. |
| **A09 Logging failures** | **Was** a finding — the bot token was written to a world-readable log 1,143,529 times by httpx at INFO. Fixed 2026-10-04 (`4c51f18`), token rotated and the old one verified dead (401). |
| **A10 SSRF** | See L1. |

---

## Coverage gaps — not reviewed, not in this repo

- **Caddy configuration** (`/home/ofir/caddy/Caddyfile`) — TLS and routing for 10 public hosts
- **GCP IAM, firewall rules, VM service-account scopes**
- **The other 30 containers** on the VM — bizitis, beiteden, bookme, kosher, crm-mati, prdaily, sheelot and their databases
- **`/home/ofir/monitoring/server-monitor.sh`** — runs every 2 minutes as the owner, holds `MONITOR_SECRET`, and is **not version-controlled**. PR #1 would track it but is 55 lines stale.
- **seoapp, and the other 12 target repositories** the agent can open PRs against

---

## Do this first

1. `npm install next@15.5.27 next-auth@5.0.0-beta.32` — both same-major, addresses H1 and H2
2. Decide on nodemailer (M2) **before** configuring email credentials, not after
3. Add private-range rejection to `extractFromUrl` (L1)
4. Update PR #1 to the live `server-monitor.sh` before merging it, or it reverts the alert fixes
