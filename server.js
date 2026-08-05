require("dotenv").config()
const { createServer } = require("http")
const { parse } = require("url")
const next = require("next")
const { WebSocketServer, WebSocket } = require("ws")
const { jwtVerify } = require("jose")
const { MongoClient } = require("mongodb")

// ─── DB helper ───────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ogomtro"
let _mongoClient = null
let _db = null
async function getDb() {
  if (!_db) {
    _mongoClient = new MongoClient(MONGODB_URI)
    await _mongoClient.connect()
    _db = _mongoClient.db()
  }
  return _db
}

// Track progress log index per hash
const logCounters = new Map()

const dev = process.env.NODE_ENV !== "production"
const app = next({ dev })
const handle = app.getRequestHandler()

const JWT_SECRET = process.env.JWT_SECRET || "changeme_set_in_env"
const BOT_SECRET = process.env.BOT_SECRET || "changeme_bot_secret"
const PORT = parseInt(process.env.PORT || "3000", 10)

// Connected clients
// bot: single WebSocket connection from telegram.py
// browsers: map of username -> WebSocket
let botSocket = null
const browserSockets = new Map() // username -> ws

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function broadcast(data) {
  for (const ws of browserSockets.values()) {
    send(ws, data)
  }
}

// Route a bot→browser message: if it carries a `toUser`, deliver ONLY to that
// user's socket(s) (per-user VC isolation); otherwise broadcast to everyone.
function route(data) {
  if (data && data.toUser) {
    const ws = browserSockets.get(data.toUser)
    if (ws) send(ws, data)
  } else {
    broadcast(data)
  }
}

function sendToBot(data) {
  if (botSocket && botSocket.readyState === WebSocket.OPEN) {
    send(botSocket, data)
    return true
  }
  return false
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })

  // 128 MB payload cap (matches the bot's max_size) so bulk .session folder
  // uploads aren't dropped. Default ws maxPayload is 100 MB.
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 128 * 1024 * 1024 })

  wss.on("connection", async (ws, req) => {
    const params = new URL(req.url, "http://localhost").searchParams
    const token = params.get("token")
    const clientType = params.get("type") // "bot" or "browser"

    if (clientType === "bot") {
      if (token !== BOT_SECRET) {
        ws.close(1008, "Unauthorized")
        return
      }
      // A previous bot socket may still be lingering (half-open). Replace it.
      const prev = botSocket
      botSocket = ws
      ws.isAlive = true
      ws.on("pong", () => { ws.isAlive = true })
      if (prev && prev !== ws) { try { prev.terminate() } catch {} }
      console.log("[WS] Bot connected")
      // Tell all browsers the bot came online immediately
      broadcast({ type: "botStatus", online: true })

      ws.on("message", (raw) => {
        let msg
        try { msg = JSON.parse(raw) } catch { return }
        handleBotMessage(msg)
      })

      ws.on("close", () => {
        // Only react if THIS socket is still the active one. On reconnect the new
        // socket has already replaced botSocket, so a stale close must not null it
        // out or broadcast offline (that caused false "bot stopped" flapping).
        if (botSocket === ws) {
          botSocket = null
          console.log("[WS] Bot disconnected")
          broadcast({ type: "botStatus", online: false, activeSessions: [] })
        } else {
          console.log("[WS] Stale bot socket closed (ignored)")
        }
      })

      return
    }

    // Browser client
    if (clientType === "browser") {
      let decoded
      try {
        const secret = new TextEncoder().encode(JWT_SECRET)
        const result = await jwtVerify(token, secret)
        decoded = result.payload
      } catch {
        ws.close(1008, "Unauthorized")
        return
      }

      const username = decoded.username
      // Capture capabilities so bot commands are enforced server-side, not just
      // hidden in the UI. Admins implicitly have every perk; null = legacy = all.
      ws._isAdmin = !!decoded.isAdmin
      ws._perks   = Array.isArray(decoded.perks) ? decoded.perks : null
      browserSockets.set(username, ws)
      console.log(`[WS] Browser connected: ${username}`)

      ws.on("message", (raw) => {
        let msg
        try { msg = JSON.parse(raw) } catch { return }
        handleBrowserMessage(msg, username, ws)
      })

      ws.on("close", () => {
        browserSockets.delete(username)
        console.log(`[WS] Browser disconnected: ${username}`)
      })

      send(ws, { type: "connected", botOnline: botSocket !== null })
      // If bot is online, ask it for current status so this new browser gets activeSessions
      if (botSocket && botSocket.readyState === WebSocket.OPEN) {
        send(botSocket, { type: "getBotStatus" })
      }
      return
    }

    ws.close(1008, "Unknown client type")
  })

  // ─── Messages from bot → forward to browsers ────────────────────────────────

  function handleBotMessage(msg) {
    const { type } = msg

    switch (type) {
      // Session validation result — send to all browsers (admin sees it in dialog)
      case "sessionResult":
      case "codeRequested":
      case "tfaRequired":
        broadcast(msg)
        break

      // Report progress — forward to browsers and persist to DB
      case "reportProgress":
        broadcast(msg)
        if (msg.hash) {
          const counter = (logCounters.get(msg.hash) || 0)
          logCounters.set(msg.hash, counter + 1)
          getDb().then(db => {
            const logEntry = {
              client:    msg.client    || msg.clientName || null,
              worked:    !!msg.worked,
              msgIds:    Array.isArray(msg.msgIds) ? msg.msgIds : (msg.messageId ? [msg.messageId] : null),
              reason:    msg.reason    || null,
              format:    msg.format    || null,
              error:     msg.error     || null,
              time:      msg.time      || null,
              savedAt:   new Date(),
            }
            db.collection("reports")
              .updateOne({ hash: msg.hash }, { $set: { [`logs.${counter}`]: logEntry } })
              .catch(console.error)
          }).catch(console.error)
        }
        break

      case "reportComplete":
        broadcast(msg)
        if (msg.hash) {
          logCounters.delete(msg.hash)
          getDb().then(db => {
            const update = {
              status:      msg.failed ? "failed" : "completed",
              completedAt: new Date(),
            }
            db.collection("reports")
              .updateOne({ hash: msg.hash }, { $set: update })
              .catch(console.error)
          }).catch(console.error)
        }
        break

      // Bot ready — forward full payload so browsers get activeSessions
      case "botReady":
        broadcast({
          type:           "botStatus",
          online:         true,
          sessionCount:   msg.sessionCount ?? 0,
          activeSessions: msg.activeSessions ?? null,
        })
        break

      // botStatus carries sessionCount, activeReports, reloadResult etc.
      case "botStatus":
        broadcast(msg)
        break

      // Join / Leave progress
      case "joinProgress":
      case "joinComplete":
      case "joinError":
      case "leaveProgress":
      case "leaveComplete":
      case "leaveError":
        broadcast(msg)
        break

      // Rename account confirmation
      case "renameResult":
        broadcast(msg)
        break

      case "editProfileResult":
        broadcast(msg)
        break

      case "raidProgress":
      case "raidComplete":
      case "vcResolved":
      case "vcClientStatus":
      case "vcLeft":
      case "profileData":
      case "startSessionResult":
        route(msg)   // VC ones carry toUser → that user only; others have none → broadcast
        break

      default:
        route(msg)   // vcMediaStatus/vcCovertStatus carry toUser; vcLocks/vcAdminLeftDone broadcast
    }
  }

  // ─── Messages from browser → forward to bot ─────────────────────────────────

  function handleBrowserMessage(msg, username, ws) {
    const { type } = msg

    const botCommands = [
      "addSession",
      "addSessionBatch",
      "randomizeNames",
      "randomizeAvatars",
      "bulkProfile",
      "aiFetchTelegram",
      "sendCode",
      "confirmCode",
      "submit2fa",
      "startReport",
      "stopReport",
      "reloadSessions",
      "getBotStatus",
      "disconnectSession",
      "startSession",
      "joinChat",
      "leaveChat",
      "renameAccount",
      "getProfile",
      "editProfile",
      "fetchOtp",
      "raid",
      "vcResolve",
      "vcJoin",
      "vcLeave",
      "vcAdminLeave",
      "vcAudio",
      "vcStopAudio",
      "vcPlayVideo",
      "vcStopVideo",
      "vcMediaStart",
      "vcMediaChunk",
      "vcMediaStop",
      "vcSetEffects",
      "vcMuteClients",
      "vcCovert",
    ]

    if (botCommands.includes(type)) {
      // ── Per-user perk enforcement ──────────────────────────────────────────
      // Map each command to the capability it needs. "admin" = admins only;
      // null = available to any authorized user (harmless / needed by all).
      const PERM = {
        joinChat: "join", leaveChat: "join",
        raid: "raid",
        vcResolve: "vc", vcJoin: "vc", vcLeave: "vc", vcAudio: "vc", vcStopAudio: "vc",
        vcPlayVideo: "vc", vcStopVideo: "vc", vcMediaStart: "vc", vcMediaChunk: "vc",
        vcMediaStop: "vc", vcSetEffects: "vc", vcMuteClients: "vc", vcCovert: "vc",
        vcAdminLeave: "admin",
        randomizeNames: "profile", randomizeAvatars: "profile", bulkProfile: "profile",
        getProfile: "profile", editProfile: "profile", renameAccount: "profile", fetchOtp: "profile",
        aiFetchTelegram: "ai",
        startReport: "report", stopReport: "report",
        addSession: "admin", addSessionBatch: "admin", reloadSessions: "admin", disconnectSession: "admin",
        // startSession / getBotStatus: any authorized user (needed to use accounts)
      }
      const need = PERM[type]
      if (need) {
        const allowed = ws._isAdmin || (need !== "admin" && (ws._perks === null || ws._perks.includes(need)))
        if (!allowed) {
          send(ws, { type: "error", message: "You don't have permission for this action" })
          return
        }
      }
      const forwarded = sendToBot({ ...msg, fromUser: username })
      if (!forwarded) {
        send(ws, { type: "error", message: "Bot is offline" })
      }
      return
    }

    // ping
    if (type === "ping") {
      send(ws, { type: "pong", botOnline: botSocket !== null })
    }
  }

  // Heartbeat: ping the bot socket every 30s; if it missed the previous pong the
  // connection is dead/half-open — terminate it so the bot's reconnect takes over.
  setInterval(() => {
    const ws = botSocket
    if (!ws) return
    if (ws.isAlive === false) {
      console.log("[WS] Bot heartbeat timeout — terminating stale socket")
      try { ws.terminate() } catch {}
      return
    }
    ws.isAlive = false
    try { ws.ping() } catch {}
  }, 30000)

  server.listen(PORT, () => {
    console.log(`> Ready on http://localhost:${PORT}`)
  })
})
