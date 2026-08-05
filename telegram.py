import asyncio
import io
import json
import os
import re
import random
import base64
import hashlib
import tempfile
import subprocess
import traceback
import warnings
import sys
import time
import threading
import queue as _queue

# Suppress Telethon's "Task was destroyed but pending" noise — these are
# harmless cleanup warnings from asyncio when sessions disconnect abruptly
warnings.filterwarnings("ignore", category=RuntimeWarning, message=".*coroutine.*ignored.*GeneratorExit.*")
warnings.filterwarnings("ignore", category=RuntimeWarning, message=".*Enable tracemalloc.*")

# Swallow "Task was destroyed but it is pending!" + related tracebacks from stderr.
# These are harmless Telethon asyncio cleanup messages printed directly by CPython.
class _TelethonFilter:
    _TRIGGERS = (
        "Task was destroyed but it is pending",
        "coroutine ignored GeneratorExit",
        "RuntimeError: coroutine ignored",
        "Exception ignored in: <coroutine",
    )
    def __init__(self, real):
        self._real = real
        self._mute = 0  # mute this many more lines after a trigger

    def write(self, msg):
        if any(t in msg for t in self._TRIGGERS):
            self._mute = 8
            return
        if self._mute > 0:
            self._mute -= 1
            return
        self._real.write(msg)

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)

sys.stderr = _TelethonFilter(sys.stderr)
from datetime import datetime
from collections import defaultdict, deque

import websockets
from dotenv import load_dotenv
from pymongo import MongoClient
from telethon import TelegramClient, functions
from telethon.utils import get_peer_id
from telethon.sessions import StringSession
from telethon.tl.functions.messages import ReportRequest
from telethon.tl.functions.channels import JoinChannelRequest, LeaveChannelRequest
from telethon.tl.functions.account import UpdateProfileRequest, UpdateUsernameRequest
from telethon.tl.functions.photos import UploadProfilePhotoRequest, DeletePhotosRequest
from telethon.tl.functions.photos import GetUserPhotosRequest
from telethon.tl.functions.users import GetFullUserRequest
from telethon.tl.types import (
    InputReportReasonSpam, InputReportReasonViolence, InputReportReasonFake,
    InputReportReasonPornography, InputReportReasonChildAbuse,
    InputReportReasonIllegalDrugs, InputReportReasonOther,
    InputReportReasonPersonalDetails, InputReportReasonGeoIrrelevant,
    ReportResultReported, ReportResultAddComment,
    InputGroupCallSlug,
)
from telethon.errors import (
    UserAlreadyParticipantError, ChatIdInvalidError,
    InviteHashExpiredError, UsersTooMuchError, SessionPasswordNeededError,
    InviteRequestSentError, FloodWaitError,
)

try:
    from pytgcalls import PyTgCalls
    from pytgcalls.types import MediaStream, AudioQuality, ExternalMedia, Frame, Device, GroupCallConfig
    try:
        from pytgcalls.types.raw import VideoParameters   # for external VIDEO frame push
    except Exception:
        VideoParameters = None
    PYTGCALLS_OK = True
    PYTGCALLS_EXTERNAL = True   # supports raw frame push (send_frame) — no ffmpeg needed
except ImportError:
    try:
        from pytgcalls import PyTgCalls
        from pytgcalls.types import MediaStream
        PYTGCALLS_OK = True
    except ImportError:
        PYTGCALLS_OK = False
    PYTGCALLS_EXTERNAL = False
    AudioQuality = ExternalMedia = Frame = Device = VideoParameters = GroupCallConfig = None

try:
    import numpy as np
    NUMPY_OK = True
except ImportError:
    NUMPY_OK = False

try:
    from scipy.signal import lfilter, butter   # stateful biquads + crossover design
    SCIPY_OK = True
except ImportError:
    SCIPY_OK = False

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
        "activeSessions": list(activeSessions.keys()),
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
    """Return dict with account details, including a small base64 profile photo."""
    try:
        me = await client.get_me()
        photoUrl = None
        if me.photo:
            try:
                buf = io.BytesIO()
                await client.download_profile_photo(me, file=buf, download_big=False)
                if buf.getvalue():
                    photoUrl = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
            except Exception as pe:
                log(f"fetchClientInfo: photo download failed (non-fatal): {pe}")
        return {
            "name":        f"{me.first_name or ''} {me.last_name or ''}".strip() or "Unknown",
            "phone":       me.phone,
            "premium":     bool(getattr(me, "premium", False)),
            "hasPhoto":    bool(me.photo),
            "photoUrl":    photoUrl,
            "emojiStatus": bool(getattr(me, "emoji_status", None)),
            "dcId":        me.photo.dc_id if me.photo else None,
            "country":     None,
        }
    except Exception as e:
        log(f"fetchClientInfo error: {e}")
        return {}


# ─── Session loading ──────────────────────────────────────────────────────────

async def _connectOne(doc, retry=True):
    """Connect a single session. Returns (ok: bool, error: str|None). Retries once."""
    idx = doc["index"]
    sessionStr = doc.get("sessionString")
    if not sessionStr:
        return False, "No session string stored for this account"
    last_err = "Failed to connect"
    for attempt in range(2 if retry else 1):
        try:
            client = TelegramClient(
                StringSession(sessionStr), API_ID, API_HASH,
                connection_retries=3,
                retry_delay=2,
                timeout=20,
            )
            await client.connect()
            if not await client.is_user_authorized():
                log(f"Session #{idx} not authorized — marking invalid")
                sessionsCol.update_one({"_id": doc["_id"]}, {"$set": {"isValid": False}})
                await client.disconnect()
                return False, "Session not authorized — the account was logged out or the session was revoked"
            activeSessions[idx] = client
            log(f"Session #{idx} ({doc.get('name', '?')}) connected")
            # Refresh info without blocking the load if it fails
            try:
                info = await asyncio.wait_for(fetchClientInfo(client), timeout=20)
                fields = {}
                for k in ("phone", "dcId", "premium", "hasPhoto", "photoUrl", "emojiStatus"):
                    if info.get(k) is not None:
                        fields[k] = info[k]
                if fields:
                    sessionsCol.update_one({"_id": doc["_id"]}, {"$set": fields})
            except Exception as e:
                log(f"Session #{idx} info refresh failed (non-fatal): {e}")
            return True, None
        except Exception as e:
            last_err = str(e) or repr(e) or type(e).__name__
            if attempt == 0:
                log(f"Session #{idx} connect failed (attempt 1): {e} — retrying in 3s")
                await asyncio.sleep(3)
            else:
                log(f"Session #{idx} connect failed (attempt 2): {e} — giving up")
    return False, last_err


async def loadSessionsFromDb():
    """Load all valid sessions from MongoDB one by one with a small delay to avoid Telegram flood limits."""
    import warnings
    warnings.filterwarnings("ignore", category=RuntimeWarning, message=".*coroutine.*ignored.*")

    docs = list(sessionsCol.find({"isValid": True}))
    log(f"Loading {len(docs)} sessions from DB...")

    failed = []
    for doc in docs:
        if doc["index"] in activeSessions:
            continue
        ok, _ = await _connectOne(doc, retry=False)
        if not ok:
            failed.append(doc)
        await asyncio.sleep(1.2)  # small gap between connections to avoid Telegram rate limits

    # Retry any that failed on first pass
    if failed:
        log(f"Retrying {len(failed)} failed sessions...")
        for doc in failed:
            if doc["index"] in activeSessions:
                continue
            await _connectOne(doc, retry=True)
            await asyncio.sleep(2)

    log(f"{len(activeSessions)}/{len(docs)} sessions active")


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
            if info.get("photoUrl") is not None:   update_fields["photoUrl"]    = info["photoUrl"]
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
            # A file-based client uses SQLiteSession, whose .save() returns None.
            # Convert to a portable StringSession so the site can store & reload it.
            sessionStr = StringSession.save(client.session)
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


async def handleAddSessionBatch(msg):
    """Validate & save many .session files at once (multi-select or a folder).
    The bot validates each, stores it directly in Mongo, and hot-loads it."""
    files     = msg.get("files", []) or []
    added_by  = msg.get("fromUser") or "bulk"
    total     = len(files)
    if not total:
        await sendWs({"type": "batchSessionComplete", "added": 0, "failed": 0, "total": 0})
        return

    # Next free index (incremented locally as we insert)
    existing = [d.get("index", 0) for d in sessionsCol.find({}, {"index": 1})]
    next_idx = (max(existing) + 1) if existing else 1

    added = 0
    failed = 0
    log(f"Batch add: {total} session file(s)")

    for f in files:
        fname = f.get("name") or "session"
        b64   = f.get("data") or ""
        tmp_path = None
        try:
            raw = base64.b64decode(b64)
            tmp_path = tempfile.mktemp(suffix=".session")
            with open(tmp_path, "wb") as fh:
                fh.write(raw)

            client = TelegramClient(tmp_path, API_ID, API_HASH)
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                failed += 1
                await sendWs({"type": "batchSessionProgress", "name": fname, "ok": False, "error": "Not authorized"})
                continue

            info        = await fetchClientInfo(client)
            session_str = StringSession.save(client.session)   # SQLite file → portable string
            await client.disconnect()

            # Skip duplicates (same session already stored)
            if sessionsCol.find_one({"sessionString": session_str}):
                failed += 1
                await sendWs({"type": "batchSessionProgress", "name": fname, "ok": False, "error": "Already added"})
                continue

            idx = next_idx
            next_idx += 1
            doc = {
                "index":        idx,
                "sessionString": session_str,
                "name":         info.get("name") or os.path.splitext(fname)[0] or f"session_{idx}",
                "country":      info.get("country"),
                "dcId":         info.get("dcId"),
                "phone":        info.get("phone"),
                "premium":      bool(info.get("premium")),
                "emojiStatus":  info.get("emojiStatus"),
                "hasPhoto":     bool(info.get("hasPhoto")),
                "isValid":      True,
                "addedAt":      datetime.now(),
                "addedBy":      added_by,
            }
            sessionsCol.insert_one(doc)
            await hotLoadSession(doc)
            added += 1
            await sendWs({"type": "batchSessionProgress", "name": fname, "ok": True,
                          "index": idx, "accountName": doc["name"]})
            await asyncio.sleep(1.0)  # gentle pacing to avoid Telegram flood limits

        except Exception as e:
            failed += 1
            err = str(e) or repr(e) or type(e).__name__
            log(f"Batch add: {fname} failed: {err}")
            await sendWs({"type": "batchSessionProgress", "name": fname, "ok": False, "error": err})
        finally:
            if tmp_path:
                try: os.unlink(tmp_path)
                except Exception: pass

    await broadcastStatus()
    await sendWs({"type": "batchSessionComplete", "added": added, "failed": failed, "total": total})
    log(f"Batch add complete: {added} added, {failed} failed of {total}")


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
    """Reload button: (1) hot-load any new DB sessions not yet active, and
    (2) re-fetch LIVE profile info (name, photo, premium, dc…) from every active
    client and write it back to the DB so the cards reflect the latest Telegram
    state. (Normal page loads just read these DB values — no Telegram hit.)"""
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

    # Refresh live info for every active client at once (bounded parallel).
    refreshed = 0
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def refresh_one(idx, client):
        nonlocal refreshed
        async with sem:
            try:
                info = await asyncio.wait_for(fetchClientInfo(client), timeout=30)
            except Exception as e:
                log(f"Reload: #{idx} info refresh failed: {e}")
                return
            fields = {k: info[k] for k in
                      ("name", "phone", "dcId", "premium", "hasPhoto", "photoUrl", "emojiStatus")
                      if info.get(k) is not None}
            if fields:
                sessionsCol.update_one({"index": idx}, {"$set": fields})
                refreshed += 1

    await asyncio.gather(*[refresh_one(idx, c) for idx, c in list(activeSessions.items())])

    log(f"Reload: added {added}, failed {failed}, refreshed {refreshed}, total {len(activeSessions)} active")
    await broadcastStatus({
        "reloadResult": {
            "added":     added,
            "failed":    failed,
            "refreshed": refreshed,
            "total":     len(activeSessions),
        }
    })


async def handleGetBotStatus(msg):
    """Return current bot status to the requesting browser."""
    await broadcastStatus()


async def handleStartSession(msg):
    """Manually start/reconnect a session by index."""
    raw_idx = msg.get("index")
    try:
        idx = int(raw_idx)
    except (TypeError, ValueError):
        await sendWs({"type": "startSessionResult", "index": raw_idx, "ok": False, "error": "Invalid index"})
        return

    if idx in activeSessions:
        await sendWs({"type": "startSessionResult", "index": idx, "ok": True, "already": True})
        return

    # Find the session document in DB
    try:
        db = mongoClient[MONGO_DB]
        doc = db["sessions"].find_one({"index": idx})
    except Exception as e:
        await sendWs({"type": "startSessionResult", "index": idx, "ok": False, "error": str(e)})
        return

    if not doc:
        await sendWs({"type": "startSessionResult", "index": idx, "ok": False, "error": "Session not found in DB"})
        return

    ok, err = await _connectOne(doc, retry=True)
    if ok:
        await sendWs({"type": "startSessionResult", "index": idx, "ok": True})
        await broadcastStatus()
    else:
        await sendWs({"type": "startSessionResult", "index": idx, "ok": False,
                      "error": err or "Failed to connect"})


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
        sessionsCol.update_one({"index": idx}, {"$set": {"name": name}})
        log(f"Renamed session #{idx} on Telegram + DB → '{name}'")
        await sendWs({"type": "renameResult", "ok": True, "index": idx, "name": name})
    except Exception as e:
        log(f"renameAccount #{idx} error: {e}")
        await sendWs({"type": "renameResult", "ok": False, "index": idx, "error": str(e)})


async def handleGetProfile(msg):
    """Fetch current profile info (name, username, bio, photo) from Telegram."""
    raw_idx = msg.get("index")
    try:
        idx = int(raw_idx)
    except (TypeError, ValueError):
        await sendWs({"type": "profileData", "index": raw_idx, "ok": False, "error": "Invalid index"})
        return

    client = activeSessions.get(idx)
    if not client:
        await sendWs({"type": "profileData", "index": idx, "ok": False, "error": "Session not active"})
        return

    try:
        me   = await client.get_me()
        full = await client(GetFullUserRequest(me))
        bio  = (full.full_user.about or "").strip()

        photo_b64 = None
        if me.photo:
            try:
                buf = io.BytesIO()
                await client.download_profile_photo(me, file=buf, download_big=False)
                photo_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
            except Exception as pe:
                log(f"getProfile #{idx}: photo download failed (non-fatal): {pe}")

        await sendWs({
            "type":      "profileData",
            "index":     idx,
            "ok":        True,
            "firstName": me.first_name or "",
            "lastName":  me.last_name  or "",
            "username":  me.username   or "",
            "bio":       bio,
            "photo":     photo_b64,
        })
    except Exception as e:
        log(f"getProfile #{idx} error: {e}")
        await sendWs({"type": "profileData", "index": idx, "ok": False, "error": str(e)})


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
    username   = (msg.get("username")  or "").strip().lstrip("@")
    photo_b64  = msg.get("photo")

    username_warning = None
    try:
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name, about=bio))
        log(f"editProfile #{idx}: name='{first_name} {last_name}' bio='{bio[:30]}'")

        # Only touch the username when it actually changed — calling
        # UpdateUsernameRequest with the SAME value (incl. empty == empty when the
        # account has no username) makes Telegram error "not different". And a
        # username conflict shouldn't abort the name/bio/photo changes.
        if msg.get("username") is not None:
            try:
                current_username = (getattr(await client.get_me(), "username", None) or "")
            except Exception:
                current_username = None
            if current_username is None or username != current_username:
                try:
                    await client(UpdateUsernameRequest(username=username))
                    log(f"editProfile #{idx}: username set to '{username}'")
                except Exception as ue:
                    username_warning = str(ue) or repr(ue) or type(ue).__name__
                    log(f"editProfile #{idx}: username update failed (non-fatal): {username_warning}")
            else:
                log(f"editProfile #{idx}: username unchanged ('{username}') — skipped")

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
        elif msg.get("removePhoto"):
            # Remove the current profile photo(s) as part of the save
            try:
                photos = await client(GetUserPhotosRequest(user_id="me", offset=0, max_id=0, limit=100))
                if photos.photos:
                    await client(DeletePhotosRequest(id=photos.photos))
                    log(f"editProfile #{idx}: removed {len(photos.photos)} photo(s)")
            except Exception as pe:
                log(f"editProfile #{idx}: removePhoto failed (non-fatal): {pe}")

        new_name = (first_name + " " + last_name).strip()
        db_update = {}
        if new_name:
            db_update["name"] = new_name
        if msg.get("username") is not None and not username_warning:
            db_update["username"] = username
        # Keep the cached avatar in sync with photo changes
        if photo_b64:
            db_update["photoUrl"] = "data:image/jpeg;base64," + photo_b64
            db_update["hasPhoto"] = True
        elif msg.get("removePhoto"):
            db_update["photoUrl"] = None
            db_update["hasPhoto"] = False
        if db_update:
            sessionsCol.update_one({"index": idx}, {"$set": db_update})

        await sendWs({"type": "editProfileResult", "ok": True, "index": idx,
                      "name": new_name or None, "username": username,
                      "usernameWarning": username_warning})
    except Exception as e:
        log(f"editProfile #{idx} error: {e}")
        await sendWs({"type": "editProfileResult", "ok": False, "index": idx, "error": str(e)})


async def handleFetchOtp(msg):
    """Fetch the most recent Telegram login code (OTP) sent to this account.
    Login codes always arrive from the official service-notifications peer 777000:
        'Login code: 86971. Do not give this code to anyone…'
    Returns the parsed digits plus the full message text and time."""
    raw_idx = msg.get("index")
    try:
        idx = int(raw_idx)
    except (TypeError, ValueError):
        await sendWs({"type": "otpResult", "index": raw_idx, "ok": False, "error": f"Invalid index: {raw_idx}"})
        return

    client = activeSessions.get(idx)
    if client is None:
        await sendWs({"type": "otpResult", "index": idx, "ok": False, "error": "Session not active — sync first"})
        return

    try:
        # 777000 = Telegram service notifications (where login codes are delivered)
        try:
            msgs = await client.get_messages(777000, limit=10)
        except Exception:
            # Resolve via dialogs if 777000 isn't in the entity cache yet
            msgs = []
            async for d in client.iter_dialogs():
                if getattr(d.entity, "id", None) == 777000:
                    msgs = await client.get_messages(d.entity, limit=10)
                    break

        code = text = when = None
        for m in msgs:
            body = m.message or ""
            mt = (re.search(r"login code[:\s]*?(\d{4,8})", body, re.IGNORECASE)
                  or re.search(r"\bcode[:\s]+(\d{4,8})\b", body, re.IGNORECASE))
            if mt:
                code = mt.group(1)
                text = body
                when = m.date.isoformat() if getattr(m, "date", None) else None
                break

        if code:
            await sendWs({"type": "otpResult", "index": idx, "ok": True, "code": code, "text": text, "date": when})
            log(f"fetchOtp #{idx}: {code}")
        else:
            latest = msgs[0] if msgs else None
            await sendWs({"type": "otpResult", "index": idx, "ok": False,
                          "error": "No login code found in recent Telegram messages",
                          "text": (latest.message if latest else None),
                          "date": (latest.date.isoformat() if latest and getattr(latest, "date", None) else None)})
    except Exception as e:
        err = str(e) or repr(e) or type(e).__name__
        log(f"fetchOtp #{idx} error: {err}")
        await sendWs({"type": "otpResult", "index": idx, "ok": False, "error": err})


# ─── Randomize names / avatars ────────────────────────────────────────────────

# Hindi / Indian names (romanized — display everywhere; users can upload a .txt of
# Devanagari names too). The old English `names` library is no longer used.
_HINDI_FIRST = [
    "Aarav","Vivaan","Aditya","Vihaan","Arjun","Reyansh","Krishna","Ishaan","Shaurya","Atharv",
    "Aryan","Kabir","Rahul","Amit","Rohit","Vikram","Sanjay","Ravi","Suresh","Rajesh",
    "Deepak","Manish","Ankit","Saurabh","Gaurav","Nikhil","Akash","Pranav","Harsh","Yash",
    "Ananya","Diya","Aadhya","Saanvi","Pari","Anika","Navya","Myra","Aarohi","Ishita",
    "Priya","Pooja","Neha","Anjali","Kavya","Sneha","Riya","Nisha","Shreya","Divya",
    "Meera","Sakshi","Tanvi","Aishwarya","Kiran","Sunita","Rekha","Geeta","Komal","Payal",
]
_HINDI_LAST = [
    "Sharma","Verma","Gupta","Singh","Kumar","Yadav","Patel","Reddy","Nair","Iyer",
    "Mishra","Jha","Das","Bose","Mukherjee","Kapoor","Mehta","Shah","Agarwal","Joshi",
    "Malhotra","Chauhan","Rana","Thakur","Pandey","Tiwari","Dubey","Saxena","Bhatt","Chopra",
    "Nayak","Pillai","Rao","Naidu","Sinha","Bansal","Goyal","Khanna","Trivedi","Bhardwaj",
]

def _random_name():
    return random.choice(_HINDI_FIRST), random.choice(_HINDI_LAST)


# Bulk profile/name/avatar ops fan out to every targeted client CONCURRENTLY
# (capped so we don't self-inflict a flood), each call wrapped in retries that
# honor Telegram's FloodWaitError. This makes changes fire near-instantly on all
# clients at once instead of trickling one-by-one.
_BULK_CONCURRENCY = 20

async def _with_retries(make_coro, tries=3):
    """Await make_coro() with retries. On FloodWaitError, waits the required time."""
    last = None
    for attempt in range(tries):
        try:
            return await make_coro()
        except FloodWaitError as fw:
            last = fw
            await asyncio.sleep(min(getattr(fw, "seconds", 5), 60) + 0.5)
        except Exception as e:
            last = e
            if attempt < tries - 1:
                await asyncio.sleep(0.6 * (attempt + 1))
    raise last if last else RuntimeError("failed")


async def _upload_photo(client, photo_bytes):
    """Upload + set a profile photo from raw JPEG bytes (temp file cleaned up)."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
            tmp.write(photo_bytes); tmp_path = tmp.name
        uploaded = await client.upload_file(tmp_path)
        await client(UploadProfilePhotoRequest(file=uploaded))
    finally:
        if tmp_path:
            try: os.unlink(tmp_path)
            except Exception: pass


def _resolve_active_clients(requested_ids):
    """Map requested session _ids → [(idx, client, name)] for active sessions only."""
    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}
    clients = []
    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if doc and doc["index"] in activeSessions:
            clients.append((doc["index"], activeSessions[doc["index"]], doc.get("name", f"#{doc['index']}")))
    return clients


async def handleRandomizeNames(msg):
    """Give every targeted account a fresh random first+last name — all at once.
    Uses built-in Hindi names, or a custom list uploaded from the site (.txt)."""
    clients = _resolve_active_clients(msg.get("clients", []))
    # Custom names from an uploaded .txt: [{firstName, lastName}] (lastName "" → cleared)
    custom = [n for n in (msg.get("customNames") or [])
              if isinstance(n, dict) and (n.get("firstName") or "").strip()]
    if not clients:
        await sendWs({"type": "randomizeComplete", "kind": "name", "total": 0, "done": 0})
        return
    log(f"Randomize names: {len(clients)} accounts (parallel)"
        f"{f' · custom list ({len(custom)})' if custom else ' · Hindi'}")
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def run_one(idx, client, _):
        if custom:
            pick  = random.choice(custom)
            first = (pick.get("firstName") or "").strip()
            last  = (pick.get("lastName") or "").strip()   # "" clears the last name
        else:
            first, last = _random_name()
        new_name = f"{first} {last}".strip()
        async with sem:
            try:
                await _with_retries(lambda: client(UpdateProfileRequest(first_name=first, last_name=last)))
                sessionsCol.update_one({"index": idx}, {"$set": {"name": new_name}})
                await sendWs({"type": "randomizeProgress", "kind": "name", "index": idx, "ok": True, "name": new_name})
                return True
            except Exception as e:
                err = str(e) or repr(e) or type(e).__name__
                await sendWs({"type": "randomizeProgress", "kind": "name", "index": idx, "ok": False, "error": err})
                return False

    results = await asyncio.gather(*[run_one(*c) for c in clients])
    done = sum(1 for r in results if r)
    await sendWs({"type": "randomizeComplete", "kind": "name", "total": len(clients), "done": done})
    log(f"Randomize names complete: {done}/{len(clients)}")


async def handleRandomizeAvatars(msg):
    """Set a random image (from the supplied set) as each targeted account's profile photo."""
    clients = _resolve_active_clients(msg.get("clients", []))
    images  = msg.get("images", []) or []
    if not images:
        await sendWs({"type": "randomizeComplete", "kind": "avatar", "total": 0, "done": 0, "error": "No images provided"})
        return
    if not clients:
        await sendWs({"type": "randomizeComplete", "kind": "avatar", "total": 0, "done": 0})
        return
    log(f"Randomize avatars: {len(clients)} accounts, {len(images)} images (parallel)")
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def run_one(idx, client, _):
        img_b64 = random.choice(images)
        if "," in img_b64:               # strip any data: URL prefix
            img_b64 = img_b64.split(",", 1)[1]
        async with sem:
            try:
                photo_bytes = base64.b64decode(img_b64)
                await _with_retries(lambda: _upload_photo(client, photo_bytes))
                sessionsCol.update_one({"index": idx}, {"$set": {"hasPhoto": True,
                                       "photoUrl": "data:image/jpeg;base64," + img_b64}})
                await sendWs({"type": "randomizeProgress", "kind": "avatar", "index": idx, "ok": True})
                return True
            except Exception as e:
                err = str(e) or repr(e) or type(e).__name__
                await sendWs({"type": "randomizeProgress", "kind": "avatar", "index": idx, "ok": False, "error": err})
                return False

    results = await asyncio.gather(*[run_one(*c) for c in clients])
    done = sum(1 for r in results if r)
    await sendWs({"type": "randomizeComplete", "kind": "avatar", "total": len(clients), "done": done})
    log(f"Randomize avatars complete: {done}/{len(clients)}")


async def handleBulkProfile(msg):
    """Set the SAME first/last name, bio and/or photo on every selected account —
    fired on all clients AT ONCE (bounded parallel + retries).

    Clearing semantics (as requested): when a FIRST NAME is given, the name/bio
    is applied as a SET — a blank last name REMOVES last names everywhere
    (last_name=""), and a blank bio REMOVES bios everywhere (about=""). With no
    first name we treat it as a photo-only run and don't touch names/bio."""
    clients   = _resolve_active_clients(msg.get("clients", []))
    first     = (msg.get("firstName") or "").strip()
    last      = (msg.get("lastName")  or "").strip()
    bio       = (msg.get("bio")       or "").strip()
    photo_b64 = msg.get("photo")

    if not clients:
        await sendWs({"type": "bulkProfileComplete", "total": 0, "done": 0})
        return

    # Decode the shared photo once (same image for everyone).
    clean_b64 = photo_bytes = None
    if photo_b64:
        clean_b64 = photo_b64.split(",", 1)[1] if "," in photo_b64 else photo_b64
        try:
            photo_bytes = base64.b64decode(clean_b64)
        except Exception:
            photo_bytes, clean_b64 = None, None

    # Decide what name/bio update to send (None = don't touch names/bio at all).
    if first:
        prof_kwargs = dict(first_name=first, last_name=last, about=bio)   # "" clears last/bio
        new_name = (first + " " + last).strip()
    elif last or bio:
        prof_kwargs = dict(first_name=None, last_name=(last or None), about=(bio or None))
        new_name = None
    else:
        prof_kwargs = None
        new_name = None

    if prof_kwargs is None and not photo_bytes:
        await sendWs({"type": "bulkProfileComplete", "total": 0, "done": 0,
                      "error": "Nothing to apply — enter a first name, bio or photo"})
        return

    log(f"Bulk profile: {len(clients)} accounts (parallel)  name='{new_name}' "
        f"clearLast={first and not last} clearBio={first and not bio} photo={'yes' if photo_bytes else 'no'}")
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def run_one(idx, client, _):
        async with sem:
            try:
                if prof_kwargs is not None:
                    await _with_retries(lambda: client(UpdateProfileRequest(**prof_kwargs)))
                db_update = {}
                if first:
                    db_update["name"] = new_name
                if photo_bytes:
                    await _with_retries(lambda: _upload_photo(client, photo_bytes))
                    db_update["photoUrl"] = "data:image/jpeg;base64," + clean_b64
                    db_update["hasPhoto"] = True
                if db_update:
                    sessionsCol.update_one({"index": idx}, {"$set": db_update})
                await sendWs({"type": "bulkProfileProgress", "index": idx, "ok": True, "name": new_name})
                return True
            except Exception as e:
                err = str(e) or repr(e) or type(e).__name__
                await sendWs({"type": "bulkProfileProgress", "index": idx, "ok": False, "error": err})
                return False

    results = await asyncio.gather(*[run_one(*c) for c in clients])
    done = sum(1 for r in results if r)
    await sendWs({"type": "bulkProfileComplete", "total": len(clients), "done": done})
    log(f"Bulk profile complete: {done}/{len(clients)}")


# ─── AI assistant: fetch Telegram context ─────────────────────────────────────

async def handleAiFetchTelegram(msg):
    """Resolve a public/private Telegram link with the selected account and return
    chat info + recent messages as text for the AI to analyze."""
    req_id = msg.get("requestId")
    raw    = (msg.get("link") or "").strip()
    try:
        idx = int(msg.get("index"))
    except (TypeError, ValueError):
        idx = None
    try:
        limit = max(1, min(int(msg.get("limit") or 25), 60))
    except (TypeError, ValueError):
        limit = 25

    client = activeSessions.get(idx) if idx is not None else None
    if client is None:
        # fall back to any active session
        client = next(iter(activeSessions.values()), None)
    if client is None:
        await sendWs({"type": "aiTelegramResult", "requestId": req_id, "ok": False,
                      "error": "No active Telegram session to fetch with"})
        return

    from telethon.tl.functions.messages import CheckChatInviteRequest
    from telethon.tl.types import ChatInviteAlready, ChatInvitePeek

    link = raw
    target_msg_id = None
    entity = None
    info = {}
    note = None

    try:
        m_priv = re.search(r"t\.me/(?:joinchat/|\+)([\w-]+)", link)
        m_cmsg = re.search(r"t\.me/c/(\d+)/(\d+)", link)
        m_pub  = re.search(r"t\.me/([A-Za-z0-9_]{3,})(?:/(\d+))?", link)

        if m_priv:
            invite_hash = m_priv.group(1)
            inv = await client(CheckChatInviteRequest(invite_hash))
            if isinstance(inv, (ChatInviteAlready, ChatInvitePeek)):
                entity = inv.chat
            else:
                info = {
                    "title":        getattr(inv, "title", None),
                    "about":        getattr(inv, "about", None),
                    "participants": getattr(inv, "participants_count", None),
                    "type":         "private (not joined — preview only)",
                }
                note = "This is a private chat the account has NOT joined. Only preview info is available; messages can't be read without joining."
        elif m_cmsg:
            from telethon.tl.types import PeerChannel
            entity = await client.get_entity(PeerChannel(int(m_cmsg.group(1))))
            target_msg_id = int(m_cmsg.group(2))
        elif m_pub:
            entity = await client.get_entity(m_pub.group(1))
            if m_pub.group(2):
                target_msg_id = int(m_pub.group(2))
        else:
            entity = await client.get_entity(link)

        messages_out = []
        if entity is not None:
            info.setdefault("title", getattr(entity, "title", None)
                             or (f"{getattr(entity, 'first_name', '') or ''} {getattr(entity, 'last_name', '') or ''}".strip() or None))
            info.setdefault("username", getattr(entity, "username", None))
            info.setdefault("id", getattr(entity, "id", None))
            info.setdefault("type", type(entity).__name__)
            try:
                full = await client.get_entity(entity)  # ensures cached
            except Exception:
                pass

            # Target message + a little context, or just recent messages
            try:
                if target_msg_id:
                    around = await client.get_messages(entity, ids=list(range(max(1, target_msg_id - 3), target_msg_id + 4)))
                    seq = [m for m in around if m]
                else:
                    seq = await client.get_messages(entity, limit=limit)
                for m in seq:
                    if not m:
                        continue
                    media = None
                    if getattr(m, "photo", None):  media = "photo"
                    elif getattr(m, "video", None): media = "video"
                    elif getattr(m, "document", None): media = "document"
                    messages_out.append({
                        "id":     m.id,
                        "date":   m.date.isoformat() if m.date else None,
                        "sender": getattr(m, "sender_id", None),
                        "text":   (m.message or "")[:600],
                        "media":  media,
                        "target": (target_msg_id is not None and m.id == target_msg_id),
                    })
            except Exception as me:
                note = (note or "") + f" (couldn't read messages: {me})"

        # Build a readable blob for the model
        lines = [f"Telegram fetch for: {raw}"]
        for k in ("title", "username", "id", "type", "participants", "about"):
            if info.get(k) not in (None, ""):
                lines.append(f"{k}: {info[k]}")
        if note:
            lines.append(f"note: {note.strip()}")
        if messages_out:
            lines.append(f"\nrecent messages ({len(messages_out)}):")
            for mm in messages_out:
                tag = " <-- TARGET" if mm.get("target") else ""
                media = f" [{mm['media']}]" if mm.get("media") else ""
                lines.append(f"  #{mm['id']} {mm.get('date','')}{media}{tag}: {mm['text']}")
        text = "\n".join(lines)

        await sendWs({"type": "aiTelegramResult", "requestId": req_id, "ok": True,
                      "text": text, "info": info, "messageCount": len(messages_out)})
        log(f"AI fetch: {raw} -> {info.get('title')!r} ({len(messages_out)} msgs)")
    except Exception as e:
        err = str(e) or repr(e) or type(e).__name__
        await sendWs({"type": "aiTelegramResult", "requestId": req_id, "ok": False, "error": err})
        log(f"AI fetch failed for {raw}: {err}")


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
        except InviteRequestSentError:
            worked = True
            error  = "Pending admin approval"
            log(f"  ✓ {client_name} join request sent (pending approval)")
        except InviteHashExpiredError:
            error = "Invite link expired"
            log(f"  ✗ {client_name}: invite expired")
        except UsersTooMuchError:
            error = "Chat is full"
            log(f"  ✗ {client_name}: chat full")
        except Exception as e:
            error = str(e) or repr(e) or type(e).__name__
            log(f"  ✗ {client_name}: {error}")

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
            error = str(e) or repr(e) or type(e).__name__
            log(f"  ✗ {client_name}: {error}")

        await sendWs({
            "type":   "leaveProgress",
            "client": client_name,
            "worked": worked,
            "error":  error,
            "time":   datetime.now().isoformat(),
        })

    await sendWs({"type": "leaveComplete", "total": len(clients)})
    log(f"Leave complete: {len(clients)} accounts processed")


# ─── Raid ─────────────────────────────────────────────────────────────────────

async def _raid_vc(msg, requested_ids, chat, messages, delay_min, delay_max):
    """Raid INSIDE a voice chat: send group-call text messages from the accounts
    that are currently joined to the call (via the VC window). Uses Telethon's
    phone.SendGroupCallMessage (layer 220+), so no library switch is needed —
    the bot's Telethon is already on a newer layer than that.

    Senders must be in the call, so this is a combo with the VC join feature.
    No reply targets — group-call messages don't support replies here."""
    from telethon.tl import functions, types
    from telethon.tl.types import Channel

    # Senders = selected accounts that are currently joined to a voice call.
    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}
    senders = []
    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if doc and doc["index"] in activeSessions and doc["index"] in vcActivePeers:
            senders.append((doc["index"], activeSessions[doc["index"]], doc.get("name", f"#{doc['index']}")))

    if not senders:
        await sendWs({"type": "raidProgress", "client": "system", "worked": False,
                      "error": "No selected accounts are in the voice chat — join the VC first"})
        await sendWs({"type": "raidComplete", "total": 0, "sent": 0})
        return

    try:
        count = int(msg.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    if count <= 0:
        count = len(senders)

    chat_ref = chat.lstrip("@")
    try:
        chat_ref = int(chat_ref)
    except ValueError:
        pass

    # Resolve the InputGroupCall for the target chat. get_entity/GetFull must run on
    # the same client that sends, so cache the resolved call per client index.
    call_cache = {}
    async def _input_call(idx, client):
        if idx in call_cache:
            return call_cache[idx]
        entity = await client.get_entity(chat_ref)
        if isinstance(entity, Channel):
            full = await client(functions.channels.GetFullChannelRequest(entity))
        else:
            full = await client(functions.messages.GetFullChatRequest(entity.id))
        ic = getattr(full.full_chat, "call", None)
        call_cache[idx] = ic
        return ic

    log(f"VC raid: {count} messages via {len(senders)} in-call client(s) → {chat}")
    sent_ok = 0
    for i in range(count):
        idx, client, client_name = senders[i % len(senders)]

        if delay_min > 0 or delay_max > 0:
            await asyncio.sleep(random.uniform(delay_min, delay_max))

        worked = False
        error  = None
        try:
            input_call = await _input_call(idx, client)
            if input_call is None:
                raise Exception("No active voice chat in that chat")
            text = random.choice(messages)
            await client(functions.phone.SendGroupCallMessageRequest(
                call=input_call,
                message=types.TextWithEntities(text=text, entities=[]),
                random_id=random.randrange(-(2 ** 63), 2 ** 63),
            ))
            worked = True
            sent_ok += 1
            log(f"  ✓ {client_name} sent VC message ({i + 1}/{count})")
        except Exception as e:
            error = str(e) or repr(e) or type(e).__name__
            log(f"  ✗ {client_name} VC: {error}")

        await sendWs({"type": "raidProgress", "client": client_name, "worked": worked,
                      "error": error, "time": datetime.now().isoformat()})

    await sendWs({"type": "raidComplete", "total": count, "sent": sent_ok})
    log(f"VC raid complete: {sent_ok}/{count} messages sent")


async def handleRaid(msg):
    requested_ids = msg.get("clients", [])
    chat          = (msg.get("chat") or "").strip()
    delay_min     = float(msg.get("delayMin", 2))
    delay_max     = float(msg.get("delayMax", 5))

    # Support both multi-message array and legacy single message
    raw_messages = msg.get("messages") or []
    if not raw_messages:
        single = (msg.get("message") or "").strip()
        if single:
            raw_messages = [single]
    messages = [m.strip() for m in raw_messages if m and m.strip()]

    # Optional photos (base64) + the % of sends that should be a photo (vs text)
    photos = []
    for p in (msg.get("photos") or []):
        b = p.split(",", 1)[1] if isinstance(p, str) and "," in p else p
        try:
            photos.append(base64.b64decode(b))
        except Exception:
            pass
    try:
        photo_ratio = max(0, min(100, int(msg.get("photoRatio") or 0)))
    except (TypeError, ValueError):
        photo_ratio = 0

    if not chat:
        await sendWs({"type": "raidProgress", "error": "No chat provided", "worked": False, "client": "system"})
        return
    if not messages and not photos:
        await sendWs({"type": "raidProgress", "error": "Add a message or a photo", "worked": False, "client": "system"})
        return

    # Two raid modes: "chat" (normal messages, supports replies) and "vc" (send
    # messages inside a voice chat — accounts must already be in the call).
    mode = (msg.get("mode") or "chat").strip().lower()
    if mode == "vc":
        await _raid_vc(msg, requested_ids, chat, messages, delay_min, delay_max)
        return

    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}

    clients = []
    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if doc and doc["index"] in activeSessions:
            clients.append((doc["index"], activeSessions[doc["index"]], doc.get("name", f"#{doc['index']}")))

    if not clients:
        await sendWs({"type": "raidProgress", "error": "No active sessions found", "worked": False, "client": "system"})
        return

    # How many messages to send total (round-robin across clients). Default = one per client.
    try:
        count = int(msg.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    if count <= 0:
        count = len(clients)

    # Optional reply target
    reply_to_id = msg.get("replyToMsgId")
    try:
        reply_to_id = int(reply_to_id) if reply_to_id not in (None, "") else None
    except (TypeError, ValueError):
        reply_to_id = None

    # Optional "reply to this user's latest message" — resolved live per send so a
    # deleted message just rolls to their next-latest one.
    reply_user = (str(msg.get("replyToUser") or "")).strip().lstrip("@")
    if reply_user:
        try:
            reply_user = int(reply_user)
        except ValueError:
            pass
    else:
        reply_user = None

    chat_ref = chat.lstrip("@")
    try:
        chat_ref_int = int(chat_ref)
    except ValueError:
        chat_ref_int = None

    log(f"Raid: {count} messages via {len(clients)} clients → {chat}"
        f"{f' (reply user {reply_user})' if reply_user else (f' (reply msg {reply_to_id})' if reply_to_id else '')}")

    sent_ok = 0
    for i in range(count):
        idx, client, client_name = clients[i % len(clients)]

        if delay_min > 0 or delay_max > 0:
            await asyncio.sleep(random.uniform(delay_min, delay_max))

        worked = False
        error  = None
        try:
            peer = await client.get_input_entity(chat_ref_int if chat_ref_int else chat_ref)

            # Resolve the reply target for this send
            reply_id = reply_to_id
            if reply_user is not None:
                try:
                    last = await client.get_messages(peer, limit=1, from_user=reply_user)
                    if last:
                        reply_id = last[0].id
                except Exception as re:
                    log(f"  raid: couldn't find last msg of {reply_user}: {re}")
                    # fall back to fixed id (if any)

            # Decide photo vs text for this send. If only photos (no text) → always
            # photo; if only text → always text; else weighted by photo_ratio.
            send_photo = bool(photos) and (True if not messages else random.randint(1, 100) <= photo_ratio)
            if send_photo:
                pbytes  = random.choice(photos)
                caption = random.choice(messages) if messages else None   # photo "along the text"
                tmp_path = None
                try:
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tf:
                        tf.write(pbytes); tmp_path = tf.name
                    await client.send_file(peer, tmp_path, caption=caption, reply_to=reply_id or None)
                finally:
                    if tmp_path:
                        try: os.unlink(tmp_path)
                        except Exception: pass
                log(f"  ✓ {client_name} sent raid photo ({i+1}/{count})")
            else:
                text = random.choice(messages)
                await client.send_message(peer, text, reply_to=reply_id or None)
                log(f"  ✓ {client_name} sent raid message ({i+1}/{count})")
            worked = True
            sent_ok += 1
        except Exception as e:
            error = str(e) or repr(e) or type(e).__name__
            log(f"  ✗ {client_name}: {error}")

        await sendWs({
            "type":   "raidProgress",
            "client": client_name,
            "worked": worked,
            "error":  error,
            "time":   datetime.now().isoformat(),
        })

    await sendWs({"type": "raidComplete", "total": count, "sent": sent_ok})
    log(f"Raid complete: {sent_ok}/{count} messages sent")


# ─── Voice Call (VC) ───────────────────────────────────────────────────────────

# ─── VC state — raw PCM frames pushed via send_frame() (no ffmpeg/FIFO) ─────────
# The mixed/processed audio is computed ONCE per frame on a single shared pipeline
# and the SAME stereo frame is fanned out to every client concurrently, so all
# clients hear identical, in-sync audio.
SR        = 48000
# WebRTC/ntgcalls consumes audio in 10 ms frames (480 samples @ 48 kHz). Sending
# 20 ms frames made ntgcalls play each as one 10 ms unit → ~2x speed + 50% starve
# (the "sped-up then silence" cycle). MUST be 10 ms.
VC_FRAME  = SR * 10 // 1000     # 10 ms = 480 mono samples per frame

vcPyTgCalls:   dict = {}        # idx -> PyTgCalls instance
vcActivePeers: dict = {}        # idx -> peer_id (signed int)
vcMuted:       set  = set()     # indices that are server-muted (start muted by default)
vcExternalReady: set = set()    # indices whose ntgcalls EXTERNAL audio source is live (safe to send_frame)
vcVideoPresenter = None         # (idx, tmp_path) of the client presenting a video file, or None
# ─── Live media (screen share / video file) → real picture in the call ─────────
# The browser MediaRecorder encodes the picture+sound to webm and streams chunks
# here. The bot runs ITS OWN ffmpeg to transcode that live webm into raw I420
# video + s16le audio, then pushes those frames with send_frame(Device.CAMERA /
# MICROPHONE) — the SAME proven external-frame path the mic uses. (Handing the
# webm straight to pytgcalls/ffmpeg via a FIFO did not work: ntgcalls can't probe
# a live MediaRecorder stream, so play() switched the source — killing the mic —
# but no frames ever flowed.)
VC_VID_W, VC_VID_H, VC_VID_FPS = 1280, 720, 24   # published video size/fps (tunable)
vcMediaProc     = None          # ffmpeg subprocess.Popen (webm → raw I420 + s16le)
vcMediaClient   = None          # idx of the client currently publishing the live video
vcMediaStop     = None          # threading.Event for the pump threads
vcMediaStdinQ   = None          # _queue.Queue of webm byte chunks (→ ffmpeg stdin)
vcMediaThreads  = []            # [stdin writer, video reader, (audio reader)]
vcMediaHasAudio = False         # media carries its own audio (replaces the live mic)
vcMediaUser     = None          # username currently publishing media (one at a time)
# ─── Per-user VC state — the call is MODULAR ──────────────────────────────────
# Every account is owned by exactly ONE user while it's in a call. Each user has
# their OWN audio pipeline, and a user's mic only ever reaches the accounts THEY
# own — no cross-bleed of voice or UI state between users. An account that's in a
# call is LOCKED: nobody else can join with it until it leaves (or an admin kicks
# it). vcOwner is the single source of truth for "who has what".
vcOwner:         dict = {}   # idx -> username that joined this account into a call
vcUserQueue:     dict = {}   # username -> asyncio.Queue of raw mono PCM (browser → processor)
vcUserFrames:    dict = {}   # username -> deque of processed stereo frames (processor → sender)
vcUserProcessor: dict = {}   # username -> VCProcessor (its own filter state)
vcUserEffects:   dict = {}   # username -> effects dict (its own voice settings)
vcUserProcTask:  dict = {}   # username -> processor asyncio.Task
DEFAULT_EFFECTS = {"gain": 1.0, "bass": 0.0, "treble": 0.0,
                   "pitch": 0.0, "robotic": 0.0, "thickness": 0.0,
                   "gate": 0.0, "sharpen": 0.0, "compress": 0.0, "crush": 0.0,
                   "denoise": 0.0}

# ─── Audio pipeline (decoupled: receive → process → send), now PER USER ────────
#   1. handleVCAudio       — enqueue the user's raw mic PCM into THEIR queue.
#   2. _vc_user_processor  — one task per user: runs the numpy DSP in a worker
#      thread (off the loop) and fills that user's jitter buffer.
#   3. _vc_sender_thread   — ONE 10 ms pacer (dedicated OS thread) that walks every
#      user and sends their frame only to the accounts they own. 10 ms is WebRTC's
#      native frame size, so ntgcalls plays it at the right speed.
from concurrent.futures import ThreadPoolExecutor

# Buffer sizes are in FRAMES; frames are 10 ms each.
VC_PREBUF_MIN = 30     # start at ~300 ms of prebuffer
VC_PREBUF_MAX = 200    # grow up to ~2 s if we keep underrunning (auto-tunes to the jitter)
VC_BUF_MAX    = 320    # ~3.2 s hard ceiling — must stay above PREBUF_MAX

vcSenderThread  = None            # DEDICATED OS thread that paces output (see _vc_sender_thread)
vcSenderStop    = None            # threading.Event to stop the sender thread
_vcDspExecutor  = ThreadPoolExecutor(max_workers=2)   # DSP for concurrent users


def _shelf_coeffs(kind, gain_db, fc, sr=SR):
    """RBJ low/high shelf biquad coefficients → (b, a)."""
    A     = 10 ** (gain_db / 40.0)
    w0    = 2 * np.pi * fc / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / 2 * np.sqrt((A + 1 / A) * (1 / 0.9 - 1) + 2)
    two_sqrtA_alpha = 2 * np.sqrt(A) * alpha
    if kind == "low":
        b0 =    A * ((A + 1) - (A - 1) * cw + two_sqrtA_alpha)
        b1 =  2 * A * ((A - 1) - (A + 1) * cw)
        b2 =    A * ((A + 1) - (A - 1) * cw - two_sqrtA_alpha)
        a0 =        (A + 1) + (A - 1) * cw + two_sqrtA_alpha
        a1 =   -2 * ((A - 1) + (A + 1) * cw)
        a2 =        (A + 1) + (A - 1) * cw - two_sqrtA_alpha
    else:  # high shelf
        b0 =    A * ((A + 1) + (A - 1) * cw + two_sqrtA_alpha)
        b1 = -2 * A * ((A - 1) + (A + 1) * cw)
        b2 =    A * ((A + 1) + (A - 1) * cw - two_sqrtA_alpha)
        a0 =        (A + 1) - (A - 1) * cw + two_sqrtA_alpha
        a1 =    2 * ((A - 1) - (A + 1) * cw)
        a2 =        (A + 1) - (A - 1) * cw - two_sqrtA_alpha
    b = np.array([b0, b1, b2]) / a0
    a = np.array([a0, a1, a2]) / a0
    return b, a


def _peak_coeffs(gain_db, fc, Q=1.2, sr=SR):
    """RBJ peaking-EQ biquad → (b, a). Used for the presence 'sharpener' bump."""
    A     = 10 ** (gain_db / 40.0)
    w0    = 2 * np.pi * fc / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * Q)
    b0 = 1 + alpha * A
    b1 = -2 * cw
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cw
    a2 = 1 - alpha / A
    return np.array([b0, b1, b2]) / a0, np.array([a0, a1, a2]) / a0


class _GranularPitch:
    """Length-preserving granular overlap-add pitch shifter (vectorised per grain)."""
    def __init__(self, grain=960):
        self.G   = grain
        self.H   = grain // 2                       # 50% overlap → Hann sums to ~1
        self.win = np.hanning(grain).astype(np.float32)
        self.inbuf  = np.zeros(0, dtype=np.float32)
        self.ola    = np.zeros(grain, dtype=np.float32)
        self.anchor = 0.0                            # fractional input read base

    def process(self, x, ratio):
        if abs(ratio - 1.0) < 1e-3:
            return x
        self.inbuf = np.concatenate([self.inbuf, x])
        out = np.zeros(len(x), dtype=np.float32)
        oi  = 0
        idx_all = np.arange(len(self.inbuf))
        while oi + self.H <= len(x):
            last = self.anchor + (self.G - 1) * ratio
            if last >= len(self.inbuf) - 1:
                break                                # need more input (lookahead)
            read = self.anchor + np.arange(self.G) * ratio
            grain = np.interp(read, idx_all, self.inbuf).astype(np.float32) * self.win
            self.ola[:self.G] += grain
            out[oi:oi + self.H] = self.ola[:self.H]
            self.ola = np.concatenate([self.ola[self.H:], np.zeros(self.H, dtype=np.float32)])
            self.anchor += self.H                    # analysis hop == synthesis hop → 1:1 length
            oi += self.H
        # bound memory: drop fully-consumed input
        consumed = int(self.anchor)
        if consumed > 4 * self.G:
            self.inbuf  = self.inbuf[consumed:]
            self.anchor -= consumed
            idx_all = None
        return out


class SpectralGate:
    """Streaming STFT spectral noise gate (the noisereduce/Sainburg method) + a voice
    band-limit. It estimates a per-FREQUENCY noise floor on the fly and multiplies
    every bin by a smooth mask, so broadband noise and reverb are scrubbed even in the
    gaps BETWEEN the voice harmonics — that's how you get 'only the voice through',
    which a plain time-domain gate can't do. sqrt-Hann @ 50% overlap gives click-free,
    unity reconstruction when the mask is 1 (so it's transparent on clean voice).

    Refs: Sainburg spectral gating; spectral-subtraction with over-subtraction + a
    spectral FLOOR to trade residual noise vs. musical-noise/speech distortion."""
    def __init__(self, n=960, hop=None, lo_hz=60.0, hi_hz=17000.0, sr=SR):
        self.n   = n
        self.hop = hop or (n // 2)                       # 50% overlap
        w = np.hanning(n).astype(np.float64)
        self.win = np.sqrt(np.maximum(w, 0.0)).astype(np.float32)   # applied on analysis AND synthesis
        self.inbuf = np.zeros(n, dtype=np.float32)
        self.ola   = np.zeros(n, dtype=np.float32)
        self.noise = None
        self.pgain = None
        freqs = np.fft.rfftfreq(n, 1.0 / sr)
        # smooth (raised-cosine) band-pass so only the voice band survives — no ringing
        lo0, lo1 = lo_hz * 0.7, lo_hz
        hi0, hi1 = hi_hz, hi_hz * 1.12
        band = np.ones(len(freqs), dtype=np.float32)
        for i, fq in enumerate(freqs):
            if fq <= lo0 or fq >= hi1:
                band[i] = 0.0
            elif fq < lo1:
                band[i] = 0.5 - 0.5 * np.cos(np.pi * (fq - lo0) / (lo1 - lo0))
            elif fq > hi0:
                band[i] = 0.5 + 0.5 * np.cos(np.pi * (fq - hi0) / (hi1 - hi0))
        self.band = band

    def process_hop(self, hop_samples, amount):
        n, hop = self.n, self.hop
        if len(hop_samples) != hop:                      # guard: only handle exact hop frames
            return hop_samples
        # slide the analysis window: drop oldest hop, append the new hop
        self.inbuf[:-hop] = self.inbuf[hop:]
        self.inbuf[-hop:] = hop_samples
        X   = np.fft.rfft(self.inbuf * self.win)
        mag = np.abs(X).astype(np.float32)
        if self.noise is None:
            self.noise = mag.copy()
            self.pgain = np.ones_like(mag)
        # non-stationary per-bin noise floor: fall fast toward the quiet level, rise very
        # slowly (~20 s) so sustained vowels aren't mistaken for noise and ducked.
        self.noise = np.where(mag < self.noise,
                              self.noise + (mag - self.noise) * 0.35,
                              self.noise + (mag - self.noise) * 0.0005).astype(np.float32)
        over  = 1.0 + amount * 3.5                        # over-subtraction (aggressiveness)
        floor = max(0.02, 0.16 - amount * 0.15)           # spectral floor (anti musical-noise)
        gain  = 1.0 - over * self.noise / (mag + 1e-9)
        gain  = np.clip(gain, floor, 1.0).astype(np.float32)
        # smooth the mask over frequency (3-tap) and time → removes musical noise
        gain[1:-1] = 0.25 * gain[:-2] + 0.5 * gain[1:-1] + 0.25 * gain[2:]
        gain = 0.6 * gain + 0.4 * self.pgain
        self.pgain = gain
        y = np.fft.irfft(X * (gain * self.band), n=n).astype(np.float32) * self.win
        self.ola += y
        out = self.ola[:hop].copy()
        self.ola = np.concatenate([self.ola[hop:], np.zeros(hop, dtype=np.float32)])
        return out


class VCProcessor:
    """Single shared audio pipeline: incoming mono PCM → effects → fixed 20 ms stereo frames."""
    def __init__(self):
        self.inbuf   = np.zeros(0, dtype=np.float32)
        self.sgate1  = SpectralGate(n=2 * VC_FRAME)   # voice isolation (pre-boost)
        self.sgate2  = SpectralGate(n=2 * VC_FRAME)   # re-denoise (post-boost)
        self.bass_zi = np.zeros(2, dtype=np.float32)
        self.treb_zi = np.zeros(2, dtype=np.float32)
        self.rm_phase = 0.0
        self.pitch   = _GranularPitch(VC_FRAME)
        # chorus / "thickness" modulated delay line
        self.ch_buf   = np.zeros(int(SR * 0.04), dtype=np.float32)  # 40 ms
        self.ch_wi    = 0
        self.ch_phase = 0.0
        # voice-domination chain state
        self.gate_env = 0.0                                # noise-gate envelope follower
        self.sharp_zi = np.zeros(2, dtype=np.float32)      # presence peak biquad state
        self.air_zi   = np.zeros(2, dtype=np.float32)      # high "air" shelf biquad state
        self.lim_g    = 1.0                                # brick-wall limiter gain (smoothed)
        # 3-band multiband-compressor ("Crush") crossovers, designed once
        if SCIPY_OK:
            self.mb_lp_b, self.mb_lp_a = butter(2, 280.0 / (SR / 2), "low")    # low band
            self.mb_hp_b, self.mb_hp_a = butter(2, 2800.0 / (SR / 2), "high")  # high band
            self.mb_lo_zi = np.zeros(2, dtype=np.float32)
            self.mb_hi_zi = np.zeros(2, dtype=np.float32)
            # Denoise low-cut: gentle 2nd-order @90 Hz — trims hum/rumble without
            # thinning the voice (steeper filtering made it sound hollow).
            self.dn_hp_b, self.dn_hp_a = butter(2, 90.0 / (SR / 2), "high")
            self.dn_hp_zi = np.zeros(2, dtype=np.float32)
        self.dn_env      = 0.0     # fast envelope of the cleaned signal
        self.noise_floor = 0.0     # adaptively-tracked surrounding-noise level (min-follower)
        self.vad_g       = 1.0     # smoothed gate gain (1 = voice, low = gap)
        self._last_g     = 1.0     # gate gain actually applied last frame (for click-free ramp)
        self.gate_open   = True    # gate state-machine (hysteresis prevents chatter)
        self.gate_hold   = 0       # frames left to hold the gate open through a dip

    def feed(self, pcm_mono_bytes, eff):
        """Append incoming mono PCM, return list of processed STEREO int16 frames (20 ms each)."""
        if not NUMPY_OK:
            return [pcm_mono_bytes]   # passthrough if numpy missing (mono)
        x = np.frombuffer(pcm_mono_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self.inbuf = np.concatenate([self.inbuf, x])
        frames = []
        while len(self.inbuf) >= VC_FRAME:
            f = self.inbuf[:VC_FRAME]
            self.inbuf = self.inbuf[VC_FRAME:]
            frames.append(self._process(f, eff))
        return frames

    def _process(self, f, eff):
        try:
            denoise = float(eff.get("denoise", 0.0))
            gate    = float(eff.get("gate", 0.0))
            clean   = max(denoise, gate)
            spec    = clean > 1e-3 and len(f) == VC_FRAME   # spectral gates need exact 10 ms hops

            # ══════════ STAGE 1 — VOICE ISOLATION (spectral): only voice through ══════════
            # Per-frequency spectral gate + voice band-limit: strips broadband noise and
            # reverb even BETWEEN the harmonics. This is the clean base the rest builds on.
            if spec:
                f = self.sgate1.process_hop(f, clean)
                # Decide a voice-activity gate on the CLEAN voice — applied (ramped) at the
                # very end to mute the gaps AFTER the boost has slammed them, so the loudness
                # never comes with amplified hiss. Hysteresis + hold ⇒ it never chops speech.
                inst = float(np.sqrt(np.mean(f * f) + 1e-9))
                self.dn_env += (inst - self.dn_env) * (0.5 if inst > self.dn_env else 0.05)
                if self.noise_floor <= 0 or inst < self.noise_floor:
                    self.noise_floor += (inst - self.noise_floor) * 0.20
                else:
                    self.noise_floor += (inst - self.noise_floor) * 0.0005
                nf = max(self.noise_floor, 1e-5)
                open_thr  = nf * (1.6 + clean * 3.0)
                close_thr = open_thr * 0.45
                if self.gate_open:
                    if self.dn_env < close_thr:
                        if self.gate_hold > 0: self.gate_hold -= 1
                        else:                  self.gate_open = False
                    else:
                        self.gate_hold = 22                       # ~220 ms hold rides word gaps
                elif self.dn_env >= open_thr:
                    self.gate_open = True; self.gate_hold = 22
                g_target = 1.0 if self.gate_open else max(0.0, 0.14 - clean * 0.14)
                self.vad_g += (g_target - self.vad_g) * (0.5 if g_target > self.vad_g else 0.08)
            else:
                self.gate_open = True; self.vad_g = 1.0

            # pitch (deep = negative semitones) on the clean voice
            pitch = float(eff.get("pitch", 0.0))
            if abs(pitch) > 1e-3:
                f = self.pitch.process(f, 2.0 ** (pitch / 12.0))

            # ══════════ STAGE 2 — SHAPE: deep body + presence + crisp air ══════════
            if SCIPY_OK:
                bass = float(eff.get("bass", 0.0))
                if abs(bass) > 1e-3:
                    b, a = _shelf_coeffs("low", bass, 200.0)
                    f, self.bass_zi = lfilter(b, a, f, zi=self.bass_zi)
                treb = float(eff.get("treble", 0.0))
                if abs(treb) > 1e-3:
                    b, a = _shelf_coeffs("high", treb, 3000.0)
                    f, self.treb_zi = lfilter(b, a, f, zi=self.treb_zi)
                # SHARPENER — presence stab @3 kHz (ear's most sensitive band) + an "air"
                # shelf for crisp cut; the saturator below turns these into bright harmonics.
                sharp = float(eff.get("sharpen", 0.0))
                if sharp > 1e-3:
                    b, a = _peak_coeffs(sharp * 20.0, 3000.0, 0.9)
                    f, self.sharp_zi = lfilter(b, a, f, zi=self.sharp_zi)
                    b, a = _shelf_coeffs("high", sharp * 12.0, 6500.0)
                    f, self.air_zi = lfilter(b, a, f, zi=self.air_zi)
            thick = float(eff.get("thickness", 0.0))
            if thick > 1e-3:
                f = self._chorus(f, thick)
            robo = float(eff.get("robotic", 0.0))
            if robo > 1e-3:
                t = (self.rm_phase + np.arange(len(f))) / SR
                carrier = np.sin(2 * np.pi * 70.0 * t).astype(np.float32)
                self.rm_phase = (self.rm_phase + len(f)) % SR
                f = f * (1.0 - robo) + (f * carrier) * robo

            # ══════════ STAGE 3 — BOOST: multiband density + saturation (radio loud) ══════════
            comp = float(eff.get("compress", 0.0))
            if comp > 1e-3:
                p = 1.0 - 0.6 * comp
                f = np.sign(f) * (np.abs(f) ** p)
            # CRUSH — 3-band multiband compressor: crushes low/mid/high dynamics
            # independently (the "dual/multi-band radio" density) then recombines.
            crush = float(eff.get("crush", 0.0))
            if crush > 1e-3 and SCIPY_OK:
                lo, self.mb_lo_zi = lfilter(self.mb_lp_b, self.mb_lp_a, f, zi=self.mb_lo_zi)
                hi, self.mb_hi_zi = lfilter(self.mb_hp_b, self.mb_hp_a, f, zi=self.mb_hi_zi)
                mid = f - lo - hi
                pe  = 1.0 - 0.6 * crush
                lo  = np.sign(lo)  * (np.abs(lo)  ** pe)
                mid = np.sign(mid) * (np.abs(mid) ** pe)
                hi  = np.sign(hi)  * (np.abs(hi)  ** pe)
                f = (lo * 0.95 + mid * 1.15 + hi * 1.2).astype(np.float32)
            g = float(eff.get("gain", 1.0))
            if abs(g - 1.0) > 1e-3:
                f = np.tanh(f * g)   # saturator: odd harmonics = louder + brighter, no hard-clip

            # ══════════ STAGE 4 — RE-DENOISE (spectral): scrub the hiss/harshness the boost
            # just lifted, so the loudness stays clean. This is the second denoise layer. ══════════
            if spec:
                f = self.sgate2.process_hop(f, min(1.0, clean * 0.85))

            # ══════════ STAGE 5 — BRICK-WALL LIMITER: loudness ceiling (broadcast-last) ══════════
            ceil = 0.985
            peak = float(np.max(np.abs(f))) if len(f) else 0.0
            target = (ceil / peak) if peak > ceil else 1.0
            if target < self.lim_g:
                self.lim_g = target                                  # instant attack
            else:
                self.lim_g += (target - self.lim_g) * 0.2            # smooth release
            f = f * self.lim_g

            # ══════════ FINAL GATE — mute the boosted gaps, ramped (no clicks/chopping) ══════════
            g1 = float(self.vad_g)
            if abs(g1 - self._last_g) > 1e-4:
                f = f * np.linspace(self._last_g, g1, len(f), dtype=np.float32)
            elif g1 < 0.999:
                f = f * np.float32(g1)
            self._last_g = g1
        except Exception:
            pass  # never let an effect break the stream — fall through with current f
        mono = np.clip(f, -1.0, 1.0)
        stereo = np.repeat((mono * 32767.0).astype(np.int16), 2)  # L=R interleaved
        return stereo.tobytes()

    def _chorus(self, f, depth):
        n   = len(f)
        buf = self.ch_buf
        L   = len(buf)
        base = SR * 0.018                       # 18 ms base delay
        mod  = SR * 0.006                        # ±6 ms sweep
        ph   = self.ch_phase + np.arange(n) / SR * 2 * np.pi * 0.6   # 0.6 Hz LFO
        delay = base + mod * np.sin(ph)
        # write dry into ring buffer, read delayed (vectorised)
        wpos = (self.ch_wi + np.arange(n)) % L
        buf[wpos] = f
        rpos = (self.ch_wi + np.arange(n) - delay) % L
        r0   = np.floor(rpos).astype(np.int64)
        frac = (rpos - r0).astype(np.float32)
        delayed = buf[r0 % L] * (1 - frac) + buf[(r0 + 1) % L] * frac
        self.ch_wi   = (self.ch_wi + n) % L
        self.ch_phase = (self.ch_phase + n / SR * 2 * np.pi * 0.6) % (2 * np.pi)
        return f * (1.0 - 0.5 * depth) + delayed.astype(np.float32) * (0.5 * depth)


# ─── Per-user VC plumbing ──────────────────────────────────────────────────────
async def _send_user(user, payload):
    """Send a VC message to ONE user's browser(s) only (server.js routes by toUser)."""
    if user:
        payload = {**payload, "toUser": user}
    await sendWs(payload)


async def _broadcast_vc_locks():
    """Tell EVERY browser which accounts are locked (in a call) and by whom, so each
    UI greys them out. No toUser → broadcast."""
    await sendWs({"type": "vcLocks", "locks": dict(vcOwner)})


def _ensure_user_pipeline(user):
    """Create this user's own audio pipeline if they don't have one yet (never
    touches anyone else's state)."""
    if user not in vcUserQueue:
        vcUserQueue[user]     = asyncio.Queue()
        vcUserFrames[user]    = deque()
        vcUserProcessor[user] = VCProcessor() if NUMPY_OK else None
        vcUserEffects[user]   = dict(DEFAULT_EFFECTS)


def _drop_user_pipeline(user):
    """Tear down a user's pipeline once they own no accounts."""
    t = vcUserProcTask.pop(user, None)
    if t is not None:
        t.cancel()
    q = vcUserQueue.pop(user, None)
    if q is not None:
        try: q.put_nowait(None)
        except Exception: pass
    vcUserFrames.pop(user, None)
    vcUserProcessor.pop(user, None)
    vcUserEffects.pop(user, None)


async def _leave_account(idx):
    """Disconnect ONE account from its call and release its lock. Returns the former
    owner (so the caller can notify them)."""
    peer  = vcActivePeers.pop(idx, None)
    calls = vcPyTgCalls.pop(idx, None)
    owner = vcOwner.pop(idx, None)
    vcMuted.discard(idx)
    vcExternalReady.discard(idx)
    if vcMediaClient == idx:          # was presenting media → stop it
        _media_teardown_sync()
    try:
        doc  = sessionsCol.find_one({"index": idx})
        name = doc.get("name", f"#{idx}") if doc else f"#{idx}"
    except Exception:
        name = f"#{idx}"
    if calls is not None and peer is not None:
        try:
            try: await calls.leave_call(peer)
            except AttributeError: await calls.leave_group_call(peer)
        except Exception as e:
            log(f"VC leave error #{idx}: {e}")
    if owner:
        await _send_user(owner, {"type": "vcLeft", "index": idx, "name": name})
    return owner


def _parse_call_link(link):
    """Parse a call link and return the call ID, or None if not a call link.
    Supports: https://t.me/call/ID, t.me/call/ID"""
    m = re.search(r't\.me/call/([\w-]+)', link)
    return m.group(1) if m else None


async def _resolve_call_peer(client, call_id):
    """Resolve a call link to its peer. Tries to find the group/channel that has this call."""
    try:
        # Try to join the call link directly using get_entity
        full_link = f"https://t.me/call/{call_id}"
        entity = await client.get_entity(full_link)
        return entity
    except Exception:
        return None


async def handleVCResolve(msg):
    """Resolve each selected client to the given chat entity and report back.
    For call links, they are treated as ready immediately (no resolution needed)."""
    requested_ids = msg.get("clients", [])
    chat          = (msg.get("chat") or "").strip()

    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}

    # Try to parse as call link first
    call_id = _parse_call_link(chat)

    results = []
    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if not doc or doc["index"] not in activeSessions:
            continue
        idx    = doc["index"]
        name   = doc.get("name", f"#{idx}")

        if call_id:
            # Call links don't need resolution - they're ready immediately
            results.append({"index": idx, "ref": ref, "name": name, "ok": True, "title": f"Call {call_id[:8]}..."})
        else:
            # Resolve chat ID or username
            client = activeSessions[idx]
            chat_ref = chat.lstrip("@")
            try:
                chat_ref = int(chat_ref)
            except ValueError:
                pass

            try:
                entity = await client.get_input_entity(chat_ref)
                full   = await client.get_entity(entity)
                title  = getattr(full, "title", None) or getattr(full, "username", None) or str(chat_ref)
                results.append({"index": idx, "ref": ref, "name": name, "ok": True, "title": title})
            except Exception as e:
                results.append({"index": idx, "ref": ref, "name": name, "ok": False, "error": repr(e) or str(e)})

    await _send_user(msg.get("fromUser"), {"type": "vcResolved", "results": results})


async def handleVCJoin(msg):
    """Join a voice call with each selected account, FOR THIS USER. Accounts already
    in a call (owned by anyone) are LOCKED and skipped. This user gets their own
    audio pipeline — their mic only reaches the accounts they own.
    Supports: chat ID, username, call link (https://t.me/call/ID)"""
    if not PYTGCALLS_OK:
        await sendWs({"type": "vcClientStatus", "index": -1, "status": "failed",
                      "error": "py-tgcalls not installed on bot"})
        return

    global vcSenderThread, vcSenderStop

    user          = msg.get("fromUser") or "?"
    requested_ids = msg.get("clients", [])
    chat          = (msg.get("chat") or "").strip()

    session_docs = list(sessionsCol.find({"isValid": True}))
    id_to_doc    = {str(doc["_id"]): doc for doc in session_docs}

    # Try to parse as call link first
    call_id = _parse_call_link(chat)
    is_call_link = bool(call_id)

    if not is_call_link:
        # Try as chat ID or username
        chat_ref = chat.lstrip("@")
        try:
            chat_ref = int(chat_ref)
        except ValueError:
            pass

    _ensure_user_pipeline(user)   # never wipes anyone else's pipeline

    for ref in requested_ids:
        doc = id_to_doc.get(ref)
        if not doc or doc["index"] not in activeSessions:
            continue
        idx    = doc["index"]
        name   = doc.get("name", f"#{idx}")
        client = activeSessions[idx]

        # ── LOCK: skip accounts already in a call ──
        owner = vcOwner.get(idx)
        if owner is not None and owner != user:
            await _send_user(user, {"type": "vcClientStatus", "index": idx, "name": name,
                                    "status": "failed", "error": f"In use by {owner}"})
            continue
        if owner == user and idx in vcPyTgCalls:
            await _send_user(user, {"type": "vcClientStatus", "index": idx, "name": name,
                                    "status": "joined", "muted": idx in vcMuted})
            continue

        await _send_user(user, {"type": "vcClientStatus", "index": idx, "name": name, "status": "joining"})

        if not PYTGCALLS_EXTERNAL:
            err = "Bot's py-tgcalls is too old — needs v2 with external audio (send_frame)"
            await _send_user(user, {"type": "vcClientStatus", "index": idx, "name": name, "status": "failed", "error": err})
            log(f"VC: #{idx} ({name}) {err}")
            continue

        try:
            if is_call_link:
                # For call links, use raw Telethon API with invite_hash
                # (PyTgCalls v2.3.3 passes public_key which conflicts with slug joins)
                log(f"VC: #{idx} ({name}) joining call {call_id} for {user}")
                calls = PyTgCalls(client)
                await calls.start()

                dummy_id = int.from_bytes(hashlib.md5(call_id.encode()).digest()[:7], 'big')

                # Patch get_input_call to return InputGroupCallSlug
                original_get_input = calls._app._bind_client.get_input_call

                async def _patched_get_input(chat_id, invite_msg_id=None):
                    if chat_id == dummy_id:
                        return InputGroupCallSlug(slug=call_id)
                    return await original_get_input(chat_id, invite_msg_id)

                calls._app._bind_client.get_input_call = _patched_get_input

                # Patch join_group_call to strip public_key/block
                # (v2.3.3 passes these even for non-conference calls)
                original_join_group = calls._app._bind_client.join_group_call

                async def _patched_join_group(chat_id, json_join, video_stopped, join_as, invite_hash=None, *args, **kwargs):
                    return await original_join_group(chat_id, json_join, video_stopped, join_as, invite_hash)

                calls._app._bind_client.join_group_call = _patched_join_group

                config = GroupCallConfig(invite_hash=call_id, auto_start=False)
                await calls.play(dummy_id, MediaStream(ExternalMedia.AUDIO, audio_parameters=AudioQuality.HIGH), config=config)
                peer_id = dummy_id
            else:
                # For chat ID/username, resolve peer first
                log(f"VC: #{idx} ({name}) resolving peer {chat_ref!r} for {user}")
                entity  = await client.get_entity(chat_ref)
                peer_id = get_peer_id(entity)

                calls = PyTgCalls(client)
                await calls.start()
                # External raw-PCM audio source (we push the user's mic frames ourselves).
                await calls.play(peer_id, MediaStream(ExternalMedia.AUDIO, audio_parameters=AudioQuality.HIGH))

            try:
                await calls.mute(peer_id)   # joins MUTED on Telegram's end too
            except Exception as me:
                log(f"VC: #{idx} mute-on-join failed (non-fatal): {me}")

            vcPyTgCalls[idx]   = calls
            vcActivePeers[idx] = peer_id
            vcExternalReady.add(idx)
            vcMuted.add(idx)
            vcOwner[idx]       = user          # LOCK to this user
            await _send_user(user, {"type": "vcClientStatus", "index": idx, "name": name, "status": "joined", "muted": True})
            log(f"VC: #{idx} ({name}) joined by {user} in {chat} (muted)")

        except Exception as e:
            tb  = traceback.format_exc()
            err = str(e) or repr(e) or type(e).__name__
            low = err.lower()
            if "no active" in low or "groupcall" in low or "group call" in low:
                err = "No active voice chat in that group — start a voice chat first"
            await _send_user(user, {"type": "vcClientStatus", "index": idx, "name": name, "status": "failed", "error": err})
            log(f"VC: #{idx} ({name}) join failed: {err}\n{tb}")
            vcPyTgCalls.pop(idx, None); vcActivePeers.pop(idx, None); vcOwner.pop(idx, None)

    # Start this user's processor task + the shared output pacer (one for all users)
    if user in vcUserQueue:
        t = vcUserProcTask.get(user)
        if t is None or t.done():
            vcUserProcTask[user] = asyncio.create_task(_vc_user_processor(user))
    if vcOwner and (vcSenderThread is None or not vcSenderThread.is_alive()):
        vcSenderStop = threading.Event()
        vcSenderThread = threading.Thread(
            target=_vc_sender_thread,
            args=(asyncio.get_running_loop(), vcSenderStop),
            name="vc-sender", daemon=True)
        vcSenderThread.start()
    await _broadcast_vc_locks()


async def _vc_user_processor(user):
    """Stage 2 (one task PER USER): pull that user's raw mic PCM, run the numpy DSP
    in a worker thread (off the loop), and fill THEIR jitter buffer with their own
    voice settings. Each user's filter state is independent → no cross-bleed."""
    loop = asyncio.get_running_loop()
    try:
        while user in vcUserQueue:
            q = vcUserQueue.get(user)
            if q is None:
                break
            try:
                raw = await asyncio.wait_for(q.get(), timeout=0.4)
            except asyncio.TimeoutError:
                if not any(o == user for o in vcOwner.values()):
                    break                                   # user owns nothing → stop
                continue
            if raw is None:
                break
            proc = vcUserProcessor.get(user)
            if proc is None:
                proc = VCProcessor(); vcUserProcessor[user] = proc
            eff = dict(vcUserEffects.get(user, DEFAULT_EFFECTS))
            try:
                frames = await loop.run_in_executor(_vcDspExecutor, proc.feed, raw, eff)
            except Exception as e:
                log(f"VC DSP error ({user}): {e}")
                continue
            fq = vcUserFrames.get(user)
            if fq is not None:
                for f in frames:
                    fq.append(f)
                    while len(fq) > VC_BUF_MAX:
                        fq.popleft()
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log(f"VC processor ({user}) error: {e}")


def _vc_sender_thread(loop, stop):
    """Stage 3: the output pacer — runs on its OWN OS thread, NOT the asyncio loop.

    The bot's event loop is shared with 58 Telethon clients, and asyncio.sleep on
    a busy loop is not precise enough for a 20 ms audio clock — that jitter is what
    the receiver's NetEq turns into the "sped-up then silence" cycle. Here we pace
    with time.perf_counter()/time.sleep() on a dedicated thread (rock-steady,
    immune to loop congestion) and only *dispatch* each send_frame onto the loop
    via run_coroutine_threadsafe, without blocking the clock on it.

    Plus an ADAPTIVE jitter buffer: the prebuffer auto-grows on each underrun (up
    to ~2 s) until playback is gap-free. Periodic logs show it converging."""
    silence   = b"\x00" * (VC_FRAME * 2 * 2)   # 10 ms of stereo s16 silence
    interval  = VC_FRAME / SR                   # 0.01 s
    state     = {}                              # username -> {playing, prebuf}  (per-user jitter buffer)
    sent      = 0

    def _ignore(fut):
        try: fut.exception()
        except Exception: pass

    next_t   = time.perf_counter()
    last_log = next_t
    try:
        while not stop.is_set() and vcOwner:
            # Group this tick's owned accounts by user
            owners = {}
            try:
                for idx, u in list(vcOwner.items()):
                    owners.setdefault(u, []).append(idx)
            except RuntimeError:
                owners = {}

            for user, idxs in owners.items():
                fq = vcUserFrames.get(user)
                if fq is None:
                    continue
                st = state.setdefault(user, {"playing": False, "prebuf": VC_PREBUF_MIN})
                while len(fq) > VC_BUF_MAX:
                    try: fq.popleft()
                    except IndexError: break
                # per-user adaptive jitter buffer
                if not st["playing"]:
                    frame = silence
                    if len(fq) >= st["prebuf"]:
                        st["playing"] = True
                if st["playing"]:
                    try:
                        frame = fq.popleft()
                    except IndexError:
                        frame = silence
                        st["playing"] = False
                        st["prebuf"] = min(st["prebuf"] + 10, VC_PREBUF_MAX)
                # send this user's frame ONLY to the accounts they own
                for idx in idxs:
                    if idx in vcMuted or idx not in vcExternalReady:
                        continue
                    if vcVideoPresenter and idx == vcVideoPresenter[0]:
                        continue
                    if vcMediaClient == idx and vcMediaHasAudio:
                        continue   # media is driving this account's audio
                    peer  = vcActivePeers.get(idx)
                    calls = vcPyTgCalls.get(idx)
                    if peer is None or calls is None:
                        continue
                    try:
                        fut = asyncio.run_coroutine_threadsafe(
                            calls.send_frame(peer, Device.MICROPHONE, frame), loop)
                        fut.add_done_callback(_ignore)
                    except Exception:
                        pass
            sent += 1

            # prune jitter state for users who've left
            for u in list(state.keys()):
                if u not in owners:
                    state.pop(u, None)

            now = time.perf_counter()
            if now - last_log >= 5.0:
                loop.call_soon_threadsafe(log, f"VC pacer: users={len(owners)} accounts={len(vcOwner)} ticks={sent}")
                last_log = now; sent = 0

            # Precise wall-clock pacing on this thread (never send faster than real-time)
            next_t += interval
            sleep_for = next_t - time.perf_counter()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                next_t = time.perf_counter()   # behind → resync; never burst-catch-up
    except Exception as e:
        try: loop.call_soon_threadsafe(log, f"VC sender thread error: {e}")
        except Exception: pass


async def handleVCLeave(msg):
    """Leave the call for the accounts THIS user owns (only theirs — never anyone
    else's). The shared pacer stops only when no account is in any call."""
    global vcSenderThread, vcSenderStop
    user = msg.get("fromUser") or "?"
    mine = [idx for idx, o in list(vcOwner.items()) if o == user]
    for idx in mine:
        await _leave_account(idx)
    if not any(o == user for o in vcOwner.values()):
        _drop_user_pipeline(user)
    if not vcOwner and vcSenderStop is not None:
        vcSenderStop.set(); vcSenderThread = None
    await _broadcast_vc_locks()


async def handleVCAdminLeave(msg):
    """Admin force-leave: kick account(s) out of whatever call they're in, no matter
    who owns them. (Admin-only — also enforced in server.js.)"""
    global vcSenderThread, vcSenderStop
    idxs = []
    if msg.get("all"):
        idxs = list(vcOwner.keys())
    else:
        sel = msg.get("clients")
        if sel:
            docs = {str(d["_id"]): d for d in sessionsCol.find({"isValid": True})}
            for ref in sel:
                d = docs.get(ref)
                if d and d["index"] in vcOwner:
                    idxs.append(d["index"])
        if msg.get("index") is not None:
            try:
                i = int(msg.get("index"))
                if i in vcOwner and i not in idxs:
                    idxs.append(i)
            except (TypeError, ValueError):
                pass
    for idx in idxs:
        await _leave_account(idx)
    # drop pipelines for users who now own nothing
    for u in list(vcUserQueue.keys()):
        if not any(o == u for o in vcOwner.values()):
            _drop_user_pipeline(u)
    if not vcOwner and vcSenderStop is not None:
        vcSenderStop.set(); vcSenderThread = None
    await _broadcast_vc_locks()
    await sendWs({"type": "vcAdminLeftDone", "indices": idxs})
    log(f"VC: admin force-left {idxs}")


async def handleVCAudio(msg):
    """Stage 1 — enqueue the user's raw mic PCM into THEIR queue (no DSP on the loop)."""
    user = msg.get("fromUser") or "?"
    q = vcUserQueue.get(user)
    if q is None:
        return
    data_b64 = msg.get("data", "")
    if not data_b64:
        return
    try:
        raw = base64.b64decode(data_b64)
    except Exception:
        return
    if q.qsize() < 250:   # guard against unbounded growth if we fall behind
        q.put_nowait(raw)


async def handleVCStopAudio(msg):
    """Hard-stop for THIS user: flush their buffers + reset their processor."""
    user = msg.get("fromUser") or "?"
    q = vcUserQueue.get(user)
    if q is not None:
        while not q.empty():
            try: q.get_nowait()
            except Exception: break
    fq = vcUserFrames.get(user)
    if fq is not None:
        fq.clear()
    if user in vcUserProcessor and NUMPY_OK:
        vcUserProcessor[user] = VCProcessor()
    log(f"VC: audio hard-stopped for {user}")


async def handleVCSetEffects(msg):
    """Per-user voice settings (each user's mic is processed with their own)."""
    user = msg.get("fromUser") or "?"
    eff  = vcUserEffects.setdefault(user, dict(DEFAULT_EFFECTS))
    for k in ("gain", "bass", "treble", "pitch", "robotic", "thickness", "gate", "sharpen", "compress", "crush", "denoise"):
        if k in msg:
            try:
                eff[k] = float(msg.get(k))
            except (TypeError, ValueError):
                pass


async def handleVCMuteClients(msg):
    """Mute/unmute clients — only the ones THIS user owns — both server-side (stop
    pushing their frames) AND on Telegram's end (calls.mute/unmute)."""
    user = msg.get("fromUser") or "?"
    async def _apply(i, mute):
        try:
            i = int(i)
        except (TypeError, ValueError):
            return
        if vcOwner.get(i) != user:   # can only mute accounts you own
            return
        if mute:
            vcMuted.add(i)
        else:
            vcMuted.discard(i)
        calls = vcPyTgCalls.get(i)
        peer  = vcActivePeers.get(i)
        if calls is not None and peer is not None:
            try:
                await (calls.mute(peer) if mute else calls.unmute(peer))
            except Exception as e:
                log(f"VC: #{i} {'mute' if mute else 'unmute'} failed (non-fatal): {e}")

    for i in msg.get("mute", []):
        await _apply(i, True)
    for i in msg.get("unmute", []):
        await _apply(i, False)


async def _vc_input_group_call(client, chat_id):
    """Resolve the active InputGroupCall for the chat a client is in."""
    from telethon.tl import functions
    from telethon.tl.types import Channel
    entity = await client.get_entity(chat_id)
    if isinstance(entity, Channel):
        full = await client(functions.channels.GetFullChannelRequest(entity))
    else:
        full = await client(functions.messages.GetFullChatRequest(entity.id))
    return getattr(full.full_chat, "call", None)


async def handleVCCovert(msg):
    """'Magic' covert speak: the account TRANSMITS audio while its Telegram row
    shows the normal self-muted "listening" icon. We turn its media ON (open the
    server frame-gate + pytgcalls unmute) but set the DISPLAY muted flag via a raw
    MTProto EditGroupCallParticipant(muted=True) that pytgcalls never learns about,
    so the two planes stay desynced: looks self-muted, fully heard."""
    from telethon.tl import functions, types
    try:
        idx = int(msg.get("index"))
    except (TypeError, ValueError):
        return
    on   = bool(msg.get("on"))
    user = msg.get("fromUser") or "?"
    if vcOwner.get(idx) != user:   # only your own accounts
        await _send_user(user, {"type": "vcCovertStatus", "index": idx, "on": False, "error": "Not your account"})
        return
    calls  = vcPyTgCalls.get(idx)
    peer   = vcActivePeers.get(idx)
    client = activeSessions.get(idx)
    if calls is None or peer is None or client is None:
        await _send_user(user, {"type": "vcCovertStatus", "index": idx, "on": False, "error": "Client is not in the call"})
        return
    doc  = sessionsCol.find_one({"index": idx})
    name = doc.get("name", f"#{idx}") if doc else f"#{idx}"
    try:
        if on:
            # 1) media ON — open the frame gate + pytgcalls unmute so it transmits
            vcMuted.discard(idx)
            vcExternalReady.add(idx)
            try: await calls.unmute(peer)
            except Exception as ue: log(f"VC covert #{idx} unmute (non-fatal): {ue}")
            # 2) DISPLAY self-muted via raw MTProto (pytgcalls keeps sending)
            ic = await _vc_input_group_call(client, peer)
            if ic is not None:
                await client(functions.phone.EditGroupCallParticipantRequest(
                    call=ic, participant=types.InputPeerSelf(), muted=True))
            await _send_user(user, {"type": "vcCovertStatus", "index": idx, "on": True, "name": name})
            log(f"VC: #{idx} ({name}) COVERT on — transmitting while shown self-muted")
        else:
            # back to a real mute (both planes muted)
            vcMuted.add(idx)
            try: await calls.mute(peer)
            except Exception as me: log(f"VC covert #{idx} mute (non-fatal): {me}")
            await _send_user(user, {"type": "vcCovertStatus", "index": idx, "on": False, "name": name})
            log(f"VC: #{idx} ({name}) covert off")
    except Exception as e:
        err = str(e) or repr(e) or type(e).__name__
        await _send_user(user, {"type": "vcCovertStatus", "index": idx, "on": on, "error": err})
        log(f"VC covert #{idx} failed: {err}")


async def _restore_presenter():
    """Switch the video presenter back to the live mic (external audio) stream and
    delete the temp video file."""
    global vcVideoPresenter
    if not vcVideoPresenter:
        return
    idx, tmp = vcVideoPresenter
    vcVideoPresenter = None
    vcExternalReady.discard(idx)   # source is being re-created — don't send until it's back
    calls = vcPyTgCalls.get(idx)
    peer  = vcActivePeers.get(idx)
    if calls is not None and peer is not None:
        try:
            await calls.play(peer, MediaStream(ExternalMedia.AUDIO, audio_parameters=AudioQuality.HIGH))
            await calls.mute(peer)
            vcMuted.add(idx)
            vcExternalReady.add(idx)   # external audio source live again → safe to send_frame
        except Exception as e:
            log(f"VC: restore presenter #{idx} failed: {e}")
    try: os.unlink(tmp)
    except Exception: pass


async def handleVCPlayVideo(msg):
    """Stream a video FILE (audio+video) into the call through ONE 'presenter'
    account. The bot writes the upload to a temp file and pytgcalls + ffmpeg play
    it; the presenter is excluded from the mic fan-out while presenting."""
    global vcVideoPresenter
    if not PYTGCALLS_OK or not vcPyTgCalls:
        await sendWs({"type": "vcVideoStatus", "playing": False, "error": "No clients are in a call"})
        return
    try:
        idx = int(msg.get("presenter"))
    except (TypeError, ValueError):
        idx = next(iter(vcPyTgCalls.keys()), None)
    if idx not in vcPyTgCalls:
        await sendWs({"type": "vcVideoStatus", "playing": False, "error": "Presenter is not in the call"})
        return

    data_b64 = msg.get("data", "")
    try:
        raw = base64.b64decode(data_b64.split(",", 1)[1] if "," in data_b64 else data_b64)
    except Exception:
        await sendWs({"type": "vcVideoStatus", "playing": False, "error": "Bad video data"})
        return
    if not raw:
        await sendWs({"type": "vcVideoStatus", "playing": False, "error": "Empty video"})
        return

    await _restore_presenter()   # stop any current video first

    tmp = tempfile.mktemp(suffix=".mp4")
    with open(tmp, "wb") as f:
        f.write(raw)
    calls = vcPyTgCalls[idx]
    peer  = vcActivePeers[idx]
    doc   = sessionsCol.find_one({"index": idx})
    name  = doc.get("name", f"#{idx}") if doc else f"#{idx}"
    # Pull the presenter OUT of the mic fan-out BEFORE swapping its stream, so the
    # sender thread can't send_frame into a source that no longer exists.
    vcExternalReady.discard(idx)
    vcVideoPresenter = (idx, tmp)
    try:
        await calls.play(peer, MediaStream(tmp))     # ffmpeg streams audio + video
        await calls.unmute(peer)                     # presenter transmits the video's audio
        vcMuted.discard(idx)
        await sendWs({"type": "vcVideoStatus", "playing": True, "presenter": idx, "name": name})
        log(f"VC: #{idx} ({name}) presenting video ({len(raw)} bytes)")
    except Exception as e:
        err = str(e) or repr(e) or type(e).__name__
        try: await _restore_presenter()   # vcVideoPresenter is set → restores audio + unlinks tmp
        except Exception: pass
        await sendWs({"type": "vcVideoStatus", "playing": False, "error": err})
        log(f"VC play video #{idx} failed: {err}")


async def handleVCStopVideo(msg):
    """Stop the video presentation and return the presenter to the live mic."""
    presenter = vcVideoPresenter[0] if vcVideoPresenter else None
    await _restore_presenter()
    await sendWs({"type": "vcVideoStatus", "playing": False, "presenter": presenter})


# ─── Live media (screen share / video file): webm → ffmpeg → raw frames → call ──

def _read_exact(src, n, stop, is_fd=False):
    """Read EXACTLY n bytes from a file object or fd, accumulating across short
    reads. Returns None on EOF/error/stop — the caller treats that as end-of-stream."""
    buf = bytearray()
    while len(buf) < n and not stop.is_set():
        try:
            chunk = os.read(src, n - len(buf)) if is_fd else src.read(n - len(buf))
        except Exception:
            return None
        if not chunk:
            return None
        buf += chunk
    return bytes(buf) if len(buf) == n else None


def _ignore_fut(fut):
    try: fut.exception()
    except Exception: pass


def _media_stdin_writer(proc, q, stop):
    """Pump the browser's webm chunks into ffmpeg's stdin."""
    try:
        while not stop.is_set():
            try:
                chunk = q.get(timeout=0.5)
            except _queue.Empty:
                continue
            if chunk is None:
                break
            try:
                proc.stdin.write(chunk)
            except (BrokenPipeError, ValueError, OSError):
                break
    finally:
        try: proc.stdin.close()      # EOF → ffmpeg flushes and exits
        except Exception: pass


def _media_video_reader(proc, calls, peer, loop, stop, w, h, fps):
    """Read raw I420 frames from ffmpeg's stdout and push them as CAMERA video.
    A full frame (~1.4 MB @720p) dwarfs the 64 KB pipe buffer, so we must drain
    stdout continuously — never sleep mid-stream or ffmpeg blocks on its write,
    which would also stall the audio output. The source is already real-time
    (captureStream@1x / live screen), so ffmpeg self-paces to the frame rate."""
    frame_bytes = w * h * 3 // 2
    logged = [False]
    def _cb(fut):
        try:
            fut.exception()
        except Exception as e:
            if not logged[0]:
                logged[0] = True
                loop.call_soon_threadsafe(log, f"VC media: video send_frame error: {e!r}")
    sent = 0
    last_log = time.perf_counter()
    try:
        while not stop.is_set():
            frame = _read_exact(proc.stdout, frame_bytes, stop)
            if frame is None:
                break
            try:
                fut = asyncio.run_coroutine_threadsafe(
                    calls.send_frame(peer, Device.CAMERA, frame,
                                     Frame.Info(width=w, height=h)), loop)
                fut.add_done_callback(_cb)
                sent += 1
            except Exception as e:
                if not logged[0]:
                    logged[0] = True
                    loop.call_soon_threadsafe(log, f"VC media: video dispatch error: {e!r}")
            now = time.perf_counter()
            if now - last_log >= 5.0:
                loop.call_soon_threadsafe(log, f"VC media: video frames sent={sent} ({w}x{h})")
                sent = 0; last_log = now
    finally:
        try: proc.stdout.close()
        except Exception: pass


def _media_stderr_logger(proc, loop):
    """Surface ffmpeg's error output in the bot log (it runs at -loglevel error)."""
    try:
        for line in iter(proc.stderr.readline, b""):
            if not line:
                break
            try:
                loop.call_soon_threadsafe(log, "VC media ffmpeg: " + line.decode("utf-8", "replace").rstrip())
            except Exception:
                pass
    except Exception:
        pass
    finally:
        try: proc.stderr.close()
        except Exception: pass


def _media_audio_reader(aud_fd, calls, peer, loop, stop):
    """Read s16le audio from ffmpeg and push it as MICROPHONE (the media's own
    sound — used instead of the live mic while it has audio)."""
    chunk_bytes = VC_FRAME * 2 * 2   # 10 ms stereo s16
    try:
        while not stop.is_set():
            data = _read_exact(aud_fd, chunk_bytes, stop, is_fd=True)
            if data is None:
                break
            try:
                fut = asyncio.run_coroutine_threadsafe(
                    calls.send_frame(peer, Device.MICROPHONE, data), loop)
                fut.add_done_callback(_ignore_fut)
            except Exception:
                pass
    finally:
        try: os.close(aud_fd)
        except Exception: pass


def _media_teardown_sync():
    """Stop ffmpeg + the pump threads (no call interaction). Returns the publishing
    idx, or None. Safe to call from the loop or on leave."""
    global vcMediaProc, vcMediaClient, vcMediaStop, vcMediaStdinQ, vcMediaThreads, vcMediaHasAudio, vcMediaUser
    idx = vcMediaClient
    vcMediaClient = None
    vcMediaUser   = None
    if vcMediaStop is not None:
        vcMediaStop.set()
    if vcMediaStdinQ is not None:
        try: vcMediaStdinQ.put_nowait(None)
        except Exception: pass
    proc = vcMediaProc
    vcMediaProc = None
    if proc is not None:
        try:
            if proc.stdin: proc.stdin.close()
        except Exception: pass
        try: proc.terminate()
        except Exception: pass
    vcMediaStop = None; vcMediaStdinQ = None; vcMediaThreads = []; vcMediaHasAudio = False
    return idx


async def _stop_media():
    """Tear down the live media and put the presenter back on an audio-only stream."""
    idx = _media_teardown_sync()
    if idx is not None:
        calls = vcPyTgCalls.get(idx); peer = vcActivePeers.get(idx)
        if calls is not None and peer is not None:
            vcExternalReady.discard(idx)
            try:
                await calls.play(peer, MediaStream(ExternalMedia.AUDIO, audio_parameters=AudioQuality.HIGH))
                await calls.mute(peer); vcMuted.add(idx); vcExternalReady.add(idx)
            except Exception as e:
                log(f"VC media: restore #{idx} failed: {e}")


async def handleVCMediaStart(msg):
    """Publish a LIVE picture (screen share / playing video file) on an unmuted
    client. The browser streams webm chunks; the bot's own ffmpeg transcodes them
    to raw I420 video + s16le audio, pushed via send_frame() — the actual picture
    shows up in the call, not just the audio."""
    global vcMediaProc, vcMediaClient, vcMediaStop, vcMediaStdinQ, vcMediaThreads, vcMediaHasAudio, vcMediaUser
    user = msg.get("fromUser") or "?"
    if not PYTGCALLS_OK or not PYTGCALLS_EXTERNAL or VideoParameters is None:
        await _send_user(user, {"type": "vcMediaStatus", "playing": False,
                      "error": "Bot's py-tgcalls is too old for video (needs v2 external frames)"})
        return
    # one media publisher at a time — don't let a user clobber another's screen share
    if vcMediaUser is not None and vcMediaUser != user:
        await _send_user(user, {"type": "vcMediaStatus", "playing": False,
                      "error": f"Screen/video is in use by {vcMediaUser}"})
        return
    await _stop_media()
    # publish on one of THIS user's own, unmuted accounts
    idx = next((i for i, o in vcOwner.items() if o == user and i not in vcMuted), None)
    if idx is None:
        await _send_user(user, {"type": "vcMediaStatus", "playing": False,
                      "error": "Unmute one of your accounts first — it shows the screen/video"})
        return

    has_audio = bool(msg.get("hasAudio", True))
    w, h, fps = VC_VID_W, VC_VID_H, VC_VID_FPS
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-fflags", "+nobuffer+genpts", "-flags", "low_delay",
           "-probesize", "500000", "-analyzeduration", "500000",
           "-i", "pipe:0",
           "-an", "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "yuv420p",
           "-vf", vf, "-r", str(fps), "pipe:1"]
    aud_r = aud_w = None
    pass_fds = ()
    if has_audio:
        aud_r, aud_w = os.pipe()
        os.set_inheritable(aud_w, True)
        cmd += ["-vn", "-map", "0:a:0?", "-f", "s16le", "-ar", str(SR), "-ac", "2", f"pipe:{aud_w}"]
        pass_fds = (aud_w,)
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, pass_fds=pass_fds, bufsize=0)
    except Exception as e:
        if aud_r is not None:
            try: os.close(aud_r); os.close(aud_w)
            except Exception: pass
        await _send_user(user, {"type": "vcMediaStatus", "playing": False, "error": f"ffmpeg launch failed: {e}"})
        return
    if has_audio:
        try: os.close(aud_w)          # parent keeps only the read end
        except Exception: pass

    calls = vcPyTgCalls[idx]; peer = vcActivePeers[idx]
    loop  = asyncio.get_running_loop()
    vcExternalReady.discard(idx)      # recreating the source — pause the mic fan-out to it
    try:
        await calls.play(peer, MediaStream(
            ExternalMedia.AUDIO | ExternalMedia.VIDEO,
            audio_parameters=AudioQuality.HIGH,
            video_parameters=VideoParameters(w, h, fps)))
        await calls.unmute(peer); vcMuted.discard(idx)
    except Exception as e:
        err = str(e) or repr(e) or type(e).__name__
        try: proc.terminate()
        except Exception: pass
        if aud_r is not None:
            try: os.close(aud_r)
            except Exception: pass
        await _send_user(user, {"type": "vcMediaStatus", "playing": False, "error": err})
        log(f"VC media start #{idx} play failed: {err}")
        return
    await asyncio.sleep(0.25)         # let ntgcalls bring the external sources up

    stop = threading.Event()
    q    = _queue.Queue(maxsize=600)
    vcMediaProc = proc; vcMediaClient = idx; vcMediaStop = stop
    vcMediaStdinQ = q;  vcMediaHasAudio = has_audio; vcMediaUser = user
    t_in  = threading.Thread(target=_media_stdin_writer, args=(proc, q, stop),
                             name="vc-media-in", daemon=True)
    t_vid = threading.Thread(target=_media_video_reader, args=(proc, calls, peer, loop, stop, w, h, fps),
                             name="vc-media-vid", daemon=True)
    t_err = threading.Thread(target=_media_stderr_logger, args=(proc, loop),
                             name="vc-media-err", daemon=True)
    vcMediaThreads = [t_in, t_vid, t_err]
    t_in.start(); t_vid.start(); t_err.start()
    if has_audio:
        t_aud = threading.Thread(target=_media_audio_reader, args=(aud_r, calls, peer, loop, stop),
                                 name="vc-media-aud", daemon=True)
        vcMediaThreads.append(t_aud); t_aud.start()
    else:
        vcExternalReady.add(idx)      # no media audio → keep the live mic on this client
    await _send_user(user, {"type": "vcMediaStatus", "playing": True, "index": idx})
    log(f"VC media: live {'A/V' if has_audio else 'video'} → #{idx} ({w}x{h}@{fps}) for {user}")


async def handleVCMediaChunk(msg):
    """A webm chunk from the browser → feed it to ffmpeg's stdin (only from the user
    who owns the current media stream)."""
    if vcMediaStdinQ is None or (msg.get("fromUser") or "?") != vcMediaUser:
        return
    data = msg.get("data", "")
    try:
        raw = base64.b64decode(data)
    except Exception:
        return
    if not raw:
        return
    try:
        vcMediaStdinQ.put_nowait(raw)
    except _queue.Full:
        pass   # drop if we're behind — keeps latency bounded


async def handleVCMediaStop(msg):
    user = msg.get("fromUser") or "?"
    if vcMediaUser is not None and vcMediaUser != user:
        return                       # not your media
    await _stop_media()
    await _send_user(user, {"type": "vcMediaStatus", "playing": False})


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
        self.noRepeat    = bool(payload.get("noRepeat", False))
        self.lastIdx     = None
        self.logs        = {}

    def pickClientIdx(self):
        """Pick a random client index, avoiding repeats if noRepeat is enabled."""
        n = len(self.clients)
        if n == 1:
            return 0
        if self.noRepeat and self.lastIdx is not None:
            candidates = [i for i in range(n) if i != self.lastIdx]
            idx = random.choice(candidates)
        else:
            idx = random.randint(0, n - 1)
        self.lastIdx = idx
        return idx

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

            idx        = self.pickClientIdx()
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

            idx        = self.pickClientIdx()
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
        "addSessionBatch":     handleAddSessionBatch,
        "randomizeNames":      handleRandomizeNames,
        "randomizeAvatars":    handleRandomizeAvatars,
        "bulkProfile":         handleBulkProfile,
        "aiFetchTelegram":     handleAiFetchTelegram,
        "sendCode":            handleSendCode,
        "confirmCode":         handleConfirmCode,
        "submit2fa":           handleSubmit2fa,
        "startReport":         handleStartReport,
        "stopReport":          handleStopReport,
        # bot controls
        "reloadSessions":      handleReloadSessions,
        "getBotStatus":        handleGetBotStatus,
        "startSession":        handleStartSession,
        "disconnectSession":   handleDisconnectSession,
        # social
        "joinChat":            handleJoinChat,
        "leaveChat":           handleLeaveChat,
        "raid":                handleRaid,
        # profile
        "renameAccount":       handleRenameAccount,
        "getProfile":          handleGetProfile,
        "editProfile":         handleEditProfile,
        "fetchOtp":            handleFetchOtp,
        # voice call
        "vcResolve":           handleVCResolve,
        "vcJoin":              handleVCJoin,
        "vcLeave":             handleVCLeave,
        "vcAdminLeave":        handleVCAdminLeave,
        "vcAudio":             handleVCAudio,
        "vcStopAudio":         handleVCStopAudio,
        "vcPlayVideo":         handleVCPlayVideo,
        "vcStopVideo":         handleVCStopVideo,
        "vcMediaStart":        handleVCMediaStart,
        "vcMediaChunk":        handleVCMediaChunk,
        "vcMediaStop":         handleVCMediaStop,
        "vcSetEffects":        handleVCSetEffects,
        "vcMuteClients":       handleVCMuteClients,
        "vcCovert":            handleVCCovert,
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
            # max_size defaults to 1 MB, which silently drops big browser→bot messages
            # (e.g. a bulk .session upload of a whole folder) and stalls the batch.
            # Raise to 128 MB so large batches go through.
            async with websockets.connect(url, ping_interval=20, ping_timeout=10,
                                          max_size=128 * 1024 * 1024) as ws:
                wsConnection = ws
                log("Connected to server")
                # Send botReady with current session count so browsers get it immediately
                await ws.send(json.dumps({
                    "type": "botReady",
                    "sessionCount": len(activeSessions),
                    "activeSessions": list(activeSessions.keys()),
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


async def _keepAliveSessions():
    """Ping each active session every 4 minutes to prevent Telegram from dropping idle connections."""
    while True:
        await asyncio.sleep(240)
        for idx, client in list(activeSessions.items()):
            try:
                await asyncio.wait_for(client.get_me(), timeout=10)
            except Exception:
                pass


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main():
    # Suppress asyncio's "Task was destroyed but pending" noise from Telethon cleanup
    loop = asyncio.get_running_loop()
    def _silent_exception_handler(loop, context):
        msg = context.get("message", "")
        exc = context.get("exception")
        if "Task was destroyed" in msg:
            return
        if isinstance(exc, RuntimeError) and "GeneratorExit" in str(exc):
            return
        loop.default_exception_handler(context)
    loop.set_exception_handler(_silent_exception_handler)

    try:
        await loadSessionsFromDb()
    except Exception as e:
        log(f"loadSessionsFromDb failed (will keep running, sessions can be synced later): {e}")
        traceback.print_exc()

    asyncio.create_task(_keepAliveSessions())
    await connectAndListen()   # never returns — has its own reconnect loop


if __name__ == "__main__":
    # Outer guard: connectAndListen loops forever, but if anything ever escapes
    # (e.g. a fatal during startup), the supervisor restarts the process.
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log(f"FATAL: bot crashed at top level: {e}")
        traceback.print_exc()
        sys.exit(1)
