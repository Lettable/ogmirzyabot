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

  const wss = new WebSocketServer({ server, path: "/ws" })

  wss.on("connection", async (ws, req) => {
    const params = new URL(req.url, "http://localhost").searchParams
    const token = params.get("token")
    const clientType = params.get("type") // "bot" or "browser"

    if (clientType === "bot") {
      if (token !== BOT_SECRET) {
        ws.close(1008, "Unauthorized")
        return
      }
      botSocket = ws
      console.log("[WS] Bot connected")

      ws.on("message", (raw) => {
        let msg
        try { msg = JSON.parse(raw) } catch { return }
        handleBotMessage(msg)
      })

      ws.on("close", () => {
        botSocket = null
        console.log("[WS] Bot disconnected")
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

      // Bot ready — broadcast botStatus so browsers immediately get session count
      case "botReady":
        broadcast({ type: "botStatus", online: true, sessionCount: msg.sessionCount ?? 0 })
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

      default:
        broadcast(msg)
    }
  }

  // ─── Messages from browser → forward to bot ─────────────────────────────────

  function handleBrowserMessage(msg, username, ws) {
    const { type } = msg

    const botCommands = [
      "addSession",
      "sendCode",
      "confirmCode",
      "submit2fa",
      "startReport",
      "stopReport",
      "reloadSessions",
      "getBotStatus",
      "disconnectSession",
      "joinChat",
      "leaveChat",
      "renameAccount",
      "editProfile",
    ]

    if (botCommands.includes(type)) {
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

  server.listen(PORT, () => {
    console.log(`> Ready on http://localhost:${PORT}`)
  })
})
