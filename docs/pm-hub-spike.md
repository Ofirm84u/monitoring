# PM Hub — Phase 0.5 Backend Spike

A thin vertical slice that de-risks the SRS criticals before the full build. See the SRS at
`~/.claude/plans/i-want-to-plan-binary-parrot.md`.

## What the spike proves
| Risk | Mechanism | Validated by |
|---|---|---|
| C1 — Edge-safe sessions | Auth.js v5, **JWT strategy** | `next build` (middleware compiles) |
| C2 — bot can't impersonate | `getRequestUser` resolves `X-Telegram-Id` → `telegram_links` server-side | `/api/spike/whoami` |
| C3 — tokens encrypted at rest | AES-256-GCM wrapper around the Drizzle adapter `linkAccount` | `scripts/spike-validate.ts` |
| FR-AUTH-6 — tenant isolation | every query filtered by acting user id | `scripts/spike-validate.ts` |
| NFR-SEC-4 — email normalization + allowlist | `src/lib/email-normalize.ts` | `scripts/spike-validate.ts` |
| H1/H2 — calendar sync, TZ-stable | per-user OAuth, dedicated "PM Hub" calendar, all-day `date` events | `/api/spike/calendar` (live) |

## Validated now (no Google needed)
```bash
npm run build                              # typechecks the whole new layer
mkdir -p .data
SQLITE_PATH=./.data/app.db npm run db:migrate
SQLITE_PATH=./.data/app.db TOKEN_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  node --experimental-strip-types scripts/spike-validate.ts
```
All three groups print `ALL PASS ✅`.

## Live Google roundtrip (needs your credentials)
1. **Google Cloud Console** → create a project (or reuse one).
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen** → External; add yourself (and any collaborators) as **Test users** (≤100, no verification needed).
4. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI:
   `http://localhost:3040/api/auth/callback/google`
5. Copy `.env.spike.example` values into **`.env.local`** and fill `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
   `AUTH_SECRET`, `TOKEN_ENC_KEY`, `ALLOWED_EMAILS`.
6. Run and test:
   ```bash
   SQLITE_PATH=./.data/app.db npm run dev
   # visit http://localhost:3040/api/auth/signin  → sign in with an allowlisted Google account
   # then in the same browser:
   #   GET  http://localhost:3040/api/spike/whoami    → { id, email, source:"session", owner:true/false }
   #   POST http://localhost:3040/api/spike/areas     (body {"name":"Work"}) → creates your area
   #   GET  http://localhost:3040/api/spike/areas     → only YOUR areas
   #   POST http://localhost:3040/api/spike/calendar  → pushes+pulls+deletes a test event in your "PM Hub" calendar
   ```
   A non-allowlisted Google account should be **rejected** at sign-in.

## Bot-path identity test (optional)
With `BOT_API_TOKEN` set and a row in `telegram_links`, call `whoami` as the bot:
```bash
curl -s localhost:3040/api/spike/whoami -H "X-Bot-Token: $BOT_API_TOKEN" -H "X-Telegram-Id: <linked-id>"
```
Without a matching `telegram_links` row it returns 401 — a leaked token alone cannot impersonate a user.

## Spike artifacts (removed/rewritten in the full build)
`src/app/api/spike/*`, `scripts/spike-validate.ts`. The DB layer (`src/db/*`), `src/auth.ts`,
`src/lib/{crypto,email-normalize,request-user,gcal}.ts` carry forward into Phases 1–6.
