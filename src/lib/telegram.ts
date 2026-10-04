/**
 * Sending a decision to Telegram.
 *
 * Until now every decision needed an SSH session and a hand-written SQLite query
 * to recover its token — five times in one day of dogfooding. This is the card
 * that replaces that, and it is the last piece of the original design: the agent
 * opens a pull request, the gates report, and a person approves from their phone.
 *
 * Two properties are deliberate. The token travels in the button rather than a
 * decision id, so the rule that only an unspent token can spend a decision holds
 * even here — a bot that could turn an id into an action would make the token
 * decorative. And every failure is swallowed: this is called from the gate
 * callback, and a Telegram outage must never fail a gate or lose a verdict that
 * was already computed and recorded.
 */

const TELEGRAM_API = "https://api.telegram.org";

/** Telegram rejects a sendMessage body over 4096 characters outright. */
const MAX_MESSAGE_CHARS = 4096;

/** callback_data is capped at 64 bytes; "agent:answer:" + a 32-char token is 45. */
const MAX_CALLBACK_BYTES = 64;

export interface DecisionCard {
  token: string;
  kind: "approve" | "question";
  /** The composed prompt: gate results, unmet criteria, the reviewer's concerns. */
  prompt: string;
  projectId: string;
  repo: string | null;
  prNumber: number | null;
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function config(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/**
 * The message body.
 *
 * Sent as plain text on purpose. The prompt carries code identifiers, file paths
 * and Hebrew from the acceptance review, and under MarkdownV2 a single unescaped
 * backtick or underscore in any of that makes Telegram reject the whole message
 * with a 400 — losing the notification to a formatting detail. Telegram links
 * bare URLs on its own, which is the only formatting this actually needs.
 */
export function buildCardText(card: DecisionCard): string {
  const header =
    card.kind === "question"
      ? `❓ The agent is asking about ${card.projectId}`
      : `🔵 Ready for your decision — ${card.projectId}`;

  const lines = [header, ""];
  if (card.repo && card.prNumber) {
    lines.push(`https://github.com/Ofirm84u/${card.repo}/pull/${card.prNumber}`, "");
  }
  lines.push(card.prompt);

  const text = lines.join("\n");
  if (text.length <= MAX_MESSAGE_CHARS) return text;

  // Trim the body rather than the header or the link: those are what make the
  // message actionable, and the detail is still on the pull request.
  const room = MAX_MESSAGE_CHARS - (text.length - card.prompt.length) - 20;
  return [
    ...lines.slice(0, -1),
    `${card.prompt.slice(0, Math.max(room, 0))}\n… truncated`,
  ].join("\n");
}

export function buildKeyboard(card: DecisionCard) {
  const data = (action: string) => `agent:${action}:${card.token}`;

  // A token long enough to overflow callback_data would silently produce buttons
  // Telegram refuses, so it is checked rather than assumed.
  for (const action of ["merge", "reject", "answer"]) {
    if (Buffer.byteLength(data(action)) > MAX_CALLBACK_BYTES) {
      return null;
    }
  }

  const buttons =
    card.kind === "question"
      ? [[{ text: "💬 Answer", callback_data: data("answer") }],
         [{ text: "🛑 Abandon this step", callback_data: data("reject") }]]
      : [[{ text: "✅ Merge", callback_data: data("merge") },
          { text: "❌ Reject", callback_data: data("reject") }]];

  return { inline_keyboard: buttons };
}

/**
 * Deliver the card. Never throws, and returns what happened so a caller can log
 * it without having to interpret an exception.
 */
export async function sendDecisionCard(
  card: DecisionCard,
): Promise<{ sent: boolean; reason?: string }> {
  const cfg = config();
  if (!cfg) return { sent: false, reason: "TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_ID is unset" };

  const reply_markup = buildKeyboard(card);
  if (!reply_markup) return { sent: false, reason: "callback_data would exceed 64 bytes" };

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: buildCardText(card),
        reply_markup,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { sent: false, reason: `Telegram returned ${response.status} ${detail.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "send failed" };
  }
}
