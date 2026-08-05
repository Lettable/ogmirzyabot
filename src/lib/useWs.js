"use client"
import { useEffect, useRef, useState, useCallback } from "react"

const PING_INTERVAL = 20000  // 20s — keeps status fresh and the WS alive through idle proxies

export function useWs() {
  const wsRef = useRef(null)
  const [botOnline, setBotOnline]                 = useState(false)
  const [connected, setConnected]                 = useState(false)
  const [botSessionCount, setBotSessionCount]     = useState(null)
  const [botActiveReports, setBotActiveReports]   = useState(0)
  const [botActiveSessions, setBotActiveSessions] = useState(null) // array of active indices, null = unknown
  const listenersRef = useRef([]) // [{ type, handler }]
  const pingTimerRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const mountedRef = useRef(true)
  const attemptsRef = useRef(0)

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null
    if (!token) return

    const protocol = window.location.protocol === "https:" ? "wss" : "ws"
    const url = `${protocol}://${window.location.host}/ws?type=browser&token=${token}`

    function connect() {
      if (!mountedRef.current) return
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        attemptsRef.current = 0
        setConnected(true)
        clearInterval(pingTimerRef.current)
        // Heartbeat — keeps the WS alive AND refreshes bot status every 20s, so the
        // status stays accurate even if the tab is left idle for a long time.
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }))
        }, PING_INTERVAL)
      }

      ws.onclose = () => {
        setConnected(false)
        setBotOnline(false)
        setBotSessionCount(null)
        setBotActiveSessions(null)
        clearInterval(pingTimerRef.current)
        // Auto-reconnect with exponential backoff (1s → 15s). This is the fix for
        // "shows offline after idle until I refresh": an idle proxy/network can drop
        // the socket; we now silently re-establish it instead of staying dead.
        if (mountedRef.current) {
          const delay = Math.min(1000 * 2 ** attemptsRef.current, 15000)
          attemptsRef.current += 1
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = setTimeout(connect, delay)
        }
      }

      ws.onerror = () => {
        try { ws.close() } catch {}   // force onclose → triggers the reconnect path
      }

      ws.onmessage = (event) => {
        let msg
        try { msg = JSON.parse(event.data) } catch { return }

        if (msg.type === "connected") {
          setBotOnline(!!msg.botOnline)
        }

        if (msg.type === "botStatus") {
          setBotOnline(msg.online !== false)   // default true unless explicitly false
          if (msg.sessionCount  != null) setBotSessionCount(msg.sessionCount)
          if (msg.activeReports != null) setBotActiveReports(msg.activeReports)
          if (msg.activeSessions != null) setBotActiveSessions(msg.activeSessions)
          if (msg.online === false) setBotActiveSessions([])
        }

        if (msg.type === "pong") {
          setBotOnline(!!msg.botOnline)
          if (!msg.botOnline) {
            setBotActiveSessions([])
            setBotSessionCount(null)
          }
        }

        for (const { type, handler } of listenersRef.current) {
          if (type === "*" || type === msg.type) handler(msg)
        }
      }
    }

    connect()

    return () => {
      mountedRef.current = false
      clearInterval(pingTimerRef.current)
      clearTimeout(reconnectTimerRef.current)
      if (wsRef.current) { try { wsRef.current.close() } catch {} }
    }
  }, [])

  const addListener = useCallback((type, handler) => {
    listenersRef.current.push({ type, handler })
    return () => {
      listenersRef.current = listenersRef.current.filter(
        (l) => !(l.type === type && l.handler === handler)
      )
    }
  }, [])

  return { wsRef, send, botOnline, connected, botSessionCount, botActiveReports, botActiveSessions, addListener }
}
