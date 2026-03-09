#!/usr/bin/env python3
"""
Paperclip <-> Telegram Bridge Service

Двусторонний мост между Paperclip бордом и Telegram:
1. Paperclip -> TG: уведомления о checkout и done задач
2. TG -> Paperclip: сообщения от борда создают задачи/комментарии
"""

import asyncio
import json
import logging
import os
import re
import sys
from datetime import datetime

import aiohttp
import websockets
from telegram import Update, Bot
from telegram.ext import Application, MessageHandler, CommandHandler, filters

# --- Конфигурация ---

BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "7691334084:AAFU6P9TqXjaKXj-qBFl3WxNIMRY2v3RGco")
CHAT_ID = int(os.environ.get("TG_CHAT_ID", "277524018"))
PAPERCLIP_URL = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100")
PAPERCLIP_API_KEY = os.environ.get("PAPERCLIP_API_KEY", "pcp_16aff04038c9a0133dec7e6daa82017ebb2043d0fc3cf772")
COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "e8fa12a8-1aec-4e99-b8c4-d4e5920750ce")
BOARD_USER_ID = os.environ.get("PAPERCLIP_BOARD_USER_ID", "05d3J5EHZO6khns4EFv2bNw6IO2Hx52W")
CEO_AGENT_ID = os.environ.get("CEO_AGENT_ID", "4113e624-5c65-47d2-8140-87c777ccf67e")
COMPANY_PREFIX = os.environ.get("COMPANY_PREFIX", "CMP")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("tg-bridge")

# Маппинг: tg_message_id -> issue_id (для reply контекста)
msg_to_issue: dict[int, str] = {}
# Маппинг: issue_id -> tg_message_id (для ответов на уведомления)
issue_to_msg: dict[str, int] = {}

# Кеш агентов: agent_id -> name
agent_cache: dict[str, str] = {}

# --- Paperclip API helpers ---

def api_headers():
    return {
        "Authorization": f"Bearer {PAPERCLIP_API_KEY}",
        "Content-Type": "application/json",
    }


async def api_get(session: aiohttp.ClientSession, path: str):
    async with session.get(f"{PAPERCLIP_URL}{path}", headers=api_headers()) as resp:
        if resp.status == 200:
            return await resp.json()
        log.warning("API GET %s -> %d", path, resp.status)
        return None


async def api_post(session: aiohttp.ClientSession, path: str, data: dict):
    async with session.post(f"{PAPERCLIP_URL}{path}", headers=api_headers(), json=data) as resp:
        if resp.status in (200, 201):
            return await resp.json()
        text = await resp.text()
        log.warning("API POST %s -> %d: %s", path, resp.status, text[:200])
        return None


async def api_patch(session: aiohttp.ClientSession, path: str, data: dict):
    async with session.patch(f"{PAPERCLIP_URL}{path}", headers=api_headers(), json=data) as resp:
        if resp.status == 200:
            return await resp.json()
        text = await resp.text()
        log.warning("API PATCH %s -> %d: %s", path, resp.status, text[:200])
        return None


async def get_agent_name(session: aiohttp.ClientSession, agent_id: str) -> str:
    if agent_id in agent_cache:
        return agent_cache[agent_id]
    data = await api_get(session, f"/api/agents/{agent_id}")
    if data:
        name = data.get("name", agent_id[:8])
        agent_cache[agent_id] = name
        return name
    return agent_id[:8]


async def get_issue(session: aiohttp.ClientSession, issue_id: str) -> dict | None:
    return await api_get(session, f"/api/issues/{issue_id}")


# --- Telegram отправка ---

async def send_tg(bot: Bot, text: str, reply_to: int | None = None) -> int | None:
    """Отправить сообщение в TG, вернуть message_id последнего сообщения.

    Если текст > 4096 символов — разбивает на части и отправляет последовательно.
    reply_to применяется только к первому сообщению.
    """
    parts = split_message(text)
    last_msg_id = None

    try:
        for i, part in enumerate(parts):
            msg = await bot.send_message(
                chat_id=CHAT_ID,
                text=part,
                parse_mode="HTML",
                reply_to_message_id=reply_to if i == 0 else None,
            )
            last_msg_id = msg.message_id
        return last_msg_id
    except Exception as e:
        log.error("Ошибка отправки в TG: %s", e)
        return last_msg_id


# --- Обработка событий Paperclip ---

async def handle_activity_event(bot: Bot, session: aiohttp.ClientSession, payload: dict):
    """Обработка activity.logged событий."""
    action = payload.get("action", "")
    entity_type = payload.get("entityType", "")
    entity_id = payload.get("entityId", "")
    agent_id = payload.get("agentId")
    details = payload.get("details", {})

    if entity_type != "issue":
        return

    # Checkout (issue.updated со сменой статуса на in_progress через checkout)
    if action == "issue.updated" and details.get("changes", {}).get("status") == "in_progress":
        issue = await get_issue(session, entity_id)
        if not issue:
            return

        agent_name = "Система"
        if agent_id:
            agent_name = await get_agent_name(session, agent_id)

        identifier = issue.get("identifier", "")
        title = issue.get("title", "Без названия")
        desc = (issue.get("description") or "")[:200]
        if len(desc) == 200:
            desc += "..."

        text = (
            f"<b>🚀 Задача взята в работу</b>\n\n"
            f"<b>{identifier}</b>: {_escape(title)}\n"
            f"<b>Исполнитель:</b> {_escape(agent_name)}\n"
        )
        if desc:
            text += f"\n<i>{_escape(desc)}</i>"

        msg_id = await send_tg(bot, text)
        if msg_id:
            msg_to_issue[msg_id] = entity_id
            issue_to_msg[entity_id] = msg_id
            log.info("Отправлено уведомление о старте %s", identifier)

    # Завершение задачи (status → done)
    elif action == "issue.updated" and details.get("changes", {}).get("status") == "done":
        issue = await get_issue(session, entity_id)
        if not issue:
            return

        agent_name = "Система"
        if agent_id:
            agent_name = await get_agent_name(session, agent_id)

        identifier = issue.get("identifier", "")
        title = issue.get("title", "Без названия")

        # Получить последний комментарий как summary
        comments = await api_get(session, f"/api/issues/{entity_id}/comments")
        summary = ""
        if comments and len(comments) > 0:
            last_comment = comments[-1]
            summary = last_comment.get("body", "")

        reply_to = issue_to_msg.get(entity_id)

        text = (
            f"<b>✅ Задача завершена</b>\n\n"
            f"<b>{identifier}</b>: {_escape(title)}\n"
            f"<b>Выполнил:</b> {_escape(agent_name)}\n"
        )
        if summary:
            text += f"\n<b>Итог:</b>\n{markdown_to_tg_html(summary)}"

        msg_id = await send_tg(bot, text, reply_to=reply_to)
        if msg_id:
            msg_to_issue[msg_id] = entity_id
            issue_to_msg[entity_id] = msg_id
            log.info("Отправлено уведомление о завершении %s", identifier)

    # Комментарий агента к задаче — отправить в TG
    elif action == "issue.comment_added":
        # Не дублировать комментарии от борда (пришедшие из TG — начинаются с [Telegram])
        body_snippet = details.get("bodySnippet", "")
        if body_snippet.startswith("[Telegram]"):
            return

        identifier = details.get("identifier", "")
        issue_title = details.get("issueTitle", "")
        comment_id = details.get("commentId", "")

        # Загрузить полный текст комментария
        comment_body = body_snippet
        if comment_id:
            comment_data = await api_get(session, f"/api/issues/{entity_id}/comments/{comment_id}")
            if comment_data:
                full_body = comment_data.get("body", "")
                if full_body:
                    comment_body = full_body

        agent_name = "Система"
        if agent_id:
            agent_name = await get_agent_name(session, agent_id)

        reply_to = issue_to_msg.get(entity_id)

        text = (
            f"<b>💬 Комментарий</b>\n\n"
            f"<b>{identifier}</b>: {_escape(issue_title)}\n"
            f"<b>От:</b> {_escape(agent_name)}\n\n"
            f"{markdown_to_tg_html(comment_body)}"
        )

        msg_id = await send_tg(bot, text, reply_to=reply_to)
        if msg_id:
            msg_to_issue[msg_id] = entity_id
            if entity_id not in issue_to_msg:
                issue_to_msg[entity_id] = msg_id
            log.info("Отправлен комментарий агента %s к %s", agent_name, identifier)

    # Создание новой задачи
    elif action == "issue.created":
        issue = await get_issue(session, entity_id)
        if not issue:
            return

        # Не уведомлять о подзадачах, которые создал агент (шум)
        if issue.get("createdByAgentId") and issue.get("parentId"):
            return

        identifier = issue.get("identifier", "")
        title = issue.get("title", "Без названия")
        priority = issue.get("priority", "medium")

        assignee = "Не назначен"
        if issue.get("assigneeAgentId"):
            assignee = await get_agent_name(session, issue["assigneeAgentId"])

        priority_emoji = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢"}.get(priority, "⚪")

        text = (
            f"<b>📋 Новая задача</b>\n\n"
            f"<b>{identifier}</b>: {_escape(title)}\n"
            f"<b>Приоритет:</b> {priority_emoji} {priority}\n"
            f"<b>Назначена:</b> {_escape(assignee)}\n"
        )

        msg_id = await send_tg(bot, text)
        if msg_id:
            msg_to_issue[msg_id] = entity_id
            issue_to_msg[entity_id] = msg_id
            log.info("Отправлено уведомление о создании %s", identifier)


def _escape(text: str) -> str:
    """Экранирование HTML для Telegram."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def markdown_to_tg_html(text: str) -> str:
    """Конвертация Markdown в Telegram HTML.

    Поддерживает: заголовки, bold, italic, ссылки, code, code blocks, списки.
    Защищает содержимое code-тегов от дальнейшей обработки.
    """
    # Сначала экранируем HTML-символы в исходном тексте
    text = _escape(text)

    # Извлекаем code blocks и inline code в placeholders
    # чтобы * и _ внутри них не обрабатывались как bold/italic
    code_placeholders: list[str] = []

    def save_code(match: re.Match) -> str:
        idx = len(code_placeholders)
        code_placeholders.append(match.group(0))
        return f"\x00CODE{idx}\x00"

    # Code blocks (``` ... ```)
    text = re.sub(
        r"```(?:\w+)?\n(.*?)```",
        lambda m: save_code(type(m)(r"<pre>" + m.group(1) + "</pre>", m)),
        text,
        flags=re.DOTALL,
    )
    # Inline code (` ... `)
    text = re.sub(r"`([^`]+)`", lambda m: save_code(type('M', (), {'group': lambda s, i=0: f"<code>{m.group(1)}</code>"})()) if False else None, text)

    # Проще: извлекаем code blocks и inline code напрямую
    code_placeholders.clear()
    # Перезапуск с чистого текста
    text = _escape(text)

    # 1. Code blocks → placeholder
    def replace_codeblock(m):
        idx = len(code_placeholders)
        code_placeholders.append(f"<pre>{m.group(1)}</pre>")
        return f"\x00CODE{idx}\x00"

    text = re.sub(r"```(?:\w+)?\n(.*?)```", replace_codeblock, text, flags=re.DOTALL)

    # 2. Inline code → placeholder
    def replace_inline_code(m):
        idx = len(code_placeholders)
        code_placeholders.append(f"<code>{m.group(1)}</code>")
        return f"\x00CODE{idx}\x00"

    text = re.sub(r"`([^`]+)`", replace_inline_code, text)

    # 3. Списки (- item, * item) — ДО bold/italic, чтобы * в начале строки не стал italic
    text = re.sub(r"^[\-\*]\s+", "• ", text, flags=re.MULTILINE)

    # 4. Заголовки
    text = re.sub(r"^#{1,6}\s+(.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)

    # 5. Ссылки [text](url)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)

    # 6. Bold (**text** или __text__)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"__(.+?)__", r"<b>\1</b>", text)

    # 7. Italic (*text* или _text_)
    text = re.sub(r"(?<!\w)\*([^*]+?)\*(?!\w)", r"<i>\1</i>", text)
    text = re.sub(r"(?<!\w)_([^_]+?)_(?!\w)", r"<i>\1</i>", text)

    # 8. Восстанавливаем code из placeholders
    for idx, code_html in enumerate(code_placeholders):
        text = text.replace(f"\x00CODE{idx}\x00", code_html)

    return text


def split_message(text: str, max_len: int = 4096) -> list[str]:
    """Разбивка длинного сообщения на части <= max_len символов.

    Приоритет разбивки:
    1. Двойной перенос строки (параграфы)
    2. Одинарный перенос строки
    3. Пробел
    """
    if len(text) <= max_len:
        return [text]

    parts = []
    remaining = text

    while len(remaining) > max_len:
        chunk = remaining[:max_len]

        # Ищем лучшую точку разрыва (с конца chunk)
        split_pos = -1

        # Приоритет 1: двойной перенос
        pos = chunk.rfind("\n\n")
        if pos > 0:
            split_pos = pos

        # Приоритет 2: одинарный перенос
        if split_pos == -1:
            pos = chunk.rfind("\n")
            if pos > 0:
                split_pos = pos

        # Приоритет 3: пробел
        if split_pos == -1:
            pos = chunk.rfind(" ")
            if pos > 0:
                split_pos = pos

        # Крайний случай: режем ровно по max_len
        if split_pos == -1:
            split_pos = max_len

        parts.append(remaining[:split_pos].rstrip())
        remaining = remaining[split_pos:].lstrip()

    if remaining:
        parts.append(remaining)

    return parts


# --- Обработка входящих TG сообщений ---

async def handle_tg_message(update: Update, context):
    """Обработка сообщений от борда в TG."""
    msg = update.message
    if not msg or not msg.text:
        return

    # Проверка что от нужного чата
    if msg.chat_id != CHAT_ID:
        return

    text = msg.text.strip()
    if not text:
        return

    async with aiohttp.ClientSession() as session:
        # Если reply на сообщение бота — добавить комментарий к задаче
        if msg.reply_to_message and msg.reply_to_message.message_id in msg_to_issue:
            issue_id = msg_to_issue[msg.reply_to_message.message_id]
            issue = await get_issue(session, issue_id)
            if not issue:
                await msg.reply_text("Задача не найдена в Paperclip.")
                return

            identifier = issue.get("identifier", "")

            result = await api_post(session, f"/api/issues/{issue_id}/comments", {
                "body": f"[Telegram] @CEO {text}",
                "authorUserId": BOARD_USER_ID,
            })

            if result:
                await msg.reply_text(f"💬 Комментарий добавлен к {identifier}")
                log.info("Добавлен комментарий к %s от борда", identifier)
            else:
                await msg.reply_text("Ошибка при добавлении комментария.")
            return

        # Новое сообщение без reply — создать задачу и назначить CEO
        result = await api_post(session, f"/api/companies/{COMPANY_ID}/issues", {
            "title": text[:120],
            "description": text if len(text) > 120 else None,
            "priority": "medium",
            "createdByUserId": BOARD_USER_ID,
            "assigneeAgentId": CEO_AGENT_ID,
        })

        if result:
            identifier = result.get("identifier", "")
            issue_id = result.get("id", "")
            reply = await msg.reply_text(f"📋 Создана задача {identifier}")
            if reply:
                msg_to_issue[reply.message_id] = issue_id
                issue_to_msg[issue_id] = reply.message_id
            log.info("Создана задача %s из TG", identifier)
        else:
            await msg.reply_text("Ошибка при создании задачи.")


async def handle_start(update: Update, context):
    """Команда /start."""
    await update.message.reply_text(
        "Paperclip Bridge Bot\n\n"
        "Отправьте сообщение — создам задачу.\n"
        "Ответьте на уведомление — добавлю комментарий к задаче."
    )


# --- WebSocket слушатель ---

async def ws_listener(bot: Bot):
    """Подключение к Paperclip WebSocket и обработка событий."""
    ws_url = f"ws{'s' if PAPERCLIP_URL.startswith('https') else ''}://{PAPERCLIP_URL.split('://', 1)[1]}/api/companies/{COMPANY_ID}/events/ws?token={PAPERCLIP_API_KEY}"

    while True:
        try:
            log.info("Подключение к Paperclip WebSocket...")
            async with websockets.connect(ws_url, ping_interval=30, ping_timeout=10) as ws:
                log.info("WebSocket подключен")
                async for raw in ws:
                    try:
                        event = json.loads(raw)
                        event_type = event.get("type", "")
                        payload = event.get("payload", {})

                        async with aiohttp.ClientSession() as session:
                            if event_type == "activity.logged":
                                await handle_activity_event(bot, session, payload)
                    except json.JSONDecodeError:
                        log.warning("Невалидный JSON из WebSocket: %s", raw[:100])
                    except Exception as e:
                        log.error("Ошибка обработки события: %s", e, exc_info=True)

        except websockets.exceptions.ConnectionClosed as e:
            log.warning("WebSocket отключен: %s. Переподключение через 5с...", e)
        except Exception as e:
            log.error("Ошибка WebSocket: %s. Переподключение через 5с...", e)

        await asyncio.sleep(5)


# --- Main ---

async def main():
    log.info("Запуск Telegram Bridge Service")
    log.info("Chat ID: %s, Company: %s", CHAT_ID, COMPANY_ID)

    # Создать бот и application
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", handle_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_tg_message))

    # Инициализация
    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)

    bot = app.bot

    # Отправить стартовое сообщение
    await send_tg(bot, "🤖 <b>Paperclip Bridge запущен</b>\n\nУведомления о задачах активны.")

    # Запустить WebSocket слушатель
    try:
        await ws_listener(bot)
    except KeyboardInterrupt:
        log.info("Остановка...")
    finally:
        await app.updater.stop()
        await app.stop()
        await app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
