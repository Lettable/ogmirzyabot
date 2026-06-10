"use client"
import { useEffect, useRef, useState } from "react"

export function useWs() {
  const wsRef = useRef(null)
  const [botOnline, setBotOnline]           = useState(false)
  const [connected, setConnected]           = useState(false)
  const [botSessionCount, setBotSessionCount] = useState(null)
  const [botActiveReports, setBotActiveReports] = useState(0)
  const listenersRef = useRef([]) // [{ type, handler }]

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null
    if (!token) return

    const protocol = window.location.protocol === "https:" ? "wss" : "ws"
    const url = `${protocol}://${window.location.host}/ws?type=browser&token=${token}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      setBotOnline(false)
      setBotSessionCount(null)
    }

    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === "connected") {
        setBotOnline(msg.botOnline)
      }
      if (msg.type === "botStatus") {
        setBotOnline(msg.online ?? true)
        if (msg.sessionCount != null) setBotSessionCount(msg.sessionCount)
        if (msg.activeReports != null) setBotActiveReports(msg.activeReports)
      }
      if (msg.type === "pong") {
        setBotOnline(msg.botOnline)
      }

      for (const { type, handler } of listenersRef.current) {
        if (type === "*" || type === msg.type) handler(msg)
      }
    }

    return () => ws.close()
  }, [])

  const send = (data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }

  const addListener = (type, handler) => {
    listenersRef.current.push({ type, handler })
    return () => {
      listenersRef.current = listenersRef.current.filter(
        (l) => !(l.type === type && l.handler === handler)
      )
    }
  }

  return { wsRef, send, botOnline, connected, botSessionCount, botActiveReports, addListener }
}
