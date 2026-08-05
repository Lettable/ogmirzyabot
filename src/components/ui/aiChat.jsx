"use client"
import { useState, useEffect, useRef, useCallback } from "react"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { nextZ } from "@/lib/windowZ"
import {
  Sparkles, X, Plus, Send, Loader2, ImageIcon, Paperclip,
  Wrench, CheckCircle2, GripVertical, Minus, Mail, Pencil,
  MessageSquare, Check, ChevronsUpDown, Trash2,
} from "lucide-react"

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()))

// Initials for an account avatar (e.g. "John Doe" -> "JD")
const initials = (name) => {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Account avatar — real Telegram photo when available, else monochrome initials
function AccountAvatar({ session, className }) {
  return (
    <Avatar className={className}>
      {session?.photoUrl ? <AvatarImage src={session.photoUrl} alt={session.name || "account"} /> : null}
      <AvatarFallback className="bg-secondary text-[10px] font-semibold text-foreground">
        {session ? initials(session.name) : "?"}
      </AvatarFallback>
    </Avatar>
  )
}

function authHeaders() {
  const t = typeof window !== "undefined" ? localStorage.getItem("token") : null
  return { "Content-Type": "application/json", Authorization: `Bearer ${t}` }
}

// Strip heavy base64 image data before persisting to Mongo (keeps docs small)
function stripForStorage(messages) {
  return messages.map(m => {
    if (Array.isArray(m.content)) {
      return { ...m, content: m.content.map(b => b?.type === "image" ? { type: "image", _stripped: true } : b) }
    }
    return m
  })
}

// Render one message's blocks into readable chunks
function renderBlocks(content) {
  if (typeof content === "string") return [{ kind: "text", text: content }]
  const out = []
  for (const b of content || []) {
    if (b.type === "text") out.push({ kind: "text", text: b.text })
    else if (b.type === "image") out.push({ kind: "image", data: b._stripped ? null : b.source?.data, mt: b.source?.media_type })
    else if (b.type === "tool_use") out.push({ kind: "tool_use", name: b.name, input: b.input })
    else if (b.type === "tool_result") out.push({ kind: "tool_result", isError: b.is_error, text: typeof b.content === "string" ? b.content : "" })
  }
  return out
}

export default function AiChat({
  visible = true, onClose, onMinimize, send, addListener,
  sessions = [], botActiveSessions = null, selected = [],
  applyReportConfig, onEmailDraft, mode = "report", newChatKey, showToast,
}) {
  const [chats, setChats]       = useState([])      // [{id,title,sessionIndex,messages}]
  const [activeId, setActiveId] = useState(null)
  const [input, setInput]       = useState("")
  const [images, setImages]     = useState([])      // [{media_type, data, preview}]
  const [busy, setBusy]         = useState(false)
  const [loaded, setLoaded]     = useState(false)
  const [pos, setPos]           = useState({ x: null, y: null })
  const [zi, setZi]             = useState(() => nextZ())   // stacking order — bumped on focus
  const focus = () => setZi(nextZ())
  const [editingId, setEditingId] = useState(null)   // tab being renamed
  const [editValue, setEditValue] = useState("")
  const fileRef   = useRef(null)
  const scrollRef = useRef(null)
  const editRef   = useRef(null)
  const saveTimers = useRef({})
  const newChatSeen = useRef(newChatKey)

  const active = chats.find(c => c.id === activeId) || null

  // Active accounts available to fetch with
  const activeSessions = sessions.filter(s => botActiveSessions === null || botActiveSessions.includes(s.index))

  // ── Load persisted chats once on mount (component stays mounted while minimized) ─
  useEffect(() => {
    if (loaded) return
    ;(async () => {
      try {
        const r = await fetch("/api/ai/chats", { headers: authHeaders() })
        const d = await r.json()
        const list = (d.chats || []).map(c => ({ ...c, messages: c.messages || [] }))
        if (list.length) { setChats(list); setActiveId(list[0].id) }
        else newChat(list)
      } catch { newChat([]) }
      setLoaded(true)
    })()
  }, [])

  // Open a fresh tab when the parent bumps newChatKey (e.g. mailbox → Draft with AI)
  useEffect(() => {
    if (newChatKey === undefined) return
    if (newChatSeen.current === newChatKey) return
    newChatSeen.current = newChatKey
    if (loaded) newChat()
  }, [newChatKey, loaded])

  // ── Autoscroll on new messages ──────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active?.messages?.length, busy])

  // ── Auto-name a chat once it has its first user+assistant exchange ────────────
  const titledRef = useRef(new Set())
  useEffect(() => {
    if (busy) return
    for (const c of chats) {
      const hasAssistant = (c.messages || []).some(m => m.role === "assistant")
      if (!c.renamed && hasAssistant && (c.messages?.length >= 2) && !titledRef.current.has(c.id)) {
        titledRef.current.add(c.id)
        autoTitle(c)
      }
    }
  }, [chats, busy])

  function defaultSessionIndex() {
    const firstSel = selected.length ? sessions.find(s => s._id?.toString() === selected[0]) : null
    if (firstSel) return firstSel.index
    return activeSessions[0]?.index ?? null
  }

  function newChat(base = chats) {
    const id = uid()
    const chat = { id, title: "New chat", sessionIndex: defaultSessionIndex(), messages: [], renamed: false }
    setChats([chat, ...base])
    setActiveId(id)
    return chat
  }

  // ── Tab rename (inline) ──────────────────────────────────────────────────────
  function startRename(chat) {
    setEditingId(chat.id)
    setEditValue(chat.title || "")
    setTimeout(() => { editRef.current?.focus(); editRef.current?.select() }, 0)
  }
  function commitRename() {
    const id = editingId
    const title = editValue.trim()
    setEditingId(null)
    if (!id) return
    setChats(prev => {
      const next = prev.map(c => c.id === id ? { ...c, title: title || c.title, renamed: true } : c)
      persist(next.find(c => c.id === id))
      return next
    })
  }

  // ── AI auto-naming: name the tab once the first exchange exists ───────────────
  async function autoTitle(chat) {
    if (!chat || chat.renamed) return
    const convo = (chat.messages || []).slice(0, 4).map(m => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        : (m.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").slice(0, 600) || "[attachment]",
    })).filter(m => m.content)
    if (!convo.length) return
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ mode: "title", messages: convo }),
      })
      const d = await r.json()
      if (!r.ok || !d.title) return
      setChats(prev => {
        const cur = prev.find(c => c.id === chat.id)
        if (!cur || cur.renamed) return prev
        const next = prev.map(c => c.id === chat.id ? { ...c, title: d.title } : c)
        persist(next.find(c => c.id === chat.id))
        return next
      })
    } catch {}
  }

  function persist(chat) {
    if (!chat) return
    clearTimeout(saveTimers.current[chat.id])
    saveTimers.current[chat.id] = setTimeout(() => {
      const s = activeSessions.find(x => x.index === chat.sessionIndex) || sessions.find(x => x.index === chat.sessionIndex)
      fetch("/api/ai/chats", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          id: chat.id, title: chat.title, sessionIndex: chat.sessionIndex,
          sessionName: s?.name || null, messages: stripForStorage(chat.messages),
        }),
      }).catch(() => {})
    }, 700)
  }

  function updateActive(mut) {
    setChats(prev => {
      const next = prev.map(c => c.id === activeId ? mut(c) : c)
      const updated = next.find(c => c.id === activeId)
      persist(updated)
      return next
    })
  }

  async function deleteChat(id) {
    setChats(prev => {
      const next = prev.filter(c => c.id !== id)
      if (id === activeId) setActiveId(next[0]?.id || null)
      return next.length ? next : []
    })
    try { await fetch(`/api/ai/chats?id=${id}`, { method: "DELETE", headers: authHeaders() }) } catch {}
    if (chats.length <= 1) newChat([])
  }

  // ── Telegram fetch tool via WS (correlated by requestId) ─────────────────────
  const fetchTelegram = useCallback((link, limit, sessionIndex) => new Promise(resolve => {
    const requestId = uid()
    let off = () => {}
    const timer = setTimeout(() => { off(); resolve({ ok: false, error: "Telegram fetch timed out" }) }, 35000)
    off = addListener("aiTelegramResult", (m) => {
      if (m.requestId !== requestId) return
      clearTimeout(timer); off()
      resolve(m)
    })
    send({ type: "aiFetchTelegram", index: sessionIndex, link, limit, requestId })
  }), [addListener, send])

  // ── The agentic turn (client-orchestrated tool loop) ─────────────────────────
  async function runTurn(seedMessages) {
    setBusy(true)
    const sessionIndex = active?.sessionIndex ?? defaultSessionIndex()
    const sObj = sessions.find(s => s.index === sessionIndex)
    let msgs = seedMessages
    try {
      for (let round = 0; round < 6; round++) {
        const r = await fetch("/api/ai/chat", {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ mode: mode === "email" ? "email" : undefined, messages: msgs, session: { index: sessionIndex, name: sObj?.name } }),
        })
        const data = await r.json()
        if (!r.ok) {
          msgs = [...msgs, { role: "assistant", content: [{ type: "text", text: `⚠️ ${data.error || "AI request failed"}` }] }]
          commit(msgs); break
        }
        msgs = [...msgs, { role: "assistant", content: data.content }]
        commit(msgs)
        if (data.stop_reason !== "tool_use") break

        const results = []
        for (const block of data.content) {
          if (block.type !== "tool_use") continue
          if (block.name === "fetch_telegram") {
            const res = await fetchTelegram(block.input.link, block.input.limit, sessionIndex)
            results.push({ type: "tool_result", tool_use_id: block.id, is_error: !res.ok,
              content: res.ok ? (res.text || "(no content)") : (res.error || "fetch failed") })
          } else if (block.name === "fill_report") {
            try { applyReportConfig?.(block.input) } catch {}
            results.push({ type: "tool_result", tool_use_id: block.id, content: "Report form populated." })
          } else if (block.name === "draft_email") {
            try { onEmailDraft?.(block.input) } catch {}
            results.push({ type: "tool_result", tool_use_id: block.id, content: "Draft loaded into the mailbox compose window." })
          } else {
            results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Unknown tool" })
          }
        }
        msgs = [...msgs, { role: "user", content: results }]
        commit(msgs)
      }
    } catch (e) {
      msgs = [...msgs, { role: "assistant", content: [{ type: "text", text: `⚠️ ${e.message || "Network error"}` }] }]
      commit(msgs)
    } finally {
      setBusy(false)
    }
    function commit(m) { updateActive(c => ({ ...c, messages: m })) }
  }

  function handleSend() {
    if (busy) return
    const text = input.trim()
    if (!text && !images.length) return
    let chat = active
    if (!chat) chat = newChat()

    const content = []
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } })
    if (text) content.push({ type: "text", text })

    const userMsg = { role: "user", content: content.length === 1 && content[0].type === "text" ? text : content }
    const seed = [...(chat.messages || []), userMsg]
    // title from first user text
    const title = (chat.messages?.length ? chat.title : (text.slice(0, 40) || "Image chat"))
    updateActive(c => ({ ...c, title, messages: seed }))
    setInput(""); setImages([])
    runTurn(seed)
  }

  function onFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/")).slice(0, 4)
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target.result
        setImages(prev => [...prev, { media_type: file.type, data: dataUrl.split(",")[1], preview: dataUrl }])
      }
      reader.readAsDataURL(file)
    })
  }

  // ── Dragging ─────────────────────────────────────────────────────────────────
  const drag = useRef(null)
  function onDragStart(e) {
    const startX = e.clientX, startY = e.clientY
    const rect = e.currentTarget.parentElement.getBoundingClientRect()
    const baseX = pos.x ?? rect.left, baseY = pos.y ?? rect.top
    drag.current = { startX, startY, baseX, baseY }
    const move = (ev) => {
      if (!drag.current) return
      setPos({
        x: Math.max(8, Math.min(window.innerWidth - 360, drag.current.baseX + (ev.clientX - drag.current.startX))),
        y: Math.max(8, Math.min(window.innerHeight - 80, drag.current.baseY + (ev.clientY - drag.current.startY))),
      })
    }
    const up = () => { drag.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  if (!visible) return null   // minimized — stay mounted (state preserved), just hidden

  const activeSession = sessions.find(s => s.index === active?.sessionIndex) || null

  const style = pos.x != null
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto", zIndex: zi }
    : { right: 24, bottom: 24, zIndex: zi }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      style={style}
      onPointerDownCapture={focus}
      className="fixed w-[720px] max-w-[calc(100vw-2rem)] h-[580px] max-h-[calc(100vh-2rem)] min-w-[420px] min-h-[360px] resize rounded-xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden max-sm:!inset-1 max-sm:!w-auto max-sm:!h-auto max-sm:!max-w-none max-sm:!max-h-none max-sm:!min-w-0 max-sm:!min-h-0 max-sm:!resize-none"
    >
      {/* Top bar (drag handle) */}
      <div onPointerDown={onDragStart} className="flex items-center gap-2 px-3 py-2.5 border-b border-border bg-card cursor-grab active:cursor-grabbing select-none">
        <GripVertical className="h-4 w-4 text-muted-foreground/40" />
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          {mode === "email" ? <Mail className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        </div>
        <span className="text-sm font-semibold flex-1">{mode === "email" ? "AI Email Drafter" : "AI Report Assistant"}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onMinimize} title="Minimize"><Minus className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-destructive hover:text-destructive-foreground" onClick={onClose} title="Close"><X className="h-4 w-4" /></Button>
      </div>

      {/* Body: sidebar + conversation */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar: history (top) + account switcher (bottom) ── */}
        <div className="w-[200px] max-sm:w-[124px] shrink-0 border-r border-border bg-card/40 flex flex-col">
          <div className="p-2">
            <Button variant="secondary" className="w-full justify-start gap-2 h-8" onClick={() => newChat()}>
              <Plus className="h-4 w-4" /> New chat
            </Button>
          </div>

          <ScrollArea className="flex-1 px-2">
            <p className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">History</p>
            <div className="flex flex-col gap-0.5 pb-2">
              {chats.map(c => {
                const isActive = c.id === activeId
                const isEditing = c.id === editingId
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => !isEditing && setActiveId(c.id)}
                    onDoubleClick={() => startRename(c)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !isEditing) setActiveId(c.id) }}
                    className={cn(
                      "group flex items-center gap-1.5 h-8 pl-2 pr-1 rounded-md text-xs font-medium transition-colors cursor-pointer",
                      isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {isEditing ? (
                      <Input
                        ref={editRef}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitRename() }
                          if (e.key === "Escape") { e.preventDefault(); setEditingId(null) }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-6 flex-1 px-1.5 py-0 text-xs"
                      />
                    ) : (
                      <>
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                        <span className="min-w-0 flex-1 truncate">{c.title || "New chat"}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); startRename(c) }}
                          title="Rename chat"
                          className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover:flex"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteChat(c.id) }}
                          title="Delete chat"
                          className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:flex"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>

          {/* Account switcher — bottom-left, Vercel style */}
          <div className="border-t border-border p-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-accent">
                  <AccountAvatar session={activeSession} className="h-7 w-7 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{activeSession?.name || "Select account"}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {activeSession ? `#${activeSession.index} · fetch account` : "none selected"}
                    </p>
                  </div>
                  <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-[216px]">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Fetch with account
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {activeSessions.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No active accounts</div>
                )}
                {activeSessions.map(s => {
                  const sel = s.index === active?.sessionIndex
                  return (
                    <DropdownMenuItem
                      key={s.index}
                      onClick={() => updateActive(c => ({ ...c, sessionIndex: s.index }))}
                      className="gap-2"
                    >
                      <AccountAvatar session={s} className="h-6 w-6 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{s.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">#{s.index}</p>
                      </div>
                      {sel && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* ── Right column: conversation ── */}
        <div className="flex flex-1 flex-col overflow-hidden">

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="p-3 space-y-3">
          {(!active || !active.messages.length) && (
            <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4">
              <Sparkles className="h-6 w-6 text-primary/40" />
              <p className="text-xs text-muted-foreground/70 leading-relaxed">
                Paste Telegram links (public or private), describe what to report, or drop a screenshot.
                I'll read them with the selected account and fill the report form.
              </p>
            </div>
          )}
          {active?.messages.map((m, i) => (
            <MessageRow key={i} role={m.role} blocks={renderBlocks(m.content)} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          )}
        </div>
      </div>

      {/* Attachments preview */}
      {images.length > 0 && (
        <div className="flex gap-1.5 px-3 py-1.5 border-t border-border/60 overflow-x-auto">
          {images.map((img, i) => (
            <div key={i} className="relative shrink-0">
              <img src={img.preview} alt="" className="h-12 w-12 rounded object-cover border border-border" />
              <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center"><X className="h-2.5 w-2.5" /></button>
            </div>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-1.5">
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => fileRef.current?.click()} title="Attach image">
            <Paperclip className="h-4 w-4" />
          </Button>
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { onFiles(e.target.files); e.target.value = "" }} />
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="Message the assistant…"
            disabled={busy}
            rows={1}
            className="min-h-9 max-h-28 flex-1 text-sm resize-none py-1.5 leading-5"
          />
          <Button onClick={handleSend} disabled={busy || (!input.trim() && !images.length)} className="h-9 w-9 shrink-0 p-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>

        </div>{/* /right column */}
      </div>{/* /body */}
    </motion.div>
  )
}

function MessageRow({ role, blocks }) {
  const isUser = role === "user"
  // tool_result blocks render as their own status chips, not bubbles
  const textBlocks = blocks.filter(b => b.kind === "text" && b.text)
  const images     = blocks.filter(b => b.kind === "image")
  const toolUses   = blocks.filter(b => b.kind === "tool_use")
  const toolResults = blocks.filter(b => b.kind === "tool_result")

  if (!textBlocks.length && !images.length && !toolUses.length && toolResults.length) {
    return (
      <div className="space-y-1">
        {toolResults.map((t, i) => (
          <div key={i} className={cn("flex items-center gap-1.5 text-[10px]", t.isError ? "text-destructive/70" : "text-success")}>
            <CheckCircle2 className="h-3 w-3" /> {t.isError ? "fetch failed" : "fetched"}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
        isUser ? "bg-primary/15 rounded-br-sm" : "bg-secondary/50 rounded-bl-sm")}>
        {images.map((im, i) => im.data
          ? <img key={i} src={`data:${im.mt};base64,${im.data}`} alt="" className="rounded-lg mb-1.5 max-h-40" />
          : <div key={i} className="text-[11px] text-muted-foreground/60 mb-1 flex items-center gap-1"><ImageIcon className="h-3 w-3" /> image</div>)}
        {toolUses.map((t, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 my-0.5">
            <Wrench className="h-3 w-3" />
            {t.name === "fetch_telegram" ? `Reading ${t.input?.link || "link"}…` : t.name === "fill_report" ? "Filling report form…" : t.name}
          </div>
        ))}
        {textBlocks.map((t, i) => <p key={i} className="whitespace-pre-wrap break-words">{t.text}</p>)}
      </div>
    </div>
  )
}
