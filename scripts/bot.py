#!/usr/bin/env python3
"""
Telegram bot for MonitoringApp Articles.

Flow per message:
  1. Receive URL/text/file from the authorized Telegram user.
  2. Submit it to MonitoringApp's /api/articles for summarization + project suggestions.
  3. Reply with the summary + an inline keyboard (suggested projects, more projects, standalone).
  4. On selection, PATCH /api/articles/{id} to assign.
  5. If assigned to a real project, run /api/articles/{id}/gap-analysis and reply with the result.

Required env (.env or environment):
    TELEGRAM_BOT_TOKEN=...
    TELEGRAM_ALLOWED_USER_ID=...
    MONITOR_API_URL=https://mon.m84.me   # or http://localhost:3040 for local
    MONITOR_BOT_TOKEN=...                # must match BOT_API_TOKEN in MonitoringApp
"""

from __future__ import annotations

import base64
import logging
import os
import re
import subprocess
import sys
from functools import wraps
from pathlib import Path
from typing import Optional

# ── Bootstrap env ─────────────────────────────────────────────────────────────
# Load .env.production first (server), then .env (local) — setdefault keeps the
# earlier value if both exist.
for _env_filename in (".env.production", ".env"):
    _env_path = Path(__file__).parent.parent / _env_filename
    if _env_path.exists():
        for _line in _env_path.read_text().splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                os.environ.setdefault(_key.strip(), _val.strip())


def _ensure(*packages: str) -> None:
    import importlib

    for pkg in packages:
        module = pkg.split(">=")[0].replace("-", "_")
        try:
            importlib.import_module(module)
        except ImportError:
            subprocess.check_call([sys.executable, "-m", "pip", "install", pkg])


_ensure("python-telegram-bot>=20.0", "requests")

import requests
from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Update,
)
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ── Config ────────────────────────────────────────────────────────────────────
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
if not TOKEN:
    sys.exit("TELEGRAM_BOT_TOKEN is not set.")

_raw_allowed = os.environ.get("TELEGRAM_ALLOWED_USER_ID", "").strip()
ALLOWED_USER_ID: Optional[int] = int(_raw_allowed) if _raw_allowed.isdigit() else None

API_URL = os.environ.get("MONITOR_API_URL", "http://localhost:3040").rstrip("/")
BOT_TOKEN_HEADER = os.environ.get("MONITOR_BOT_TOKEN", "")
if not BOT_TOKEN_HEADER:
    sys.exit("MONITOR_BOT_TOKEN is not set.")

REQUEST_TIMEOUT = 90  # seconds — Claude calls can be slow
MAX_DOC_BYTES = 20 * 1024 * 1024

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s", level=logging.INFO
)
log = logging.getLogger(__name__)

if not ALLOWED_USER_ID:
    log.warning("TELEGRAM_ALLOWED_USER_ID not set — bot is open!")

_URL_RE = re.compile(r"https?://[^\s]+")


# ── Auth guard ────────────────────────────────────────────────────────────────


def authorized_only(handler):
    @wraps(handler)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id if update.effective_user else None
        if ALLOWED_USER_ID and user_id != ALLOWED_USER_ID:
            log.warning("Blocked unauthorized access from user_id=%s", user_id)
            return
        return await handler(update, context)

    return wrapper


# ── MonitoringApp API helpers ─────────────────────────────────────────────────


def _api_headers() -> dict:
    return {"X-Bot-Token": BOT_TOKEN_HEADER, "Content-Type": "application/json"}


def api_submit_url(url: str) -> dict:
    resp = requests.post(
        f"{API_URL}/api/articles",
        headers=_api_headers(),
        json={"kind": "url", "url": url},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["article"]


def api_submit_text(text: str) -> dict:
    resp = requests.post(
        f"{API_URL}/api/articles",
        headers=_api_headers(),
        json={"kind": "text", "text": text},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["article"]


def api_submit_pdf(buf: bytes, filename: str) -> dict:
    b64 = base64.b64encode(buf).decode("ascii")
    resp = requests.post(
        f"{API_URL}/api/articles",
        headers=_api_headers(),
        json={"kind": "pdf", "pdfBase64": b64, "filename": filename},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["article"]


def api_assign(article_id: str, kind: str, project_id: Optional[str]) -> dict:
    resp = requests.patch(
        f"{API_URL}/api/articles/{article_id}",
        headers=_api_headers(),
        json={"assignment": {"kind": kind, "projectId": project_id}},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["article"]


def api_gap_analysis(article_id: str) -> dict:
    resp = requests.post(
        f"{API_URL}/api/articles/{article_id}/gap-analysis",
        headers=_api_headers(),
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["article"]


_projects_cache: list[dict] = []


def api_list_projects() -> list[dict]:
    global _projects_cache
    if _projects_cache:
        return _projects_cache
    resp = requests.get(
        f"{API_URL}/api/projects/list",
        headers={"X-Bot-Token": BOT_TOKEN_HEADER},
        timeout=20,
    )
    resp.raise_for_status()
    _projects_cache = resp.json().get("projects", [])
    return _projects_cache


def api_create_task(text: str, project_id: Optional[str] = None) -> dict:
    payload: dict = {"text": text}
    if project_id:
        payload["projectId"] = project_id
    resp = requests.post(
        f"{API_URL}/api/tasks",
        headers=_api_headers(),
        json=payload,
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()["task"]


def api_list_tasks() -> list[dict]:
    resp = requests.get(
        f"{API_URL}/api/tasks",
        headers=_api_headers(),
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json().get("tasks", [])


def api_update_task(task_id: str, **kwargs) -> dict:
    resp = requests.patch(
        f"{API_URL}/api/tasks/{task_id}",
        headers=_api_headers(),
        json=kwargs,
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()["task"]


# ── Formatting ────────────────────────────────────────────────────────────────


async def _send_long(update_or_query, text: str) -> None:
    chunk = 4000
    target = (
        update_or_query.message
        if hasattr(update_or_query, "message")
        else update_or_query
    )
    for i in range(0, len(text), chunk):
        await target.reply_text(text[i : i + chunk])


def _summary_text(article: dict) -> str:
    title = article.get("title", "(untitled)")
    summary = article.get("summary") or {}
    tldr = summary.get("tldr") or ""
    ideas = summary.get("keyIdeas") or []
    tags = article.get("tags") or []

    parts = [f"📰 *{title}*"]
    if tldr:
        parts.append(f"\n*TL;DR:* {tldr}")
    if ideas:
        bullets = "\n".join(f"• {idea}" for idea in ideas)
        parts.append(f"\n*Key ideas:*\n{bullets}")
    if tags:
        parts.append("\n" + " ".join(f"#{t}" for t in tags))
    return "\n".join(parts)


def _build_assignment_keyboard(article: dict, page: int = 0) -> InlineKeyboardMarkup:
    suggestions = article.get("suggestions") or []
    article_id = article["id"]

    rows: list[list[InlineKeyboardButton]] = []
    # AI-suggested projects (top 3) as primary buttons
    for s in suggestions[:3]:
        rows.append([
            InlineKeyboardButton(
                f"🎯 {s['projectName']} ({s['relevance']})",
                callback_data=f"assign:{article_id}:{s['projectId']}",
            )
        ])

    # Other projects page
    rows.append([
        InlineKeyboardButton(
            "🔽 Other project...",
            callback_data=f"other:{article_id}:0",
        )
    ])
    # Standalone
    rows.append([
        InlineKeyboardButton(
            "💡 Standalone idea (no project)",
            callback_data=f"assign:{article_id}:__standalone__",
        )
    ])
    return InlineKeyboardMarkup(rows)


def _build_other_projects_keyboard(
    article_id: str, suggested_ids: set[str], page: int
) -> InlineKeyboardMarkup:
    projects = api_list_projects()
    others = [p for p in projects if p["id"] not in suggested_ids]
    others.sort(key=lambda p: p["name"].lower())

    page_size = 6
    start = page * page_size
    end = start + page_size
    page_items = others[start:end]

    rows: list[list[InlineKeyboardButton]] = []
    for p in page_items:
        rows.append([
            InlineKeyboardButton(
                p["name"],
                callback_data=f"assign:{article_id}:{p['id']}",
            )
        ])

    nav_row: list[InlineKeyboardButton] = []
    if start > 0:
        nav_row.append(
            InlineKeyboardButton(
                "← Prev", callback_data=f"other:{article_id}:{page - 1}"
            )
        )
    if end < len(others):
        nav_row.append(
            InlineKeyboardButton(
                "Next →", callback_data=f"other:{article_id}:{page + 1}"
            )
        )
    if nav_row:
        rows.append(nav_row)
    rows.append([
        InlineKeyboardButton(
            "↩ Back",
            callback_data=f"back:{article_id}",
        )
    ])
    return InlineKeyboardMarkup(rows)


# ── Handlers ──────────────────────────────────────────────────────────────────


async def cmd_whoami(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id if update.effective_user else "unknown"
    if ALLOWED_USER_ID and user_id != ALLOWED_USER_ID:
        return
    status = (
        "Bot is locked to your account ✅"
        if ALLOWED_USER_ID
        else f"⚠️ Add to .env.production: TELEGRAM_ALLOWED_USER_ID={user_id}"
    )
    await update.message.reply_text(
        f"Your Telegram User ID: {user_id}\n\n{status}"
    )


@authorized_only
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Send me a URL, paste an article, or upload a PDF.\n"
        "I'll summarize it and suggest which of your projects it's relevant to."
    )


@authorized_only
async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    raw = (msg.text or "").strip()
    if not raw:
        return

    url_match = _URL_RE.search(raw)
    await msg.reply_text("📥 Processing...")

    try:
        if url_match:
            article = api_submit_url(url_match.group(0).rstrip(")"))
        else:
            if len(raw) < 50:
                await msg.reply_text("Text is too short to summarize (min 50 chars).")
                return
            article = api_submit_text(raw)
    except requests.HTTPError as exc:
        try:
            err = exc.response.json().get("error", str(exc))
        except Exception:
            err = str(exc)
        await msg.reply_text(f"❌ {err}")
        return
    except Exception as exc:
        await msg.reply_text(f"❌ {exc}")
        return

    await _send_long(update, _summary_text(article))
    await msg.reply_text(
        "Which project is this relevant to?",
        reply_markup=_build_assignment_keyboard(article),
    )
    # Cache for callback (we only need the id + suggested_ids; refetched on assign)
    context.bot_data.setdefault("articles", {})[article["id"]] = {
        "suggested_ids": [s["projectId"] for s in article.get("suggestions", [])],
    }


@authorized_only
async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    doc = update.message.document
    if not doc.file_name.lower().endswith(".pdf"):
        await update.message.reply_text("Only PDF files are supported via document upload.")
        return
    if doc.file_size and doc.file_size > MAX_DOC_BYTES:
        await update.message.reply_text("File too large (max 20MB).")
        return

    await update.message.reply_text("📥 Processing PDF...")
    try:
        tg_file = await doc.get_file()
        buf = bytes(await tg_file.download_as_bytearray())
        article = api_submit_pdf(buf, doc.file_name)
    except requests.HTTPError as exc:
        try:
            err = exc.response.json().get("error", str(exc))
        except Exception:
            err = str(exc)
        await update.message.reply_text(f"❌ {err}")
        return
    except Exception as exc:
        await update.message.reply_text(f"❌ {exc}")
        return

    await _send_long(update, _summary_text(article))
    await update.message.reply_text(
        "Which project is this relevant to?",
        reply_markup=_build_assignment_keyboard(article),
    )
    context.bot_data.setdefault("articles", {})[article["id"]] = {
        "suggested_ids": [s["projectId"] for s in article.get("suggestions", [])],
    }


@authorized_only
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.data:
        return
    await query.answer()

    parts = query.data.split(":")
    if len(parts) < 2:
        return
    action = parts[0]

    if action == "assign" and len(parts) == 3:
        article_id, target = parts[1], parts[2]
        try:
            if target == "__standalone__":
                article = api_assign(article_id, "standalone", None)
                await query.edit_message_text(
                    "✅ Marked as a standalone idea (no project linkage)."
                )
            else:
                article = api_assign(article_id, "project", target)
                project_name = next(
                    (
                        p["name"]
                        for p in api_list_projects()
                        if p["id"] == target
                    ),
                    target,
                )
                await query.edit_message_text(
                    f"✅ Assigned to *{project_name}*\n\n🔍 Running gap analysis...",
                    parse_mode="Markdown",
                )
                # Run gap analysis
                try:
                    article = api_gap_analysis(article_id)
                    gap = (article.get("gapAnalysis") or {}).get("text") or ""
                    if gap:
                        await _send_long(
                            query.message,
                            f"🔍 *Gap analysis — {project_name}*\n\n{gap}",
                        )
                except Exception as gap_exc:
                    await query.message.reply_text(
                        f"⚠️ Gap analysis failed: {gap_exc}"
                    )
        except requests.HTTPError as exc:
            try:
                err = exc.response.json().get("error", str(exc))
            except Exception:
                err = str(exc)
            await query.message.reply_text(f"❌ {err}")
        except Exception as exc:
            await query.message.reply_text(f"❌ {exc}")
        return

    if action == "other" and len(parts) == 3:
        article_id, page_str = parts[1], parts[2]
        try:
            page = int(page_str)
        except ValueError:
            page = 0
        cached = context.bot_data.get("articles", {}).get(article_id) or {}
        suggested_ids = set(cached.get("suggested_ids", []))
        await query.edit_message_reply_markup(
            reply_markup=_build_other_projects_keyboard(
                article_id, suggested_ids, page
            )
        )
        return

    if action == "task_project" and len(parts) == 3:
        task_id, project_id = parts[1], parts[2]
        try:
            if project_id == "__none__":
                api_update_task(task_id, projectId=None)
                await query.edit_message_text("✅ Task saved with no project.")
            else:
                api_update_task(task_id, projectId=project_id)
                project_name = next(
                    (p["name"] for p in api_list_projects() if p["id"] == project_id),
                    project_id,
                )
                await query.edit_message_text(f"✅ Task assigned to *{project_name}*", parse_mode="Markdown")
        except Exception as exc:
            await query.message.reply_text(f"❌ {exc}")
        return

    if action == "back" and len(parts) == 2:
        article_id = parts[1]
        # Reconstruct keyboard from cache only (suggestions list is small; reconstructed minimal)
        cached = context.bot_data.get("articles", {}).get(article_id) or {}
        suggested_ids = cached.get("suggested_ids", [])
        # We don't have the full suggestion objects cached; recreate keyboard with just
        # standalone + other + a minimal "suggested" hint. For simplicity, fall back to other-list page 0.
        rows: list[list[InlineKeyboardButton]] = []
        for sid in suggested_ids[:3]:
            project_name = next(
                (p["name"] for p in api_list_projects() if p["id"] == sid),
                sid,
            )
            rows.append([
                InlineKeyboardButton(
                    f"🎯 {project_name}",
                    callback_data=f"assign:{article_id}:{sid}",
                )
            ])
        rows.append([
            InlineKeyboardButton(
                "🔽 Other project...",
                callback_data=f"other:{article_id}:0",
            )
        ])
        rows.append([
            InlineKeyboardButton(
                "💡 Standalone idea (no project)",
                callback_data=f"assign:{article_id}:__standalone__",
            )
        ])
        await query.edit_message_reply_markup(
            reply_markup=InlineKeyboardMarkup(rows)
        )
        return


# ── Task helpers ──────────────────────────────────────────────────────────────


def _build_project_keyboard(task_id: str) -> InlineKeyboardMarkup:
    projects = api_list_projects()
    projects_sorted = sorted(projects, key=lambda p: p["name"].lower())
    rows: list[list[InlineKeyboardButton]] = []
    for p in projects_sorted:
        rows.append([
            InlineKeyboardButton(
                p["name"],
                callback_data=f"task_project:{task_id}:{p['id']}",
            )
        ])
    rows.append([
        InlineKeyboardButton(
            "🚫 No project",
            callback_data=f"task_project:{task_id}:__none__",
        )
    ])
    return InlineKeyboardMarkup(rows)


def _format_tasks(tasks: list[dict]) -> str:
    open_tasks = [t for t in tasks if not t["done"]]
    if not open_tasks:
        return "✅ No open tasks!"

    # Group by project
    projects = {p["id"]: p["name"] for p in api_list_projects()}
    grouped: dict[str, list[tuple[int, dict]]] = {}
    for i, task in enumerate(open_tasks, 1):
        pid = task.get("projectId") or "__none__"
        grouped.setdefault(pid, []).append((i, task))

    lines: list[str] = ["📋 *Open tasks:*\n"]
    for pid, items in grouped.items():
        label = projects.get(pid, "No project") if pid != "__none__" else "No project"
        lines.append(f"*{label}*")
        for num, task in items:
            lines.append(f"  {num}. {task['text']}")
        lines.append("")
    return "\n".join(lines).strip()


# ── Task command handlers ──────────────────────────────────────────────────────


@authorized_only
async def cmd_task(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = " ".join(context.args or []).strip()
    if not text:
        await update.message.reply_text(
            "Usage: /task <description>\nExample: /task Write landing page copy"
        )
        return

    try:
        task = api_create_task(text)
    except Exception as exc:
        await update.message.reply_text(f"❌ {exc}")
        return

    await update.message.reply_text(
        f"✅ Task saved!\n\n*{text}*\n\nWhich project is this for?",
        parse_mode="Markdown",
        reply_markup=_build_project_keyboard(task["id"]),
    )


@authorized_only
async def cmd_tasks(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        tasks = api_list_tasks()
    except Exception as exc:
        await update.message.reply_text(f"❌ {exc}")
        return

    await update.message.reply_text(_format_tasks(tasks), parse_mode="Markdown")


@authorized_only
async def cmd_done(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text(
            "Usage: /done <number>\nUse /tasks to see task numbers."
        )
        return

    try:
        num = int(context.args[0])
    except ValueError:
        await update.message.reply_text("Please provide a valid task number.")
        return

    try:
        tasks = api_list_tasks()
        open_tasks = [t for t in tasks if not t["done"]]
        if num < 1 or num > len(open_tasks):
            await update.message.reply_text(
                f"No task #{num}. Use /tasks to see available tasks."
            )
            return
        task = open_tasks[num - 1]
        api_update_task(task["id"], done=True)
        await update.message.reply_text(f"✅ Done: _{task['text']}_", parse_mode="Markdown")
    except Exception as exc:
        await update.message.reply_text(f"❌ {exc}")


# ── Entry point ───────────────────────────────────────────────────────────────


async def post_init(app: Application) -> None:
    await app.bot.set_my_commands([
        BotCommand("start", "Introduction & help"),
        BotCommand("task", "Add a new task: /task <description>"),
        BotCommand("tasks", "Show open tasks"),
        BotCommand("done", "Mark task complete: /done <number>"),
        BotCommand("whoami", "Show your Telegram user ID"),
    ])
    log.info("Bot commands registered with Telegram")


def main() -> None:
    app = Application.builder().token(TOKEN).post_init(post_init).build()
    app.add_handler(CommandHandler("whoami", cmd_whoami))
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("task", cmd_task))
    app.add_handler(CommandHandler("tasks", cmd_tasks))
    app.add_handler(CommandHandler("done", cmd_done))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(CallbackQueryHandler(handle_callback))

    log.info("Articles bot running | API: %s", API_URL)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
