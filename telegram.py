import asyncio
import json
import os
import random
import base64
import hashlib
import tempfile
import traceback
from datetime import datetime
from collections import defaultdict

import websockets
from dotenv import load_dotenv
from pymongo import MongoClient
from telethon import TelegramClient, functions
from telethon.sessions import StringSession
from telethon.tl.functions.messages import ReportRequest
from telethon.tl.functions.channels import JoinChannelRequest, LeaveChannelRequest
from telethon.tl.functions.account import UpdateProfileRequest
from telethon.tl.functions.photos import UploadProfilePhotoRequest, DeletePhotosRequest
from telethon.tl.functions.photos import GetUserPhotosRequest
from telethon.tl.types import (
    InputReportReasonSpam, InputReportReasonViolence, InputReportReasonFake,
    InputReportReasonPornography, InputReportReasonChildAbuse,
    InputReportReasonIllegalDrugs, InputReportReasonOther,
    InputReportReasonPersonalDetails, InputReportReasonGeoIrrelevant,
    ReportResultReported, ReportResultAddComment,
)
from telethon.errors import (
    UserAlreadyParticipantError, ChatIdInvalidError,
    InviteHashExpiredError, UsersTooMuchError, SessionPasswordNeededError,
)

load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────

API_ID   = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
MONGO_URI = os.getenv("MONGO_DB_URI", "")
MONGO_DB  = os.getenv("MONGODB_DB", "ogmirza")
BOT_SECRET = os.getenv("BOT_SECRET", "changeme_bot_secret")
WS_URL     = os.getenv("WS_URL", "ws://localhost:3000/ws")

# ─── MongoDB ──────────────────────────────────────────────────────────────────

mongoClient = MongoClient(MONGO_URI)
db          = mongoClient[MONGO_DB]
sessionsCol = db["sessions"]
reportsCol  = db["reports"]

# ─── Globals ──────────────────────────────────────────────────────────────────

# index -> TelegramClient
activeSessions: dict[int, TelegramClient] = {}

# Temp clients during OTP flow — keyed by phone
pendingOtpClients = {}

# Currently running report tasks — hash -> asyncio.Task
activeReportTasks = {}

# WS connection (set once connected)
wsConnection = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


async def sendWs(data):
    global wsConnection
    if wsConnection is None:
        return
    try:
        await wsConnection.send(json.dumps(data))
    except Exception:
        pass


async def broadcastStatus(extra: dict = {}):
    """Send current bot status to all connected browsers."""
    await sendWs({
        "type": "botStatus",
        "online": True,
        "sessionCount": len(activeSessions),
        "activeReports": len(activeReportTasks),
        **extra,
    })


def getReasonObject(reasonStr):
    reasonMap = {
        "InputReportReasonSpam":           InputReportReasonSpam(),
        "InputReportReasonViolence":        InputReportReasonViolence(),
        "InputReportReasonFake":            InputReportReasonFake(),
        "InputReportReasonPornography":     InputReportReasonPornography(),
        "InputReportReasonChildAbuse":      InputReportReasonChildAbuse(),
        "InputReportReasonIllegalDrugs":    InputReportReasonIllegalDrugs(),
        "InputReportReasonOther":           InputReportReasonOther(),
        "InputReportReasonPersonalDetails": InputReportReasonPersonalDetails(),
        "InputReportReasonGeoIrrelevant":   InputReportReasonGeoIrrelevant(),
    }
    return reasonMap.get(reasonStr, InputReportReasonSpam())


async def fetchClientInfo(client):
    """Return dict with account details."""
    try:
        me = await client.get_me()
        return {
            "name":        f"{me.first_name or ''} {me.last_name or ''}".strip() or "Unknown",
            "phone":       me.phone,
            "premium":     bool(getattr(me, "premium", False)),
            "hasPhoto":    bool(me.photo),
            "emojiStatus": bool(getattr(me, "emoji_status", None)),
            "dcId":        me.photo.dc_id if me.photo else None,
            "country":     None,
        }
    except Exception as e:
        log(f"fetchClientInfo error: {e}")
        return {}


# ─── Session loading ──────────────────────────────────────────────────────────

async def loadSessionsFromDb():
    """Load all valid sessions from MongoDB, connect them, and refresh their DB info."""
    docs = list(sessionsCol.find({"isValid": True}))
    log(f"Loading {len(docs)} sessions from DB...")

    for doc in docs:
        idx = doc["index"]
        if idx in activeSessions:
            continue  # already loaded
        sessionStr = doc.get("sessionString")
        if not sessionStr:
            continue
        try:
            client = TelegramClient(StringSession(sessionStr), API_ID, API_HASH)
            await client.connect()
            if not await client.is_user_authorized():
                log(f"Session #{idx} not authorized — skipping")
                sessionsCol.update_one({"_id": doc["_id"]}, {"$set": {"isValid": False}})
                continue
            activeSessions[idx] = client
            log(f"Session #{idx} ({doc.get('name', '?')}) connected")

            # Refresh DC ID, phone, premium etc. from Telegram on each startup
            try:
                info = await fetchClientInfo(client)
                update_fields = {}
                if info.get("phone"):                  update_fields["phone"]       = info["phone"]
                if info.get("dcId") is not None:       update_fields["dcId"]        = info["dcId"]
                if info.get("premium") is not None:    update_fields["premium"]     = info["premium"]
                if info.get("hasPhoto") is not None:   update_fields["hasPhoto"]    = info["hasPhoto"]
                if info.get("emojiStatus") is not None: update_fields["emojiStatus"] = info["emojiStatus"]
                if update_fields:
                    sessionsCol.update_one({"_id": doc["_id"]}, {"$set": update_fields})
                    log(f"Session #{idx} DB info refreshed (dcId={update_fields.get('dcId')})")
            except Exception as e:
                log(f"Session #{idx} info refresh failed: {e}")

        except Exception as e:
            log(f"Session #{idx} failed to connect: {e}")

    log(f"{len(activeSessions)} sessions active")


async def hotLoadSession(doc) -> bool:
    """Connect a single session doc into activeSessions. Returns True if added."""
    idx = doc["index"]
    if idx in activeSessions:
        return False  # already there
    sessionStr = doc.get("sessionString")
    if not sessionStr:
        return False
    try:
        client = TelegramClient(StringSession(sessionStr), API_ID, API_HASH)
        await client.connect()
        if not await client.is_user_authorized():
            sessionsCol.update_one({"_id": doc["_id"]}, {"$set": {"isValid": False}})
            return False
        activeSessions[idx] = client

        # Refresh DC info immediately after hot-load
        try:
            info = await fetchClientInfo(client)
            update_fields = {}
            if info.get("phone"):                  update_fields["phone"]       = info["phone"]
            if info.get("dcId") is not None:       update_fields["dcId"]        = info["dcId"]
            if info.get("premium") is not None:    update_fields["premium"]     = info["premium"]
            if info.get("hasPhoto") is not None:   update_fields["hasPhoto"]    = info["hasPhoto"]
            if update_fields:
                sessionsCol.update_one({"_id": doc["_id"]}, {"$set": update_fields})
        except Exception:
            pass

        log(f"Hot-loaded session #{idx} ({doc.get('name', '?')})")
        return True
    except Exception as e:
        log(f"Hot-load session #{idx} failed: {e}")
        return False


# ─── Add session handler ──────────────────────────────────────────────────────

async def handleAddSession(msg):
    sessionStr = msg.get("sessionString")
    method     = msg.get("method", "string")

    if method == "file":
        try:
            raw = base64.b64decode(sessionStr)
            tmpPath = tempfile.mktemp(suffix=".session")
            with open(tmpPath, "wb") as f:
                f.write(raw)
            client = TelegramClient(tmpPath, API_ID, API_HASH)
            await client.connect()
            if not await client.is_user_authorized():
                try:
                    os.unlink(tmpPath)
                except Exception:
                    pass
                await sendWs({"type": "sessionResult", "valid": False, "error": "Session not authorized"})
                return
            info = await fetchClientInfo(client)
            sessionStr = client.session.save()
            await client.disconnect()
            try:
                os.unlink(tmpPath)
            except Exception:
                pass
        except Exception as e:
            log(f"File session error: {e}")
            await sendWs({"type": "sessionResult", "valid": False, "error": str(e)})
            return
    else:
        try:
            client = TelegramClient(StringSession(sessionStr), API_ID, API_HASH)
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                await sendWs({"type": "sessionResult", "valid": False, "error": "Session not authorized"})
                return
            info = await fetchClientInfo(client)
            await client.disconnect()
        except Exception as e:
            log(f"String session error: {e}")
            await sendWs({"type": "sessionResult", "valid": False, "error": str(e)})
            return

    await sendWs({
        "type": "sessionResult",
        "valid": True,
        "sessionString": sessionStr,
        **info,
    })

    # After the site saves the session, hot-load it so no restart needed.
    # We wait briefly for the DB write to complete, then load by sessionString.
    async def _hotLoadAfterSave():
        await asyncio.sleep(1.5)
        doc = sessionsCol.find_one({"sessionString": sessionStr, "isValid": True})
        if doc:
            added = await hotLoadSession(doc)
            if added:
                await broadcastStatus({"toast": f"Session #{doc['index']} is now active"})
    asyncio.create_task(_hotLoadAfterSave())


# ─── OTP flow ─────────────────────────────────────────────────────────────────

async def handleSendCode(msg):
    phone = msg.get("phone")
    if not phone:
        await sendWs({"type": "sessionResult", "valid": False, "error": "Phone required"})
        return
    try:
        client = TelegramClient(StringSession(), API_ID, API_HASH)
        await client.connect()
        result = await client.send_code_request(phone)
        pendingOtpClients[phone] = {"client": client, "phoneCodeHash": result.phone_code_hash}
        await sendWs({"type": "codeRequested", "phone": phone, "phoneCodeHash": result.phone_code_hash})
        log(f"OTP sent to {phone}")
    except Exception as e:
        log(f"sendCode error: {e}")
        await sendWs({"type": "sessionResult", "valid": False, "error": str(e)})


async def handleConfirmCode(msg):
    phone         = msg.get("phone")
    code          = msg.get("code")
    phoneCodeHash = msg.get("phoneCodeHash")

    pending = pendingOtpClients.get(phone)
    if not pending:
        await sendWs({"type": "sessionResult", "valid": False, "error": "OTP session expired"})
        return

    client = pending["client"]
    try:
        await client.sign_in(phone, code, phone_code_hash=phoneCodeHash)
    except SessionPasswordNeededError:
        await sendWs({"type": "tfaRequired", "phone": phone})
        return
    except Exception as e:
        log(f"confirmCode error: {e}")
        await sendWs({"type": "sessionResult", "valid": False, "error": str(e)})
        return

    info       = await fetchClientInfo(client)
    sessionStr = client.session.save()
    await client.disconnect()
    del pendingOtpClients[phone]
    await sendWs({"type": "sessionResult", "valid": True, "sessionString": sessionStr, **info})


async def handleSubmit2fa(msg):
    phone    = msg.get("phone")
    password = msg.get("password")

    pending     = None
    pendingPhone = None
    for p, v in pendingOtpClients.items():
        if p == phone or not phone:
            pending      = v
            pendingPhone = p
            break

    if not pending:
        await sendWs({"type": "sessionResult", "valid": False, "error": "2FA session expired"})
        return

    client = pending["client"]
    try:
        await client.sign_in(password=password)
    except Exception as e:
        log(f"2FA error: {e}")
        await sendWs({"type": "sessionResult", "valid": False, "error": str(e)})
        return

    info       = await fetchClientInfo(client)
    sessionStr = client.session.save()
    await client.disconnect()
    del pendingOtpClients[pendingPhone]
    await sendWs({"type": "sessionResult", "valid": True, "sessionString": sessionStr, **info})


# ─── Bot control handlers ─────────────────────────────────────────────────────

async def handleReloadSessions(msg):
    """Hot-load any new sessions from DB that aren't in activeSessions yet."""
    docs   = list(sessionsCol.find({"isValid": True}))
    added  = 0
    failed = 0
    for doc in docs:
        if doc["index"] in activeSessions:
            continue
        ok = await hotLoadSession(doc)
        if ok:
            added += 1
        else:
            failed += 1

    log(f"Reload: added {added}, failed {failed}, total {len(activeSessions)} active")
    await broadcastStatus({
        "reloadResult": {
            "added":   added,
            "failed":  failed,
            "total":   len(activeSessions),
        }
    })


async def handleGetBotStatus(msg):
    """Return current bot status to the requesting browser."""
    await broadcastStatus()


async def handleDisconnectSession(msg):
    """Disconnect and remove a session from activeSessions by index."""
    idx = msg.get("index")
    if idx is not None and idx in activeSessions:
        try:
            await activeSessions[idx].disconnect()
        except Exception:
            pass
        del activeSessions[idx]
        log(f"Disconnected session #{idx}")
    await broadcastStatus()


async def handleRenameAccount(msg):
    """Update the Telegram account's actual first/last name via UpdateProfileRequest."""
    raw_idx = msg.get("index")
    name    = (msg.get("name") or "").strip()

    if not name:
        log("renameAccount: empty name, skipping")
        return

    # Guard: ensure index is an int regardless of JSON encoding (1 vs 1.0)
    try:
        idx = int(raw_idx)
    except (TypeError, ValueError):
        log(f"renameAccount: invalid index {raw_idx!r}")
        await sendWs({"type": "renameResult", "ok": False, "error": f"Invalid index: {raw_idx}"})
        return

    if idx not in activeSessions:
        log(f"renameAccount: session #{idx} not in activeSessions — available: {list(activeSessions.keys())}")
        await sendWs({"type": "renameResult", "ok": False, "index": idx, "error": "Session not active in bot — sync first"})
        return

    client = activeSessions[idx]
    try:
        # Split "First Last" → first_name / last_name
        parts      = name.split(" ", 1)
        first_name = parts[0]
        last_name  = parts[1] if len(parts) > 1 else ""

        # Use UpdateProfileRequest directly — more reliable than edit_profile()
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        log(f"Renamed session #{idx} on Telegram → '{name}'")
        await sendWs({"type": "renameResult", "ok": True, "index": idx, "name": name})
    except Exception as e:
        log(f"renameAccount #{idx} error: {e}")
        await sendWs({"type": "renameResult", "ok": False, "index": idx, "error": str(e)})


async def handleEditProfile(msg):
    """Update first name, last name, bio, photo — or delete all photos."""
    raw_idx      = msg.get("index")
    delete_photos = msg.get("deletePhotos", False)

    try:
        idx = int(raw_idx)
    except (TypeError, ValueError):
        await sendWs({"type": "editProfileResult", "ok": False, "index": raw_idx, "error": f"Invalid index: {raw_idx}"})
        return

    if idx not in activeSessions:
        await sendWs({"type": "editProfileResult", "ok": False, "index": idx, "error": "Session not active — sync first"})
        return

    client = activeSessions[idx]

    # ── Delete all profile photos ──────────────────────────────────────────────
    if delete_photos:
        try:
            photos = await client(GetUserPhotosRequest(user_id="me", offset=0, max_id=0, limit=100))
            if photos.photos:
                await client(DeletePhotosRequest(id=photos.photos))
                log(f"editProfile #{idx}: deleted {len(photos.photos)} photo(s)")
            else:
                log(f"editProfile #{idx}: no photos to delete")
            await sendWs({"type": "editProfileResult", "ok": True, "index": idx, "action": "deletePhotos"})
        except Exception as e:
            log(f"editProfile #{idx} deletePhotos error: {e}")
            await sendWs({"type": "editProfileResult", "ok": False, "index": idx, "error": str(e)})
        return

    # ── Update profile fields ──────────────────────────────────────────────────
    first_name = (msg.get("firstName") or "").strip()
    last_name  = (msg.get("lastName")  or "").strip()
    bio        = (msg.get("bio")       or "").strip()
    photo_b64  = msg.get("photo")

    try:
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name, about=bio))
        log(f"editProfile #{idx}: name='{first_name} {last_name}' bio='{bio[:30]}'")

        if photo_b64:
            import base64, tempfile, os
            photo_bytes = base64.b64decode(photo_b64)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                tmp.write(photo_bytes)
                tmp_path = tmp.name
            try:
                uploaded = await client.upload_file(tmp_path)
                await client(UploadProfilePhotoRequest(file=uploaded))
                log(f"editProfile #{idx}: photo uploaded")
            finally:
                os.unlink(tmp_path)

        new_name = (first_name + " " + last_name).strip()
        if new_name:
            sessionsCol.update_one({"index": idx}, {"$set": {"name": new_name}})

        await sendWs({"type": "editProfileResult", "ok": True, "index": idx})
    except Exception as e:
        log(f"editProfile #{idx} error: {e}")
        await sendWs({"type": "editProfileResult", "ok": False, "index": idx, "error": str(e)})


async def handleJoinChat(msg):
    """Join selected accounts to a Telegram chat via public username or invite link."""
    requested_ids = msg.get("clients", [])
    link          = (msg.get("link") or "").strip()
    delay_min     = float(msg.get("delayMin", 2))
    delay_max     = float(msg.get("delayMax", 5))

    if not link:
        await sendWs({"type": "joinError", "message": "No link provided"})
        return

    # Resolve which clients to use
    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}

    clients = []
    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if doc and doc["index"] in activeSessions:
            clients.append((doc["index"], activeSessions[doc["index"]], doc.get("name", f"#{doc['index']}")))

    if not clients:
        await sendWs({"type": "joinError", "message": "No active sessions found for selected accounts"})
        return

    # Determine link type
    is_invite = "/+" in link or "/joinchat/" in link

    log(f"Joining {len(clients)} clients to: {link}")

    for idx, client, client_name in clients:
        if delay_min > 0 or delay_max > 0:
            await asyncio.sleep(random.uniform(delay_min, delay_max))

        worked = False
        error  = None
        try:
            if is_invite:
                # Private invite link: t.me/+HASH or t.me/joinchat/HASH
                if "/+" in link:
                    hash_part = link.split("/+", 1)[-1]
                else:
                    hash_part = link.split("/joinchat/", 1)[-1]
                hash_part = hash_part.split("?")[0].rstrip("/")
                await client(functions.messages.ImportChatInviteRequest(hash=hash_part))
            else:
                # Public username/channel: t.me/username
                username = link.rstrip("/").split("t.me/")[-1].lstrip("@").split("?")[0]
                await client(JoinChannelRequest(channel=username))
            worked = True
            log(f"  ✓ {client_name} joined")
        except UserAlreadyParticipantError:
            worked = True
            error  = "Already a participant"
            log(f"  ✓ {client_name} already in chat")
        except InviteHashExpiredError:
            error = "Invite link expired"
            log(f"  ✗ {client_name}: invite expired")
        except UsersTooMuchError:
            error = "Chat is full"
            log(f"  ✗ {client_name}: chat full")
        except Exception as e:
            error = str(e)
            log(f"  ✗ {client_name}: {e}")

        await sendWs({
            "type":   "joinProgress",
            "client": client_name,
            "worked": worked,
            "error":  error,
            "time":   datetime.now().isoformat(),
        })

    await sendWs({"type": "joinComplete", "total": len(clients)})
    log(f"Join complete: {len(clients)} accounts processed")


async def handleLeaveChat(msg):
    """Remove selected accounts from a Telegram chat by username or chat ID."""
    requested_ids = msg.get("clients", [])
    chat          = (msg.get("chat") or "").strip()
    delay_min     = float(msg.get("delayMin", 2))
    delay_max     = float(msg.get("delayMax", 5))

    if not chat:
        await sendWs({"type": "leaveError", "message": "No chat ID or username provided"})
        return

    # Resolve clients
    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}

    clients = []
    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if doc and doc["index"] in activeSessions:
            clients.append((doc["index"], activeSessions[doc["index"]], doc.get("name", f"#{doc['index']}")))

    if not clients:
        await sendWs({"type": "leaveError", "message": "No active sessions found for selected accounts"})
        return

    # Normalise: numeric ID or username string
    chat_ref = chat.lstrip("@")
    try:
        chat_ref = int(chat_ref)
    except ValueError:
        pass  # leave as string username

    log(f"Leaving {len(clients)} clients from: {chat}")

    for idx, client, client_name in clients:
        if delay_min > 0 or delay_max > 0:
            await asyncio.sleep(random.uniform(delay_min, delay_max))

        worked = False
        error  = None
        try:
            entity = await client.get_input_entity(chat_ref)
            await client(LeaveChannelRequest(channel=entity))
            worked = True
            log(f"  ✓ {client_name} left")
        except Exception as e:
            error = str(e)
            log(f"  ✗ {client_name}: {e}")

        await sendWs({
            "type":   "leaveProgress",
            "client": client_name,
            "worked": worked,
            "error":  error,
            "time":   datetime.now().isoformat(),
        })

    await sendWs({"type": "leaveComplete", "total": len(clients)})
    log(f"Leave complete: {len(clients)} accounts processed")


# ─── Reporter ─────────────────────────────────────────────────────────────────

class Reporter:
    globalUsedFormats = set()
    clientUsedFormats = defaultdict(set)

    def __init__(self, payload, clientObjects, clientNames):
        self.payload     = payload
        self.clients     = clientObjects
        self.clientNames = clientNames
        self.taskData    = payload["data"]
        self.hash        = payload["hash"]
        self.formats     = payload.get("formats", [])
        self.amount      = self.taskData.get("amount", 1)
        self.logs        = {}

    def getUniqueFormat(self, clientIdx):
        available = [f for f in self.formats if f not in Reporter.globalUsedFormats]
        if available:
            choice = random.choice(available)
            Reporter.globalUsedFormats.add(choice)
            Reporter.clientUsedFormats[clientIdx].add(choice)
            return choice
        if Reporter.clientUsedFormats[clientIdx]:
            return random.choice(list(Reporter.clientUsedFormats[clientIdx]))
        choice = random.choice(self.formats) if self.formats else ""
        Reporter.clientUsedFormats[clientIdx].add(choice)
        return choice

    async def applyDelay(self):
        delayStr = self.taskData.get("uniformDelay", "5, 20")
        parts    = delayStr.split(",")
        minD     = float(parts[0].strip())
        maxD     = float(parts[1].strip()) if len(parts) > 1 else minD
        await asyncio.sleep(random.uniform(minD, maxD))

    async def resolveTarget(self, client):
        targetType = self.taskData["type"]
        if targetType == "public":
            username = self.taskData.get("username", "").lstrip("@")
            return await client.get_input_entity(username)
        elif targetType == "private":
            chatId = self.taskData.get("chatId")  # already -100xxx format
            return await client.get_input_entity(int(chatId))
        elif targetType == "userId":
            username = self.taskData.get("username") or self.taskData.get("userId", "")
            username = str(username).lstrip("@")
            try:
                return await client.get_input_entity(int(username))
            except (ValueError, TypeError):
                return await client.get_input_entity(username)

    async def runMessageReport(self):
        allMessageIds = [int(m) for m in self.taskData.get("messageIds", [])]
        options       = self.taskData.get("options", ["1:c"])
        target_name   = self.taskData.get("username") or self.taskData.get("chatId") or "?"

        log(f"[Report {self.hash[:8]}] MSG report → target={target_name} | msgs={allMessageIds} | amount={self.amount} | options={options}")

        for i in range(self.amount):
            if self.hash not in activeReportTasks:
                log(f"[Report {self.hash[:8]}] Stopped at iteration {i}")
                break

            idx        = random.randint(0, len(self.clients) - 1)
            client     = self.clients[idx]
            clientName = self.clientNames[idx]
            fmt        = self.getUniqueFormat(idx)
            option     = random.choice(options) if options else "1:c"
            msgBatch   = random.sample(
                allMessageIds,
                max(1, min(len(allMessageIds), random.randint(1, min(5, len(allMessageIds)))))
            )

            worked   = False
            errorMsg = None
            try:
                await self.applyDelay()
                peer = await self.resolveTarget(client)

                log(f"[Report {self.hash[:8]}] #{i+1}/{self.amount} | {clientName} | msgs={msgBatch} | target={option!r} | fmt={fmt!r:.30s}")

                # Navigate Telegram's report tree dynamically.
                # Flow example for target "42" (Drugs):
                #   b""    → ChooseOption [b"1", b"2", ..., b"4", ...]   pick b"4" (prefix of "42")
                #   b"4"   → ChooseOption [b"41", b"42", b"43", ...]     pick b"42" (exact)
                #   b"42"  → ChooseOption [b"42:c"]                      pick b"42:c" (confirm)
                #   b"42:c"→ ReportResultReported ✓
                cur_option = b""
                result = None
                for depth in range(10):
                    result = await client(ReportRequest(peer=peer, id=msgBatch, option=cur_option, message=fmt))
                    log(f"[Report {self.hash[:8]}] #{i+1} depth={depth} sent={cur_option!r} → {type(result).__name__}")

                    if isinstance(result, (ReportResultReported, ReportResultAddComment)):
                        # ReportResultAddComment = report filed, optional comment step — treat as success
                        worked = True
                        break

                    opts = getattr(result, "options", [])
                    if not opts:
                        errorMsg = f"No options at depth {depth}: {type(result).__name__}"
                        break

                    available = [(o.option, o.option.decode("utf-8", errors="ignore")) for o in opts]
                    log(f"[Report {self.hash[:8]}] #{i+1} depth={depth} choices: {[k for _, k in available]}")

                    chosen = None

                    # If we already sent the exact target and Telegram still wants input,
                    # confirm with :c (e.g. sent b"42", got sub-options → send b"42:c")
                    if cur_option == option.encode("utf-8"):
                        chosen = (option + ":c").encode("utf-8")
                        log(f"[Report {self.hash[:8]}] #{i+1} depth={depth} exact target sent → confirming with {chosen!r}")
                    else:
                        # Priority 1: exact match for target in available list
                        for raw, key in available:
                            if key == option:
                                chosen = raw
                                break
                        # Priority 2: confirm token already in list (e.g. b"42:c")
                        if not chosen:
                            for raw, key in available:
                                if key == option + ":c":
                                    chosen = raw
                                    break
                        # Priority 3: prefix — navigate a level deeper (e.g. b"4" → b"42")
                        if not chosen:
                            for raw, key in available:
                                if option.startswith(key):
                                    chosen = raw
                                    break
                        # Fallback: first option
                        if not chosen:
                            chosen = available[0][0]
                            log(f"[Report {self.hash[:8]}] #{i+1} depth={depth} no match, fallback={available[0][1]!r}")

                    cur_option = chosen
                else:
                    errorMsg = "Report tree depth limit reached"

                if worked:
                    log(f"[Report {self.hash[:8]}] #{i+1} ✓ {clientName} — reported")
                elif not errorMsg:
                    result_type = type(result).__name__ if result else "None"
                    errorMsg = f"Telegram returned {result_type} (not reported)"
                    log(f"[Report {self.hash[:8]}] #{i+1} ✗ {clientName} — {errorMsg}")
            except Exception as e:
                errorMsg = str(e)
                log(f"[Report {self.hash[:8]}] #{i+1} ✗ {clientName} — Exception: {errorMsg}")

            now = datetime.now().isoformat()
            await sendWs({
                "type":   "reportProgress",
                "hash":   self.hash,
                "index":  i + 1,
                "total":  self.amount,
                "client": clientName,
                "worked": worked,
                "msgIds": msgBatch,
                "reason": option,
                "format": fmt,
                "error":  errorMsg,
                "time":   now,
            })

            self.logs[str(i + 1)] = {
                "client": clientName,
                "msgIds": msgBatch,
                "reason": option,
                "format": fmt,
                "worked": worked,
                "error":  errorMsg,
                "time":   now,
            }

        await self.finish()

    async def runPeerReport(self):
        reasons    = self.taskData.get("reasons", ["InputReportReasonSpam"])
        targetName = self.taskData.get("username") or self.taskData.get("userId") or "Unknown"

        log(f"[Report {self.hash[:8]}] PEER report → target={targetName} | reasons={reasons} | amount={self.amount}")

        for i in range(self.amount):
            if self.hash not in activeReportTasks:
                log(f"[Report {self.hash[:8]}] Stopped at iteration {i}")
                break

            idx        = random.randint(0, len(self.clients) - 1)
            client     = self.clients[idx]
            clientName = self.clientNames[idx]
            fmt        = self.getUniqueFormat(idx)
            reasonStr  = random.choice(reasons)
            reason     = getReasonObject(reasonStr)

            worked   = False
            errorMsg = None
            try:
                await self.applyDelay()
                log(f"[Report {self.hash[:8]}] #{i+1}/{self.amount} | {clientName} | reason={reasonStr} | fmt={fmt!r:.30s}")
                peer   = await self.resolveTarget(client)
                result = await client(functions.account.ReportPeerRequest(peer=peer, reason=reason, message=fmt))
                worked = bool(result)
                if worked:
                    log(f"[Report {self.hash[:8]}] #{i+1} ✓ {clientName} — peer reported")
                else:
                    errorMsg = "ReportPeer returned False"
                    log(f"[Report {self.hash[:8]}] #{i+1} ✗ {clientName} — {errorMsg}")
            except Exception as e:
                errorMsg = str(e)
                log(f"[Report {self.hash[:8]}] #{i+1} ✗ {clientName} — Exception: {errorMsg}")

            now = datetime.now().isoformat()
            await sendWs({
                "type":   "reportProgress",
                "hash":   self.hash,
                "index":  i + 1,
                "total":  self.amount,
                "client": clientName,
                "worked": worked,
                "reason": reasonStr,
                "error":  errorMsg,
                "time":   now,
            })

            self.logs[str(i + 1)] = {
                "client": clientName,
                "reason": reasonStr,
                "worked": worked,
                "error":  errorMsg,
                "time":   now,
            }

        await self.finish()

    async def finish(self):
        worked_count = sum(1 for l in self.logs.values() if l.get("worked"))
        fail_count   = len(self.logs) - worked_count
        log(f"[Report {self.hash[:8]}] Complete — {worked_count} OK / {fail_count} FAIL / {len(self.logs)} total")
        reportsCol.update_one(
            {"hash": self.hash},
            {"$set": {"status": "completed", "completedAt": datetime.now(), "logs": self.logs}}
        )
        await sendWs({
            "type":    "reportComplete",
            "hash":    self.hash,
            "total":   self.amount,
            "worked":  worked_count,
            "failed":  fail_count,
        })
        if self.hash in activeReportTasks:
            del activeReportTasks[self.hash]
        Reporter.globalUsedFormats.clear()

    async def start(self):
        if self.taskData.get("messageIds"):
            await self.runMessageReport()
        else:
            await self.runPeerReport()


# ─── Start / stop report ──────────────────────────────────────────────────────

async def handleStartReport(msg):
    payload           = msg
    requestedIds      = payload.get("clients", [])
    sessionDocs       = list(sessionsCol.find({"isValid": True}))
    idToDoc           = {str(doc["_id"]): doc for doc in sessionDocs}

    clientObjects = []
    clientNames   = []
    for ref in requestedIds:
        doc = idToDoc.get(ref)
        if doc and doc["index"] in activeSessions:
            clientObjects.append(activeSessions[doc["index"]])
            clientNames.append(doc.get("name", f"#{doc['index']}"))

    if not clientObjects:
        await sendWs({"type": "error", "message": "No valid active sessions found for requested IDs"})
        return

    reporter = Reporter(payload, clientObjects, clientNames)
    task     = asyncio.create_task(reporter.start())
    activeReportTasks[payload["hash"]] = task
    log(f"Report started: {payload['hash'][:8]} with {len(clientObjects)} sessions")


async def handleStopReport(msg):
    hashVal = msg.get("hash")
    if hashVal in activeReportTasks:
        del activeReportTasks[hashVal]
        reportsCol.update_one({"hash": hashVal}, {"$set": {"status": "stopped"}})
        await sendWs({"type": "reportStopped", "hash": hashVal})
        log(f"Report stopped: {hashVal[:8]}")


# ─── WS dispatcher ────────────────────────────────────────────────────────────

async def dispatch(msg):
    msgType = msg.get("type")
    log(f"← {msgType}")

    handlers = {
        "addSession":          handleAddSession,
        "sendCode":            handleSendCode,
        "confirmCode":         handleConfirmCode,
        "submit2fa":           handleSubmit2fa,
        "startReport":         handleStartReport,
        "stopReport":          handleStopReport,
        # bot controls
        "reloadSessions":      handleReloadSessions,
        "getBotStatus":        handleGetBotStatus,
        "disconnectSession":   handleDisconnectSession,
        # new
        "joinChat":            handleJoinChat,
        "leaveChat":           handleLeaveChat,
        "renameAccount":       handleRenameAccount,
        "editProfile":         handleEditProfile,
    }

    handler = handlers.get(msgType)
    if handler:
        await handler(msg)
    else:
        log(f"Unknown message type: {msgType}")


# ─── WebSocket loop ───────────────────────────────────────────────────────────

async def connectAndListen():
    global wsConnection
    url = f"{WS_URL}?type=bot&token={BOT_SECRET}"

    while True:
        wsConnection = None
        try:
            log(f"Connecting to {WS_URL}...")
            async with websockets.connect(url, ping_interval=None) as ws:
                wsConnection = ws
                log("Connected to server")
                # Send botReady with current session count so browsers get it immediately
                await ws.send(json.dumps({
                    "type": "botReady",
                    "sessionCount": len(activeSessions),
                }))
                await broadcastStatus()

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        asyncio.create_task(dispatch(msg))
                    except json.JSONDecodeError:
                        pass

                log("WS loop ended cleanly")

        except websockets.exceptions.ConnectionClosedError as e:
            log(f"Connection closed with error — code={e.code} reason={e.reason!r} — reconnecting in 5s")
        except websockets.exceptions.ConnectionClosedOK as e:
            log(f"Connection closed OK — code={e.code} reason={e.reason!r} — reconnecting in 5s")
        except websockets.exceptions.ConnectionClosed as e:
            log(f"Connection closed — {e} — reconnecting in 5s")
        except OSError as e:
            log(f"Network error: {e} — reconnecting in 5s")
        except Exception as e:
            log(f"Unexpected WS error: {type(e).__name__}: {e} — reconnecting in 5s")
            traceback.print_exc()

        wsConnection = None
        await asyncio.sleep(5)


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main():
    await loadSessionsFromDb()
    await connectAndListen()


if __name__ == "__main__":
    asyncio.run(main())
