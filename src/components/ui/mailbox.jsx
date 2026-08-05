"use client"
import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { nextZ } from "@/lib/windowZ"
import {
  Mail, Inbox, Send, X, Minus, GripVertical, Paperclip, Loader2,
  Sparkles, ArrowLeft, RefreshCw, CornerUpLeft, PenLine, Search, Trash2, Download, MoreVertical,
} from "lucide-react"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()))

function authHeaders() {
  const t = typeof window !== "undefined" ? localStorage.getItem("token") : null
  return { "Content-Type": "application/json", Authorization: `Bearer ${t}` }
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const textToHtml = (t) => `<div>${esc(t).replace(/\n/g, "<br>")}</div>`
const htmlToText = (h) => String(h || "")
  .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
  .replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\n{3,}/g, "\n\n").trim()
const addrOf = (v) => Array.isArray(v) ? v.join(", ") : String(v || "")
const nameOf = (a) => { const s = addrOf(a); const m = s.match(/^\s*"?([^"<]+?)"?\s*<.+>/); return (m ? m[1] : s.split("@")[0] || s).trim() }
const initial = (s) => (String(nameOf(s) || "?").trim()[0] || "?").toUpperCase()
const fullTime = (d) => { try { return new Date(d).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) } catch { return "" } }
function relTime(d) {
  const t = new Date(d), s = (Date.now() - t.getTime()) / 1000
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  try { return t.toLocaleDateString([], { month: "short", day: "numeric" }) } catch { return "" }
}
function Avatar({ who, className }) {
  return (
    <div className={cn("shrink-0 rounded-full font-semibold flex items-center justify-center bg-secondary text-foreground border border-border/60", className)}>
      {initial(who)}
    </div>
  )
}

export default function Mailbox({
  visible = true, onClose, onMinimize, emailDraft, onRequestAiDraft, showToast,
}) {
  const [emails, setEmails]   = useState([])
  const [fromAddr, setFrom]   = useState("report@abusenotifications.org")
  const [loading, setLoading] = useState(true)
  const [folder, setFolder]   = useState("inbox")
  const [view, setView]       = useState("list")
  const [threadId, setThreadId] = useState(null)
  const [query, setQuery]     = useState("")
  const [pos, setPos]         = useState({ x: null, y: null })
  const [zi, setZi]           = useState(() => nextZ())   // stacking order — bumped on focus
  const focus = () => setZi(nextZ())

  const [cTo, setCTo]         = useState("")
  const [cSubject, setCSub]   = useState("")
  const [cBody, setCBody]     = useState("")
  const [cThread, setCThread] = useState(null)
  const [attachments, setAtt] = useState([])
  const [sending, setSending] = useState(false)
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/email", { headers: authHeaders() })
      const d = await r.json()
      if (r.ok) { setEmails(d.emails || []); if (d.from) setFrom(d.from) }
    } catch {}
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (!visible) return; const t = setInterval(load, 15000); return () => clearInterval(t) }, [visible, load])

  useEffect(() => {
    if (!emailDraft?._ts) return
    if (emailDraft.to) setCTo(emailDraft.to)
    if (emailDraft.subject) setCSub(emailDraft.subject)
    if (emailDraft.html) setCBody(htmlToText(emailDraft.html))
    setCThread(null); setAtt([]); setView("compose")
  }, [emailDraft?._ts])

  const threads = useMemo(() => {
    const byThread = {}
    for (const e of emails) { const k = e.threadId || e.id; (byThread[k] ||= []).push(e) }
    return Object.entries(byThread).map(([tid, msgs]) => {
      msgs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      const last = msgs[msgs.length - 1]
      return {
        threadId: tid, messages: msgs, last, subject: msgs[0].subject || "(no subject)",
        hasInbound: msgs.some(m => m.direction === "inbound"),
        hasOutbound: msgs.some(m => m.direction === "outbound"),
      }
    }).sort((a, b) => new Date(b.last.createdAt) - new Date(a.last.createdAt))
  }, [emails])

  const inboxCount = threads.filter(t => t.hasInbound).length
  const sentCount  = threads.filter(t => t.hasOutbound).length
  const q = query.trim().toLowerCase()
  const visibleThreads = threads
    .filter(t => folder === "inbox" ? t.hasInbound : t.hasOutbound)
    .filter(t => !q || [t.subject, t.last.from, addrOf(t.last.to), t.last.text, htmlToText(t.last.html)]
      .some(v => String(v || "").toLowerCase().includes(q)))
  const activeThread = threads.find(t => t.threadId === threadId) || null

  // ── .eml export ──────────────────────────────────────────────────────────────
  function toEml(m) {
    const who = m.direction === "inbound" ? m.from : fromAddr
    const body = m.text || htmlToText(m.html) || ""
    return [
      `From: ${who}`, `To: ${addrOf(m.to)}`, `Subject: ${m.subject || ""}`,
      `Date: ${new Date(m.createdAt).toUTCString()}`,
      `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, body,
    ].join("\r\n")
  }
  function download(filename, content) {
    const blob = new Blob([content], { type: "message/rfc822" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const safe = (s) => String(s || "email").replace(/[^a-z0-9]+/gi, "_").slice(0, 40)
  function downloadMessage(m) { download(`${safe(m.subject)}_${m.id.slice(0, 6)}.eml`, toEml(m)) }
  function downloadThread(t) { download(`${safe(t.subject)}.eml`, t.messages.map(toEml).join("\r\n\r\n----- next message -----\r\n\r\n")) }

  // ── delete (client + DB) ─────────────────────────────────────────────────────
  async function deleteMessage(m) {
    setEmails(prev => prev.filter(e => e.id !== m.id))
    try { await fetch(`/api/email?id=${encodeURIComponent(m.id)}`, { method: "DELETE", headers: authHeaders() }) } catch {}
  }
  async function deleteThread(t) {
    setEmails(prev => prev.filter(e => e.threadId !== t.threadId))
    if (threadId === t.threadId) { setThreadId(null); setView("list") }
    try { await fetch(`/api/email?threadId=${encodeURIComponent(t.threadId)}`, { method: "DELETE", headers: authHeaders() }) } catch {}
    showToast?.("Conversation deleted")
  }

  function openCompose(prefill = {}) {
    setCTo(prefill.to ?? ""); setCSub(prefill.subject ?? ""); setCBody(prefill.body ?? "")
    setCThread(prefill.threadId ?? null); setAtt([]); setView("compose")
  }
  function openThread(t) { setThreadId(t.threadId); setView("read") }
  function replyTo(thread) {
    const last = thread.last
    const replyAddr = last.direction === "inbound" ? last.from : (Array.isArray(last.to) ? last.to[0] : last.to)
    openCompose({ to: replyAddr, threadId: thread.threadId, subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}` })
  }

  async function doSend() {
    if (sending) return
    if (!cTo.trim())      { showToast?.("Recipient required", "error"); return }
    if (!cSubject.trim()) { showToast?.("Subject required", "error"); return }
    if (!cBody.trim())    { showToast?.("Body required", "error"); return }
    setSending(true)
    try {
      const r = await fetch("/api/email", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          to: cTo.split(",").map(s => s.trim()).filter(Boolean),
          subject: cSubject.trim(), html: textToHtml(cBody), text: cBody, threadId: cThread, attachments,
        }),
      })
      const d = await r.json()
      if (!r.ok) { showToast?.(d.error || "Send failed", "error"); setSending(false); return }
      showToast?.("Email sent")
      await load()
      setThreadId(d.email?.threadId || cThread); setFolder("sent"); setView("read")
    } catch (e) { showToast?.(e.message || "Network error", "error") }
    setSending(false)
  }

  function onFiles(list) {
    Array.from(list || []).slice(0, 5).forEach(file => {
      const reader = new FileReader()
      reader.onload = (e) => setAtt(prev => [...prev, { filename: file.name, content: e.target.result.split(",")[1] }])
      reader.readAsDataURL(file)
    })
  }

  function onDragStart(e) {
    const startX = e.clientX, startY = e.clientY
    const rect = e.currentTarget.parentElement.getBoundingClientRect()
    const baseX = pos.x ?? rect.left, baseY = pos.y ?? rect.top
    const move = (ev) => setPos({
      x: Math.max(8, Math.min(window.innerWidth - 380, baseX + (ev.clientX - startX))),
      y: Math.max(8, Math.min(window.innerHeight - 80, baseY + (ev.clientY - startY))),
    })
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up)
  }

  if (!visible) return null
  const style = pos.x != null ? { left: pos.x, top: pos.y, zIndex: zi } : { right: 24, bottom: 24, zIndex: zi }

  const FolderBtn = ({ k, label, Icon, count }) => (
    <Button
      variant={folder === k ? "secondary" : "ghost"}
      size="sm"
      onClick={() => { setFolder(k); setView("list") }}
      className="w-full justify-start gap-2.5 font-medium"
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1 text-left">{label}</span>
      {count > 0 && (
        <Badge variant={folder === k ? "default" : "secondary"} className="h-5 min-w-5 justify-center px-1.5 tabular-nums">
          {count}
        </Badge>
      )}
    </Button>
  )

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      style={style}
      onPointerDownCapture={focus}
      className="fixed flex w-[940px] max-w-[calc(100vw-2rem)] h-[640px] max-h-[calc(100vh-2rem)] min-w-[560px] min-h-[420px] resize flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl max-sm:!inset-1 max-sm:!w-auto max-sm:!h-auto max-sm:!max-w-none max-sm:!max-h-none max-sm:!min-w-0 max-sm:!min-h-0 max-sm:!resize-none"
    >
      {/* Title bar */}
      <div onPointerDown={onDragStart} className="flex items-center gap-2 border-b border-border bg-card px-3 py-2.5 cursor-grab active:cursor-grabbing select-none">
        <GripVertical className="h-4 w-4 text-muted-foreground/40" />
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground"><Mail className="h-3.5 w-3.5" /></div>
        <span className="text-sm font-semibold">Mailbox</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">{fromAddr}</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={load}><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onMinimize}><Minus className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-destructive hover:text-destructive-foreground" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>
      </div>

      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Folder rail */}
        <ResizablePanel defaultSize={20} minSize={15} maxSize={28} className="flex flex-col gap-1 border-r border-border bg-card/40 p-2.5">
          <Button className="mb-1.5 w-full gap-2" size="sm" onClick={() => openCompose()}><PenLine className="h-3.5 w-3.5" /> Compose</Button>
          <FolderBtn k="inbox" label="Inbox" Icon={Inbox} count={inboxCount} />
          <FolderBtn k="sent" label="Sent" Icon={Send} count={sentCount} />
        </ResizablePanel>

        <ResizableHandle />

        {/* Thread list */}
        <ResizablePanel defaultSize={32} minSize={24} className="flex flex-col">
          <div className="border-b border-border px-2.5 py-2">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{folder}</span>
              <span className="text-[10px] text-muted-foreground">{visibleThreads.length}</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search mail…" className="h-8 pl-8 pr-7 text-xs" />
              {query && <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
            </div>
          </div>
          <ScrollArea className="flex-1">
            {!visibleThreads.length && (
              <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
                {loading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" /> : <Inbox className="h-6 w-6 text-muted-foreground/20" />}
                <p className="text-xs text-muted-foreground">{loading ? "Loading…" : `No ${folder} messages`}</p>
              </div>
            )}
            {visibleThreads.map(t => {
              const peer = folder === "inbox" ? t.last.from : addrOf(t.last.to)
              const snippet = (t.last.text || htmlToText(t.last.html)).replace(/\s+/g, " ").slice(0, 70)
              const sel = t.threadId === threadId && view === "read"
              return (
                <div key={t.threadId} role="button" tabIndex={0} onClick={() => openThread(t)}
                  onKeyDown={(e) => { if (e.key === "Enter") openThread(t) }}
                  className={cn("group relative flex w-full cursor-pointer gap-2.5 border-b border-border/50 py-2.5 pl-3 pr-2 text-left transition-colors",
                    sel ? "bg-accent" : "hover:bg-accent/50")}>
                  {sel && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-primary" />}
                  <Avatar who={peer} className="mt-0.5 h-9 w-9 text-[13px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="flex-1 truncate text-[13px] font-semibold text-foreground">{nameOf(peer)}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground group-hover:hidden">{relTime(t.last.createdAt)}</span>
                      <button onClick={(e) => { e.stopPropagation(); deleteThread(t) }} title="Delete conversation"
                        className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="truncate text-xs text-foreground/80">{t.subject}{t.messages.length > 1 && <span className="font-normal text-muted-foreground"> · {t.messages.length}</span>}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{snippet || "—"}</p>
                  </div>
                </div>
              )
            })}
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle />

        {/* Reading / compose pane */}
        <ResizablePanel defaultSize={48} minSize={30} className="flex flex-col overflow-hidden bg-background">
          {view === "list" && (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-8">
              <div className="h-12 w-12 rounded-2xl bg-secondary/40 flex items-center justify-center"><Mail className="h-6 w-6 text-muted-foreground/30" /></div>
              <div>
                <p className="text-sm font-medium text-foreground/80">No conversation selected</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Pick a message on the left, or compose a new report.</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => openCompose()}><PenLine className="h-3.5 w-3.5" /> Compose</Button>
            </div>
          )}

          {view === "read" && activeThread && (
            <>
              <div className="px-5 pt-4 pb-3 border-b border-border/50">
                <div className="flex items-center gap-1.5 mb-2">
                  <button onClick={() => setView("list")} className="h-7 w-7 rounded-md hover:bg-secondary/60 flex items-center justify-center text-muted-foreground"><ArrowLeft className="h-4 w-4" /></button>
                  <div className="flex-1" />
                  <button onClick={() => downloadThread(activeThread)} title="Download conversation (.eml)" className="h-7 w-7 rounded-md hover:bg-secondary/60 flex items-center justify-center text-muted-foreground hover:text-foreground"><Download className="h-3.5 w-3.5" /></button>
                  <button onClick={() => deleteThread(activeThread)} title="Delete conversation" className="h-7 w-7 rounded-md hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                  <Button size="sm" variant="outline" className="ml-1" onClick={() => replyTo(activeThread)}><CornerUpLeft className="h-3.5 w-3.5" /> Reply</Button>
                </div>
                <h3 className="text-[15px] font-semibold leading-snug">{activeThread.subject}</h3>
                <p className="text-[11px] text-muted-foreground/50 mt-0.5">{activeThread.messages.length} message{activeThread.messages.length !== 1 ? "s" : ""}</p>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {activeThread.messages.map(m => {
                  const who = m.direction === "inbound" ? m.from : fromAddr
                  return (
                    <div key={m.id} className="rounded-xl border border-border/50 bg-secondary/[0.12] overflow-hidden">
                      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border/30">
                        <Avatar who={who} className="h-8 w-8 text-[12px]" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-semibold truncate">{nameOf(who)} <span className="font-normal text-muted-foreground/50">&lt;{addrOf(who)}&gt;</span></p>
                          <p className="text-[10.5px] text-muted-foreground/55 truncate">to {addrOf(m.to) || (m.direction === "inbound" ? fromAddr : "—")}</p>
                        </div>
                        <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-semibold shrink-0", m.direction === "inbound" ? "bg-secondary text-foreground" : "bg-success/10 text-success")}>{m.direction === "inbound" ? "RECEIVED" : "SENT"}</span>
                        <span className="text-[10px] text-muted-foreground/45 shrink-0">{fullTime(m.createdAt)}</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger className="h-6 w-6 rounded-md hover:bg-secondary/60 flex items-center justify-center text-muted-foreground/60 hover:text-foreground shrink-0 outline-none"><MoreVertical className="h-3.5 w-3.5" /></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => downloadMessage(m)}><Download className="h-3.5 w-3.5" /> Download .eml</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => deleteMessage(m)} className="text-destructive focus:text-destructive"><Trash2 className="h-3.5 w-3.5" /> Delete message</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <p className="text-[13.5px] whitespace-pre-wrap break-words leading-relaxed px-3.5 py-3 text-foreground/90">{m.text || htmlToText(m.html) || "(no content)"}</p>
                      {m.attachments?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-3.5 pb-3">
                          {m.attachments.map((a, i) => <span key={i} className="text-[10px] px-2 py-1 rounded-md border border-border/50 bg-background text-muted-foreground flex items-center gap-1"><Paperclip className="h-2.5 w-2.5" />{a.filename}</span>)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {view === "compose" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-border/50">
                <button onClick={() => setView("list")} className="h-7 w-7 rounded-md hover:bg-secondary/60 flex items-center justify-center text-muted-foreground"><ArrowLeft className="h-4 w-4" /></button>
                <h3 className="text-sm font-semibold flex-1">{cThread ? "Reply" : "New email"}</h3>
                <Button size="sm" variant="outline" className="border-primary/40 text-primary hover:bg-primary/10" onClick={() => onRequestAiDraft?.()}>
                  <Sparkles className="h-3.5 w-3.5" /> Draft with AI
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto">
                <div className="px-5">
                  <div className="flex items-center gap-3 border-b border-border/40 py-2.5">
                    <span className="text-[11px] font-medium text-muted-foreground/70 w-12 shrink-0">To</span>
                    <Input value={cTo} onChange={e => setCTo(e.target.value)} placeholder="recipient — AI picks the right abuse address" className="h-7 text-[13px] border-0 bg-transparent px-0 focus-visible:ring-0 shadow-none" />
                  </div>
                  <div className="flex items-center gap-3 border-b border-border/40 py-2.5">
                    <span className="text-[11px] font-medium text-muted-foreground/70 w-12 shrink-0">From</span>
                    <span className="text-[12.5px] text-muted-foreground/60">{fromAddr}</span>
                  </div>
                  <div className="flex items-center gap-3 border-b border-border/40 py-2.5">
                    <span className="text-[11px] font-medium text-muted-foreground/70 w-12 shrink-0">Subject</span>
                    <Input value={cSubject} onChange={e => setCSub(e.target.value)} placeholder="Subject" className="h-7 text-[13px] border-0 bg-transparent px-0 focus-visible:ring-0 shadow-none font-medium" />
                  </div>
                </div>
                <Textarea value={cBody} onChange={e => setCBody(e.target.value)}
                  placeholder="Write the report, or click “Draft with AI” to research the target and generate it…"
                  className="min-h-[240px] text-[13.5px] resize-none leading-relaxed border-0 bg-transparent focus-visible:ring-0 shadow-none px-5 py-3.5" />
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-5 pb-3">
                    {attachments.map((a, i) => (
                      <span key={i} className="text-[10px] px-2 py-1 rounded-md border border-border/50 bg-secondary/30 text-muted-foreground flex items-center gap-1">
                        <Paperclip className="h-2.5 w-2.5" />{a.filename}
                        <button onClick={() => setAtt(prev => prev.filter((_, j) => j !== i))} className="hover:text-foreground"><X className="h-2.5 w-2.5" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border p-3 flex items-center gap-2">
                <Button onClick={doSend} disabled={sending} className="px-6 gap-2">
                  {sending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : <><Send className="h-4 w-4" /> Send</>}
                </Button>
                <button onClick={() => fileRef.current?.click()} className="h-9 w-9 rounded-lg border border-border bg-secondary/30 hover:bg-secondary flex items-center justify-center text-muted-foreground" title="Attach evidence">
                  <Paperclip className="h-4 w-4" />
                </button>
                <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { onFiles(e.target.files); e.target.value = "" }} />
                <div className="flex-1" />
                <span className="text-[10px] text-muted-foreground/40">{cThread ? "reply in thread" : "new conversation"}</span>
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </motion.div>
  )
}
