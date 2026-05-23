# Trader App — Build Prompts

Self-contained prompts to build the trader app, derived from `trading-strategies-notes.md` (Schwager + Minervini + Douglas synthesis).

Each prompt is independently usable. Paste into Claude Code in a fresh trader-app project. Run in order — each tier builds on the prior one.

Tech stack is intentionally unspecified. Start each prompt by telling Claude what stack you want, or let it ask.

---

## Prompt 0 — Project brief (run first)

```
I'm building a retail equity trader app. Before you write any code, read this brief and confirm you understand the design philosophy.

THESIS
Strategy edges are commodities. Mindset and execution discipline are the moat.
95% of retail traders fail not from bad strategy but from fear-based execution
errors: hesitating, not setting stops, revenge trading, premature profit-taking,
sizing into euphoria. This is the consensus of three sources — Jack Schwager
(Market Wizards), Mark Minervini (Trade Like a Stock Market Wizard), and Mark
Douglas (Trading in the Zone).

Therefore the app's primary job is to ENFORCE execution discipline.
The signal/screener layer is secondary.

USER
Retail equity trader, US markets, swing-trading time frame (days to months).
The user executes trades manually through their own broker. This app sits in
front of the broker as a discipline + journaling layer. It does NOT route
orders to a broker.

DESIGN PRINCIPLES
1. The app refuses actions that violate risk rules. Hard stop, no override
   in Tier 1 features. (Tier 2+ may allow override with friction.)
2. Every constraint maps to a specific rule from a named source — cite the
   source in code comments where relevant.
3. Educational nudges, not punishment. The app coaches; it doesn't shame.
4. Data inputs are minimized — most features need only price + user actions.
   Don't add a feature that requires news/sentiment/social data.

DELIVERY
Build in tiers (separate prompts will follow). Tier 1 first.

Ask me about: tech stack preference, data source for prices/fundamentals,
and authentication/storage approach. Then wait for the Tier 1 prompt.
```

---

## Prompt MVP — Ship this first (and maybe only this)

The six features below are the entire moat. Tiers 1–4 are additive expansion.
If you ship only this, the app already materially outperforms what's available
to retail traders today. **Build this before anything else.**

```
Build the MVP — six features, no more. Anything beyond these six is scope
creep and is explicitly deferred. All six are hard-enforced (no override).

Minimal scaffolding allowed: a config screen to capture (equity, risk%-per-
trade, max open positions, target avg win % — used in feature 5). One trade-
list view. No analytics, no charts, no scanner, no fundamentals.

(1) PRE-TRADE JOURNAL BLOCKS ORDER SUBMISSION
A new trade requires: symbol, entry, stop, target, R-multiple (auto-
calculated as (target-entry)/(entry-stop) for long, inverse for short),
reason/setup (free text, min 20 chars). Form refuses submission if any
field is blank or if R < 1.

(2) AUTO-STOP REQUIRED AT ENTRY
Stop price is a required field — there is no path to creating a trade
without one. UI shows dollar risk and % of equity at risk in real time
as the user types.

(3) AUTO-SCALE-OUT WITH BREAKEVEN STOP MOVE
On every trade, user defines a scale-out trigger (default: +1R). When
price hits the trigger, the app prompts the user to: (a) record a partial
sale of 1/3 of position, and (b) move the stop on the remainder to
breakeven. After the breakeven move, the trade is visibly tagged "RISK-
FREE STATE" with a green banner. This is the single highest-leverage
psychological feature in the app.

(4) POSITION-SIZE CALCULATOR THAT REFUSES VIOLATIONS
Given equity, risk%-per-trade (default 1%, max 2%), entry, and stop:
max position size = (equity * risk%) / |entry - stop|. User cannot
enter a size larger than this. Show the formula and result to the user
visibly — don't hide the math.

(5) EOD RULE-COMPLIANCE SCORECARD
At market close (or first app open after close), block usage with a
5-question modal:
  - Did you follow your pre-trade journal protocol on every trade? Y/N
  - Did you honor every stop? Y/N
  - Did you skip any valid setups today? Y/N + count
  - Did you size every trade within your risk limit? Y/N
  - Did you take any revenge entries? Y/N
Score = % correct. Display a 30-day rolling compliance trend.
CRITICAL: this score is INDEPENDENT of P&L. Don't show it next to the
equity curve. Don't tie the visual treatment to gains/losses.

(6) SELF-TALK PROMPT ON RULE CONFLICT
Intercept these actions with a non-skippable modal:
  - Attempting to widen a stop after order placement
  - Attempting to size right at the risk limit (≥95% of max)
  - Attempting to submit a trade with a blank or under-20-char reason
Modal copy: "Your stated goal: consistent execution. Is this action
consistent with that goal? [Proceed anyway] [Cancel]"
Log every [Proceed anyway] click with timestamp and context. Surface
the log in a "review your overrides" screen.

WHAT NOT TO BUILD IN THE MVP
- No stock scanner (Tier 2 — defer)
- No fundamentals data (defer)
- No cooling-off timers (Tier 3 — defer)
- No correlation monitor (Tier 4 — defer)
- No charts beyond a basic price line for the symbol being traded
- No notifications, no email, no mobile, no broker integration

SOURCE CITATIONS (in code comments where relevant)
- Features 1, 2, 4: Schwager (1–2% risk, universal across all wizards) +
  Douglas Principle #2 (predefine the risk)
- Feature 3: Douglas — "risk-free opportunity"
- Feature 5: Douglas — Principle #6 (continuously monitor)
- Feature 6: Douglas — self-discipline as redirection technique

ACCEPTANCE
- A user cannot submit a trade without a stop. Period.
- A user cannot oversize. Period.
- After auto-scale-out fires, the trade is visibly in "risk-free state."
- EOD scorecard blocks normal app usage until filled, and the score is
  not displayed near the equity curve.
- Every override (proceed-anyway click) is logged with full context.

These six features take the app from "doesn't exist" to "better than what
retail traders have access to today." Ship this, dogfood it for 60 days,
then revisit whether you actually want Tier 2/3/4.
```

---

## Prompt 1 — Tier 1: Execution rails (the moat)

Build these first. Highest leverage, lowest cost. Without them, every other feature is decoration.

```
Build the Tier 1 execution-discipline core. Six features. All hard-enforced.

(1) PRE-TRADE JOURNAL
Submitting a new trade requires filling: entry price, stop price, target price,
R-multiple (auto-calculated as (target-entry)/(entry-stop) for long, inverse
for short), reason/setup (free text, min 20 chars). Form refuses submission
if any field is blank or R < 1.

(2) AUTO-STOP REQUIRED
No "naked" entries. Stop price is a required field. UI shows the dollar risk
and % of equity at risk in real time as the user types.

(3) POSITION-SIZE CALCULATOR
Inputs: user's total equity, risk%-per-trade (default 1%, user-configurable
max 2%), entry price, stop price. Compute: max position size = (equity *
risk%) / |entry - stop|. User cannot enter larger size. Show the
calculation visibly so user sees the math.

(4) AUTO-SCALE-OUT WITH BREAKEVEN
When a trade is filled, allow user to configure: "at +N R, auto-sell 1/3 of
position AND move stop on remainder to breakeven." Default: scale 1/3 at
+1R, stop to BE on remainder. After breakeven-move triggers, the UI must
visibly indicate the trade is in "risk-free state" (e.g., green banner).
This single feature is the highest-leverage psychological tool in the app.

(5) R-BASED P&L DISPLAY
All P&L shown as R-multiples by default ("+2.3R"). Dollars are secondary
text below. Closed-trade history table uses R as the primary column.

(6) FIRST-RUN SETUP WIZARD
Capture: total trading equity, max risk per trade %, max open positions,
average historical win % if known (used later for cardinal-sin check),
default scale-out plan. Persist to local storage.

SOURCE CITATIONS (add to code comments)
- 1–2% risk per trade: Schwager (universal — Kovner, Hite, Jones, etc.)
- Predefine risk on every trade: Douglas Principle #2
- Risk-free state via scale-out: Douglas (Trading in the Zone)
- R-multiples not dollars: Tharp via Schwager

ACCEPTANCE
- User cannot submit a trade without a stop.
- User cannot oversize a position beyond their risk%.
- After auto-scale-out fires, "risk-free state" is visually obvious.
- Position-size math is shown to the user, not hidden.
```

---

## Prompt 2 — Tier 2: Signal layer (Minervini)

Build the screener. Use Minervini's SEPA framework — it's the most encodable strategy framework of the three sources and ships with explicit numeric thresholds.

```
Build the Tier 2 signal/screening layer using Minervini's SEPA framework.
Assume daily OHLC + volume + quarterly EPS/sales/margin data is available
via the data source we agreed on in Prompt 0.

(1) TREND TEMPLATE SCANNER (daily-run)
A stock PASSES only if ALL 8 are true:
  1. Price > 150-day MA AND price > 200-day MA
  2. 150-day MA > 200-day MA
  3. 200-day MA trending up for ≥1 month
  4. 50-day MA > 150-day MA AND > 200-day MA
  5. Price > 50-day MA
  6. Price ≥30% above 52-week low
  7. Price within 25% of 52-week high
  8. Relative strength rank vs S&P 500 ≥70

Failing any one criterion filters the stock out. Output: ranked watchlist
with per-criterion pass/fail flags.

(2) STAGE CLASSIFIER
Tag every stock as Stage 1/2/3/4:
  - Stage 1: price oscillating around flat 200-day MA, low volume
  - Stage 2: Trend Template passing, higher highs + higher lows
  - Stage 3: 200-day MA flattening, largest down day since Stage 2 began
    on heavy volume
  - Stage 4: price below declining 200-day MA, lower highs + lower lows

Buy entries on non-Stage-2 stocks are WARNED (not blocked — discretion
allowed here).

(3) VCP DETECTOR (Volatility Contraction Pattern)
Flag setups where:
  - Stock in Stage 2
  - 2–6 successive price contractions, each ROUGHLY half the prior
    (e.g., 25% → 12% → 5% → 2%, allow 30% slop)
  - Volume drying up across contractions — most recent week's volume
    ≤50% of 50-day average
  - Each contraction includes at least one shakeout (undercut of prior low)
Output: footprint string `[weeks]W [first %]/[final %] [N]T`,
e.g., `40W 31/3 4T`. Show on the chart.
Pivot point = high of final contraction.
Buy trigger = price breaks above pivot on expanding volume (today's volume
≥1.5x 50-day avg).

(4) EARNINGS FILTER ("Code 33")
Flag stocks where EPS growth %, sales growth %, AND margin trend are ALL
accelerating across the last 3 quarters (YoY basis). This is Minervini's
rarest/strongest fundamental signal.

(5) CARDINAL-SIN ENFORCER
Track user's rolling average gain on closed winning trades. When user
attempts a trade where |entry - stop| > (avg_winning_gain / 2), WARN
prominently. Minervini's rule: never let a single loss exceed your
average win. With <10 closed wins, fall back to a 7% max stop.

SOURCE
Minervini, Trade Like a Stock Market Wizard (2013). All thresholds are
his explicit numbers — do not soften them.

ACCEPTANCE
- Scanner produces a daily watchlist, sortable by criteria-passed.
- VCP detector outputs footprint strings on the chart.
- Buy orders on non-Stage-2 stocks show warning.
- Buy orders violating the cardinal-sin rule show warning.
```

---

## Prompt 3 — Tier 3: Behavior monitoring (Douglas)

The features that turn the app from a tool into a coach.

```
Build the Tier 3 behavior-monitoring layer. Each maps to a Douglas concept
from Trading in the Zone (2000).

(1) COOLING-OFF AFTER STOP HIT
When a trade closes at a loss, lock new buy orders for 30 minutes (user-
configurable: same-symbol-only or all-symbols). Banner: "Cooling-off
active. Revenge trading is the most common cause of compounded losses.
Use this time to journal what you learned."

(2) COOLING-OFF AFTER BIG WIN
When a trade closes at +3R or larger (configurable), lock new orders for
30 min. Banner: "Euphoria is the inverse of fear. Large wins are the most
common precursor to oversized losing trades."

(3) EOD RULE-COMPLIANCE SCORECARD
At market close (or first open after close), prompt:
  - Did you follow your pre-trade journal protocol on every trade? Y/N
  - Did you honor every stop? Y/N
  - Did you skip any valid setups today? Y/N + count
  - Did you size every trade within your risk limit? Y/N
  - Did you take any revenge entries? Y/N
Compliance score = % correct. Display a 30-day rolling trend.
THIS SCORE IS INDEPENDENT OF P&L — that's the entire point. Don't tie
the score visualization to equity curve.

(4) SKIPPED-SIGNAL LOG
Every time the user views a valid scanner signal but does NOT enter,
prompt: "Skip this signal? Reason: [hesitation / different setup waiting
/ risk too high / other]." Log it. Weekly summary: "You skipped X valid
signals this week. Y of them would have hit your 1R target." This makes
fear-of-being-wrong visible.

(5) SELF-TALK PROMPT ON RULE CONFLICT
Intercept these actions with a non-skippable modal:
  - Widening a stop after order placement
  - Sizing right at the risk limit
  - Attempting to skip a journal entry
  - Skipping a signal during an active 20-trade mechanical sample (see Tier 4)
Modal copy: "Your stated goal: consistent execution. Is this action
consistent with that goal? [Proceed anyway] [Cancel]"
Log every [Proceed anyway] click for self-review.

SOURCE
Douglas, Trading in the Zone (2000) — the seven principles of consistency,
self-discipline as a redirection technique, the association mechanism.

ACCEPTANCE
- Cooling-off period is non-bypassable.
- EOD scorecard prompt blocks normal app usage until filled.
- Skipped-signal log is queryable as a 30-day report.
- Self-talk modal logs all "proceed anyway" clicks with timestamp + context.
```

---

## Prompt 4 — Tier 4: Coaching tools (offline analytics)

Run on user history, not real-time market data. Lower priority but high impact when used.

```
Build the Tier 4 offline coaching layer.

(1) LOSS-ADJUSTMENT SIMULATOR (marquee feature)
Take the user's actual closed-trade history. Re-run it with a hypothetical
max-loss cap (user-adjustable slider, 3% to 15%). Show the alternate
equity curve side-by-side with the real one. Highlight: total return
delta, max drawdown delta, # of trades affected.

Minervini's own results flipped from -12% to +80% on the same trade
history just from this discipline. The output of this screen should be
the most psychologically impactful visual in the entire app.

(2) 20-TRADE MECHANICAL SAMPLE TRACKER (Douglas's drill)
User defines: one ticker OR one setup type, one entry rule, one stop
rule, one scale-out plan. App tracks the next 20 occurrences.
Progress bar: "Trade 7 of 20 in active sample."
During an active sample:
  - User cannot deviate from defined rules without a confirmation modal
  - Skipping a signal RESETS the counter to 0 and logs the reason
  - Completing all 20 unlocks a "Mechanical Stage I" badge + a summary
    report (win rate, R-distribution, max drawdown, longest losing streak)
This is the only concrete protocol any of the three sources gives for
installing probabilistic thinking as a functional belief.

(3) EQUITY-CEILING ALERT
Detect pattern: equity repeatedly crosses threshold $X then drops by
≥15%. If pattern occurs ≥3 times within 18 months at roughly the same
equity level, surface a one-time alert:
"You've hit and given back ~$X repeatedly. This pattern usually
indicates unresolved self-worth beliefs about deserving the next
equity level. The fix isn't in this app — but seeing the pattern is
the first step." Link to Douglas's chapter on the "negative zone."

(4) FAILURE-RESET WATCHLIST
When a trade stops out, auto-add the ticker to a 30-day watchlist.
If the stock rebuilds a tight pivot within that window (VCP detector
flags it again), alert the user. Minervini's observation: second
setups after stop-outs are often higher-probability than first ones.

(5) CORRELATION + REGIME (power-user, optional)
Once user has ≥5 open positions, monitor pairwise correlation. Warn
if portfolio correlation >0.7 (Hite: "8 trades = 1 trade in disguise").
Regime tag for each day: bull/bear/chop, based on % of S&P 500 stocks
above 50-day MA + 200-day MA slope. Tier-2 buy signals can be
auto-suppressed during bear/chop regimes (user opt-in).

SOURCES
Minervini (loss-adjustment, failure-reset), Douglas (mechanical sample,
equity ceiling), Schwager/Hite (correlation), Minervini/Schwager (regime).

ACCEPTANCE
- Loss-adjustment simulator is reachable from main nav in ≤2 clicks.
- 20-trade tracker is the primary "skill development" loop in the app.
- Equity-ceiling alert fires at most monthly per threshold.
- Failure-reset watchlist auto-expires entries after 30 days.
```

---

## Notes on use

- Run prompts in order. Tier 1 is load-bearing; everything else is additive.
- If you ship only Tier 1, the app already outperforms most retail tools on the market.
- Don't let scope creep past Tier 4 without revisiting the strategies notes — anything beyond is probably feature bloat masquerading as a moat.
- When in doubt about a feature, cite the source rule. If no source rule applies, don't build the feature.
