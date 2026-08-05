"use client"
import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useWs } from "@/lib/useWs"
import { cn } from "@/lib/utils"
import { motion, AnimatePresence } from "motion/react"

// shadcn UI
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"

// icons
import { Play, Square, RotateCcw, RefreshCw, Plus, Trash2, Pencil, Check, X, Users, LogOut, Filter, Loader2, CheckCircle2, PanelLeft, PanelRight, Search, Download, AlertTriangle, Eye, EyeOff, UserPlus, UserMinus, Camera, ImageOff, AtSign, Mic, MicOff, PhoneCall, PhoneOff, Upload, Volume2, Zap, Radio, MessageSquare, Minus, Dices, Folder, Image as ImageIcon, Sparkles, Mail, ChevronDown, IdCard, KeyRound, Copy, Pause, Circle, Flag, Menu } from "lucide-react"

// Per-user capabilities ("perks"). Admins implicitly have all of these. The
// label/Icon drive both the admin's create-user picker and any perk badges.
const PERKS = [
  { key: "report",  label: "Reporting",    Icon: Flag },
  { key: "raid",    label: "Raid",         Icon: Zap },
  { key: "vc",      label: "Voice Chat",   Icon: PhoneCall },
  { key: "join",    label: "Join / Leave", Icon: UserPlus },
  { key: "profile", label: "Profiles",     Icon: IdCard },
  { key: "ai",      label: "AI Assistant", Icon: Sparkles },
  { key: "mail",    label: "Mailbox",      Icon: Mail },
]
const PERK_LABEL = Object.fromEntries(PERKS.map(p => [p.key, p.label]))

// local
import AddSessionDialog from "@/components/ui/addSessionDialog"
import AiChat from "@/components/ui/aiChat"
import Mailbox from "@/components/ui/mailbox"
import { LiveNotificationList } from "@/components/ui/live-notifications"

// Initials for an account avatar (e.g. "John Doe" -> "JD")
function acctInitials(name) {
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
      <AvatarFallback className="bg-secondary text-foreground font-semibold">
        {acctInitials(session?.name)}
      </AvatarFallback>
    </Avatar>
  )
}

// ─── Toolbar icon button (compact, tooltip-labelled) ─────────────────────────
function ToolbarIconButton({ icon: Icon, label, onClick, disabled, active, variant = "ghost", title }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : variant}
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onClick}
          disabled={disabled}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title || label}</TooltipContent>
    </Tooltip>
  )
}

// ─── Utilities ─────────────────────────────────────────────────────────────

const PREFIXES = {
  "1":"US","7":"RU","20":"EG","27":"ZA","30":"GR","31":"NL","32":"BE","33":"FR",
  "34":"ES","36":"HU","39":"IT","40":"RO","41":"CH","43":"AT","44":"GB","45":"DK",
  "46":"SE","47":"NO","48":"PL","49":"DE","51":"PE","52":"MX","54":"AR","55":"BR",
  "56":"CL","57":"CO","58":"VE","60":"MY","61":"AU","62":"ID","63":"PH","65":"SG",
  "66":"TH","81":"JP","82":"KR","84":"VN","86":"CN","90":"TR","91":"IN","92":"PK",
  "93":"AF","94":"LK","98":"IR","212":"MA","213":"DZ","216":"TN","218":"LY",
  "880":"BD","886":"TW","960":"MV","961":"LB","962":"JO","963":"SY","964":"IQ",
  "965":"KW","966":"SA","967":"YE","968":"OM","971":"AE","972":"IL","973":"BH",
  "974":"QA","992":"TJ","994":"AZ","995":"GE","996":"KG","998":"UZ",
}
function phoneToCountry(p) {
  if (!p) return null
  const n = p.replace(/\D/g, "")
  for (const l of [3, 2, 1]) { const c = PREFIXES[n.slice(0, l)]; if (c) return c }
  return null
}

// Parse telegram links — extracts username (public) or chatId as -100xxx (private)
const parseTelegramLinks = (input) => {
  const links = input.split(",").map(l => l.trim()).filter(Boolean)
  let rawChatId = null, extractedUsername = null, hasError = false, linkType = null, usernameConflict = false
  const messageIds = new Set()
  for (const link of links) {
    const priv = link.match(/t\.me\/c\/(\d+)\/(\d+)/)
    const pub  = link.match(/t\.me\/([^/]+)\/(\d+)/)
    const match = priv || pub
    const type  = priv ? "private" : pub ? "public" : null
    if (!match || !type) { hasError = true; continue }
    const [, cid, mid] = match
    if (!linkType) linkType = type
    if (type !== linkType) { hasError = true; continue }
    if (type === "private") {
      if (rawChatId && cid !== rawChatId) { hasError = true; continue }
      rawChatId = cid
    }
    if (type === "public") {
      if (extractedUsername && cid !== extractedUsername) { usernameConflict = true; hasError = true; continue }
      extractedUsername = cid
    }
    if (messageIds.has(mid)) { hasError = true; continue }
    messageIds.add(mid)
  }
  const chatId = rawChatId ? `-100${rawChatId}` : null
  return {
    chatId, rawChatId, extractedUsername,
    hasError, usernameConflict,
    messageIds: Array.from(messageIds).sort((a, b) => Number(a) - Number(b)),
    linkType,
  }
}

const generateHash = () => (Date.now().toString(16) + Math.random().toString(36).slice(2)).slice(0, 24)

const MSG_TREE = [
  { title: "I don't like it", value: "1" },
  { title: "Child abuse", value: "2", children: [
    { title: "Child sexual abuse",  value: "21" },
    { title: "Child physical abuse", value: "22" },
  ]},
  { title: "Violence", value: "3", children: [
    { title: "Insults or false information",     value: "31" },
    { title: "Graphic or disturbing content",    value: "32" },
    { title: "Extreme violence, dismemberment",  value: "33" },
    { title: "Hate speech or symbols",           value: "34" },
    { title: "Calling for violence",             value: "35" },
    { title: "Organized crime",                  value: "36" },
    { title: "Terrorism",                        value: "37" },
    { title: "Animal abuse",                     value: "38" },
  ]},
  { title: "Illegal goods and services", value: "4", children: [
    { title: "Weapons",                    value: "41" },
    { title: "Drugs",                      value: "42" },
    { title: "Fake documents",             value: "43" },
    { title: "Counterfeit money",          value: "44" },
    { title: "Hacking tools and malware",  value: "45" },
    { title: "Counterfeit merchandise",    value: "46" },
    { title: "Other goods and services",   value: "47" },
  ]},
  { title: "Illegal adult content", value: "5", children: [
    { title: "Child abuse", value: "56", children: [
      { title: "Child sexual abuse",  value: "21" },
      { title: "Child physical abuse", value: "22" },
    ]},
    { title: "Illegal sexual services",      value: "52" },
    { title: "Animal abuse",                 value: "55" },
    { title: "Non-consensual sexual imagery", value: "53" },
    { title: "Pornography",                  value: "57" },
    { title: "Other illegal sexual content", value: "54" },
  ]},
  { title: "Personal data", value: "6", children: [
    { title: "Private images",             value: "61" },
    { title: "Phone number",               value: "62" },
    { title: "Address",                    value: "63" },
    { title: "Stolen data or credentials", value: "64" },
    { title: "Other personal information", value: "65" },
  ]},
  { title: "Scam or fraud", value: "7", children: [
    { title: "Impersonation",                             value: "71" },
    { title: "Deceptive or unrealistic financial claims", value: "72" },
    { title: "Malware, phishing",                         value: "73" },
    { title: "Fraudulent seller, product or service",     value: "74" },
  ]},
  { title: "Copyright", value: "8" },
  { title: "Spam", value: "9", children: [
    { title: "Impersonation",                             value: "71" },
    { title: "Deceptive or unrealistic financial claims", value: "72" },
    { title: "Malware, phishing",                         value: "73" },
    { title: "Fraudulent seller, product or service",     value: "74" },
  ]},
  { title: "Other", value: "a", children: [
    { title: "I don't like it",              value: "a3" },
    { title: "False information or defamation", value: "a1" },
    { title: "Illegal adult content",        value: "a4" },
    { title: "Illegal goods and services",   value: "a5" },
    { title: "Something else",               value: "a2" },
  ]},
  { title: "It's not illegal, but must be taken down", value: "b" },
]
const USER_TREE = [
  { title: "Child Abuse",    value: "InputReportReasonChildAbuse" },
  { title: "Copyright",      value: "InputReportReasonCopyright" },
  { title: "Fake",           value: "InputReportReasonFake" },
  { title: "Illegal Drugs",  value: "InputReportReasonIllegalDrugs" },
  { title: "Other",          value: "InputReportReasonOther" },
  { title: "Spam",           value: "InputReportReasonSpam" },
  { title: "Violence",       value: "InputReportReasonViolence" },
]

// ─── Resize hook ────────────────────────────────────────────────────────────

function useHResize(def, min, max, dir) {
  const [width, setWidth] = useState(def)
  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    const sx = e.clientX, sw = width
    const move = (ev) => setWidth(Math.max(min, Math.min(max, dir === "left" ? sw + (ev.clientX - sx) : sw - (ev.clientX - sx))))
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up) }
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up)
  }, [width, min, max, dir])
  return { width, onMouseDown }
}

// ─── Reason lookup ─────────────────────────────────────────────────────────

function flattenTree(nodes, map = {}) {
  for (const node of nodes) {
    map[node.value] = node.title
    if (node.children) flattenTree(node.children, map)
  }
  return map
}
const REASON_MAP = flattenTree([...MSG_TREE, ...USER_TREE])

// ─── shadcn number input (replaces antd InputNumber) ───────────────────────
function NumberInput({ value, onChange, min, max, placeholder, disabled, className }) {
  return (
    <Input
      type="number" inputMode="numeric"
      value={value ?? ""} placeholder={placeholder} disabled={disabled}
      min={min} max={max}
      className={cn("bg-input", className)}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === "") return onChange(null)
        const n = Number(raw)
        if (!Number.isNaN(n)) onChange(n)
      }}
      onBlur={(e) => {
        const raw = e.target.value
        if (raw === "") return
        let n = Number(raw); if (Number.isNaN(n)) return
        if (min != null && n < min) n = min
        if (max != null && n > max) n = max
        onChange(n)
      }}
    />
  )
}

// ─── shadcn reasons picker (replaces antd checkable TreeSelect) ─────────────
// Only LEAF/childless nodes are selectable → value stays a flat array of leaf
// values; parents are display-only headers so selecting one can't cascade.
function ReasonTreeSelect({ treeData, value, onChange, disabled }) {
  const [open, setOpen]     = useState(false)
  const [search, setSearch] = useState("")
  const sel = new Set(value)
  const toggle = (v) => onChange(sel.has(v) ? value.filter(x => x !== v) : [...new Set([...value, v])])
  const q = search.trim().toLowerCase()

  const renderNodes = (nodes, depth = 0, path = "") => nodes.map((n, i) => {
    const key = `${path}/${n.value}/${i}`
    const isLeaf = !n.children || !n.children.length
    if (isLeaf) {
      if (q && !String(n.title).toLowerCase().includes(q)) return null
      return (
        <button key={key} type="button" onClick={() => toggle(n.value)}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent transition-colors"
          style={{ paddingLeft: 8 + depth * 14 }}>
          <Checkbox checked={sel.has(n.value)} className="pointer-events-none h-3.5 w-3.5" />
          <span className="truncate">{n.title}</span>
        </button>
      )
    }
    const children = renderNodes(n.children, depth + 1, key).filter(Boolean)
    if (q && !children.length && !String(n.title).toLowerCase().includes(q)) return null
    return (
      <div key={key}>
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60" style={{ paddingLeft: 8 + depth * 14 }}>{n.title}</div>
        {children}
      </div>
    )
  })

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled}
            className={cn("flex min-h-9 w-full items-center justify-between rounded-md border border-input bg-input px-3 py-2 text-sm ring-offset-background",
              "focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50")}>
            <span className={cn(value.length ? "text-foreground" : "text-muted-foreground")}>
              {value.length ? `${value.length} reason${value.length !== 1 ? "s" : ""} selected` : "Select reasons"}
            </span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <div className="p-2 border-b border-border/60">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter reasons…" className="h-8 text-[13px] pl-8 bg-secondary/40" />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto overscroll-contain p-1">{renderNodes(treeData)}</div>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map(v => (
            <Badge key={v} variant="secondary" className="gap-1 pr-1 font-normal">
              {REASON_MAP[v] || v}
              {!disabled && <button type="button" onClick={() => toggle(v)} className="hover:text-destructive"><X className="h-3 w-3" /></button>}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Field wrapper (options panel) ─────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div className="space-y-2">
      <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

// ─── Report detail (shadcn Table) ──────────────────────────────────────────

function ReportDetail({ report }) {
  const logs = Object.entries(report.logs || {}).sort(([a], [b]) => Number(a) - Number(b))

  // Fallback reason from report-level options
  const fallbackReason = (report.options || report.data?.options || [])
    .map(v => REASON_MAP[v] || v).join(", ") || "—"

  const toTime = (val) => {
    if (!val) return "—"
    const d = new Date(val)
    if (isNaN(d)) return "—"
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border/40">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">#</TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="w-16 text-center">Status</TableHead>
            <TableHead>Msg IDs</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Error</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map(([idx, log]) => {
            const msgIds  = Array.isArray(log.msgIds) ? log.msgIds.join(", ") : (log.messageId ? String(log.messageId) : "—")
            const rawReason = log.reason || null
            const reasonDisplay = rawReason ? (REASON_MAP[rawReason] || rawReason) : fallbackReason
            const timeStr = toTime(log.time || log.savedAt || log.timestamp)
            return (
              <TableRow key={idx}>
                <TableCell className="text-muted-foreground/50 font-mono text-xs">{idx}</TableCell>
                <TableCell className="font-medium text-sm">{log.client || log.clientName || `#${idx}`}</TableCell>
                <TableCell className="text-center">
                  <span className={cn(
                    "text-[11px] font-bold px-2 py-0.5 rounded-md",
                    log.worked
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive"
                  )}>
                    {log.worked ? "OK" : "FAIL"}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{msgIds}</TableCell>
                <TableCell className="text-muted-foreground text-xs align-top break-words whitespace-pre-wrap">{reasonDisplay}</TableCell>
                <TableCell className="text-destructive/70 text-xs align-top break-words whitespace-pre-wrap min-w-[180px]">{log.error || "—"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground/60 tabular-nums">{timeStr}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ─── History Panel ──────────────────────────────────────────────────────────

function HistoryPanel({ refreshKey = 0 }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState("all")
  const [openReport, setOpenReport] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const auth = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}` })

  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await fetch("/api/reports", { headers: auth() }); const d = await r.json(); setReports(d.reports || []) }
    finally { setLoading(false) }
  }, [])

  // Reload every 30s, and also instantly whenever a report completes (refreshKey bumps)
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id) }, [load])
  useEffect(() => { if (refreshKey > 0) load() }, [refreshKey])

  const openDetail = async (rep) => {
    setOpenReport(rep); setDetail(null); setDetailLoading(true)
    try { const r = await fetch(`/api/reports?hash=${rep.hash}`, { headers: auth() }); const d = await r.json(); setDetail(d.report) }
    finally { setDetailLoading(false) }
  }

  const filter = (status) => reports.filter(r => {
    const entity = r.target || r.data?.username || r.data?.chatId || r.data?.userId || ""
    const matchSearch = !search || entity.toLowerCase().includes(search.toLowerCase()) || (r.hash || "").includes(search)
    const matchTab = status === "all" || r.status === status
    return matchSearch && matchTab
  })

  const typeLabel = (t) => t === "public" ? "Public" : t === "private" ? "Private" : "User"

  const ReportList = ({ items }) => {
    if (loading && !reports.length) return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
    if (!items.length) return <p className="text-center text-xs text-muted-foreground py-10">No reports found</p>
    return (
      <div className="p-3 space-y-2.5">
        {items.map(rep => {
          const entity = rep.target || rep.data?.username || rep.data?.chatId || rep.data?.userId || "Unknown"
          const started = rep.startedAt ? new Date(rep.startedAt) : null
          return (
            <Card
              key={rep._id || rep.hash}
              className="cursor-pointer hover:border-border/70 hover:bg-secondary/20 transition-all duration-150"
              onClick={() => openDetail(rep)}
            >
              <CardHeader className="px-4 pt-3.5 pb-1 space-y-0.5">
                <CardTitle className="text-sm font-semibold leading-tight truncate">{entity}</CardTitle>
                <CardDescription className="text-[11px]">
                  {typeLabel(rep.type)} · ×{rep.amount || "?"} reports · by {rep.startedBy || "—"}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-3.5 pt-0">
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-[10px] font-mono text-muted-foreground/50">#{(rep.hash || "").slice(0, 10)}</code>
                  <span className="text-muted-foreground/25 text-[10px]">·</span>
                  <span className="text-[11px] text-muted-foreground/70">
                    {started ? started.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    )
  }

  return (
    <>
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-border shrink-0">
        <div className="flex items-center mb-2.5">
          <span className="text-sm font-semibold flex-1">History</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={load}>
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by entity or hash…" className="h-8 pl-7 text-xs" />
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 overflow-hidden">
        <TabsList className="mx-3 mt-2 mb-0 h-8 shrink-0">
          <TabsTrigger value="all"       className="flex-1 text-xs h-6">All</TabsTrigger>
          <TabsTrigger value="completed" className="flex-1 text-xs h-6">Done</TabsTrigger>
          <TabsTrigger value="failed"    className="flex-1 text-xs h-6">Failed</TabsTrigger>
        </TabsList>
        <TabsContent value="all"       className="flex-1 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col">
          <ScrollArea className="flex-1"><ReportList items={filter("all")} /></ScrollArea>
        </TabsContent>
        <TabsContent value="completed" className="flex-1 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col">
          <ScrollArea className="flex-1"><ReportList items={filter("completed")} /></ScrollArea>
        </TabsContent>
        <TabsContent value="failed"    className="flex-1 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col">
          <ScrollArea className="flex-1"><ReportList items={filter("failed")} /></ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Detail modal */}
      <Dialog open={!!openReport} onOpenChange={() => { setOpenReport(null); setDetail(null) }}>
        <DialogContent className="max-w-3xl flex flex-col max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="text-base">
              {openReport && (openReport.target || openReport.data?.username || openReport.data?.chatId || openReport.data?.userId || "Report")}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              #{(openReport?.hash || "").slice(0, 14)} · {openReport?.type} · ×{openReport?.amount} · by {openReport?.startedBy}
            </DialogDescription>
          </DialogHeader>
          {detailLoading
            ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            : detail ? <ReportDetail report={detail} /> : null
          }
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─── Left Panel ─────────────────────────────────────────────────────────────

function LeftPanel({ logs, onLogout, onClearLogs, historyRefreshKey }) {
  const [topPct, setTopPct] = useState(48)
  const containerRef = useRef(null)

  const onSplitDown = useCallback((e) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const sy = e.clientY, sp = topPct
    const move = (ev) => setTopPct(Math.max(20, Math.min(80, sp + ((ev.clientY - sy) / rect.height * 100))))
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up) }
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up)
  }, [topPct])

  return (
    <div ref={containerRef} className="h-full flex flex-col">
      {/* Top: Live Reports */}
      <Card className="flex flex-col overflow-hidden shrink-0" style={{ height: `calc(${topPct}% - 6px)` }}>
        <CardHeader className="flex-row items-center gap-1 px-3 py-2 border-b border-border space-y-0 shrink-0">
          <span className="text-xs font-semibold flex-1">Live Events</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClearLogs}>
                <RotateCcw className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Clear logs</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onLogout}>
                <LogOut className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Sign out</TooltipContent>
          </Tooltip>
        </CardHeader>
        <div className="flex-1 overflow-hidden flex flex-col">
          <LiveNotificationList logs={logs} />
        </div>
      </Card>

      {/* Drag divider */}
      <div className="h-3 flex items-center justify-center cursor-row-resize shrink-0 group" onMouseDown={onSplitDown}>
        <div className="h-px w-10 rounded-full bg-border/40 group-hover:bg-primary/50 group-hover:w-16 transition-all" />
      </div>

      {/* Bottom: History */}
      <Card className="flex flex-col overflow-hidden flex-1 min-h-0">
        <HistoryPanel refreshKey={historyRefreshKey} />
      </Card>
    </div>
  )
}

// ─── Options Panel ──────────────────────────────────────────────────────────

function OptionsPanel({
  visibility, setVisibility, amount, setAmount, formatsInput, setFormatsInput,
  isFormatsValid, delayRange, setDelayRange, delayMax, setDelayMax,
  telegramLinks, setTelegramLinks, parsedData, setParsedData,
  isFocused, setIsFocused, treeValue, setTreeValue,
  userTarget, setUserTarget,
  noRepeat, setNoRepeat,
  isRunning, hasStopped,
}) {
  const disabled = isRunning || hasStopped

  const handleBlur = () => {
    setIsFocused(false)
    if (!telegramLinks.trim()) { setParsedData(null); return }
    const parsed = parseTelegramLinks(telegramLinks)
    setParsedData(parsed)
  }

  const onTreeChange = (vals) => {
    if (disabled) return
    setTreeValue(vals)
  }

  const display = isFocused ? telegramLinks
    : (parsedData && !parsedData.hasError && parsedData.messageIds.length > 0)
      ? parsedData.messageIds.join(", ") : telegramLinks

  const isPublic  = visibility === "public"
  const isPrivate = visibility === "private"
  const isUserId  = visibility === "userId"

  // Derived from parsed links
  const extractedUsername = parsedData?.extractedUsername || ""
  const extractedChatId   = parsedData?.chatId || ""

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="px-3 py-2.5 border-b border-border shrink-0 space-y-0">
        <span className="text-xs font-semibold">Options</span>
      </CardHeader>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">

          {/* Amount */}
          <Field label="Amount">
            <NumberInput min={1} max={100000} placeholder="e.g. 100"
              value={amount} onChange={v => setAmount(v)} disabled={disabled} className="h-9" />
          </Field>

          {/* Formats */}
          <Field label="Formats (JSON)">
            <Textarea
              value={formatsInput}
              onChange={e => { if (!disabled) setFormatsInput(e.target.value) }}
              placeholder={'["format one", "format two"]'}
              className="min-h-[72px] max-h-[120px] text-sm"
              disabled={disabled}
            />
            {isFormatsValid !== null && (
              <p className={cn("text-[11px] mt-1", isFormatsValid ? "text-success" : "text-destructive")}>
                {isFormatsValid ? "Valid JSON" : "Invalid JSON"}
              </p>
            )}
          </Field>

          {/* Visibility */}
          <Field label="Visibility">
            <div className="flex rounded-lg bg-secondary p-0.5 gap-0.5">
              {[["public", "Public"], ["private", "Private"], ["userId", "User"]].map(([v, l]) => (
                <button key={v}
                  onClick={() => { if (disabled) return; setVisibility(v); setTreeValue([]); setParsedData(null); setTelegramLinks("") }}
                  disabled={disabled}
                  className={cn(
                    "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                    visibility === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  )}>
                  {l}
                </button>
              ))}
            </div>
          </Field>

          {/* Delay */}
          <Field label={`Delay: ${delayRange[0]}s – ${delayRange[1]}s`}>
            <div className="flex items-center gap-2 pt-1">
              <Slider min={0} max={delayMax} step={1} value={delayRange}
                onValueChange={v => { if (!disabled) setDelayRange(v) }} disabled={disabled} className="flex-1" />
              <div style={{ width: 52, flexShrink: 0 }}>
                <NumberInput min={1} max={300} value={delayMax}
                  onChange={v => {
                    const n = Math.max(1, v || 30)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={disabled} className="h-7 px-1 text-center" />
              </div>
            </div>
          </Field>

          {/* No-repeat toggle */}
          <Field label="Repetitive Reports">
            <div className={cn("flex items-center justify-between", disabled && "opacity-50")}>
              <span className="text-xs text-muted-foreground">Allow repeat accounts</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => { if (!disabled) setNoRepeat(v => !v) }}
                className={cn(
                  "h-5 w-9 rounded-full relative transition-colors shrink-0",
                  noRepeat ? "bg-muted-foreground/25" : "bg-primary",
                  disabled && "cursor-not-allowed"
                )}
              >
                <span className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                  noRepeat ? "left-0.5" : "left-[18px]"
                )} />
              </button>
            </div>
          </Field>

          {/* Telegram Links (public + private) */}
          {(isPublic || isPrivate) && (
            <Field label="Telegram Links">
              <Textarea
                value={display}
                onChange={e => { if (!disabled) setTelegramLinks(e.target.value) }}
                onFocus={() => setIsFocused(true)}
                onBlur={handleBlur}
                placeholder={isPublic ? "t.me/user/123, t.me/user/456 …" : "t.me/c/3896228938/1, t.me/c/3896228938/2 …"}
                rows={2}
                disabled={disabled}
                className={cn("min-h-[56px] max-h-[112px] text-sm bg-input", parsedData?.hasError && "border-destructive focus-visible:ring-destructive")}
              />
              <div className="flex items-center justify-between mt-1.5">
                <Button
                  variant="ghost" size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  disabled={disabled}
                  onClick={() => { setTelegramLinks(""); setParsedData(null) }}
                >
                  Clear
                </Button>
                {parsedData && (
                  <span className={cn("text-[11px]", parsedData.hasError ? "text-destructive" : "text-success")}>
                    {parsedData.hasError ? "Parse error" : `${parsedData.messageIds.length} IDs`}
                  </span>
                )}
              </div>
            </Field>
          )}

          {/* Reasons */}
          <Field label="Reasons">
            <ReasonTreeSelect
              treeData={isUserId ? USER_TREE : MSG_TREE}
              value={treeValue} onChange={onTreeChange} disabled={isRunning}
            />
          </Field>

          {/* Public: extracted username (disabled) */}
          {isPublic && (
            <Field label="Chat Username">
              <Input value={extractedUsername} disabled placeholder="Auto-filled from links" className="h-9 bg-input" />
              {parsedData?.usernameConflict && (
                <div className="flex items-center gap-1.5 mt-1.5 text-destructive">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <p className="text-[11px]">Username mismatch across links</p>
                </div>
              )}
            </Field>
          )}

          {/* Private: extracted chat ID (disabled) */}
          {isPrivate && (
            <Field label="Chat ID">
              <Input value={extractedChatId} disabled placeholder="Auto-filled from links (e.g. -1003896228938)" className="h-9 bg-input" />
            </Field>
          )}

          {/* User: username string */}
          {isUserId && (
            <Field label="Username">
              <Input value={userTarget} onChange={e => setUserTarget(e.target.value)} placeholder="@username" disabled={disabled} className="h-9 bg-input" />
            </Field>
          )}

        </div>
      </ScrollArea>
    </Card>
  )
}

// ─── Users Dialog ────────────────────────────────────────────────────────────

function UserRow({ u, onAct, onDel, onPerks }) {
  const status = u.isTerminated ? "terminated" : u.isAuthorized ? "active" : "pending"
  const legacy = !Array.isArray(u.perks)        // no perks field = legacy full access
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(legacy ? PERKS.map(p => p.key) : u.perks)
  const toggle = (k) => setDraft(d => d.includes(k) ? d.filter(x => x !== k) : [...d, k])
  const save = () => { onPerks(u.username, draft); setEditing(false) }
  return (
    <div className="py-3 px-1 border-b border-border/30 last:border-0">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center shrink-0 text-sm font-bold text-muted-foreground uppercase">
          {u.username[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">{u.username}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 capitalize">{status}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant={editing ? "secondary" : "ghost"} className="h-7 w-7 hover:bg-secondary"
                onClick={() => setEditing(v => !v)}>
                <KeyRound className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit permissions</TooltipContent>
          </Tooltip>
          {!u.isAuthorized && !u.isTerminated && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-success hover:bg-success/10"
                  onClick={() => onAct(u.username, "authorize")}>
                  <Check className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Authorize</TooltipContent>
            </Tooltip>
          )}
          {u.isAuthorized && !u.isTerminated && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7 hover:bg-secondary"
                  onClick={() => onAct(u.username, "revoke")}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Revoke access</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => onDel(u.username)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Perk badges (read) */}
      {!editing && (
        <div className="flex flex-wrap gap-1 mt-2 pl-11">
          {legacy
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-medium">All (legacy)</span>
            : u.perks.length
              ? u.perks.map(k => <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-medium">{PERK_LABEL[k] || k}</span>)
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium">No access</span>}
        </div>
      )}

      {/* Perk editor */}
      {editing && (
        <div className="mt-2 pl-11 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {PERKS.map(({ key, label, Icon }) => {
              const on = draft.includes(key)
              return (
                <button key={key} type="button" onClick={() => toggle(key)}
                  className={cn("flex items-center gap-1 px-2 h-7 rounded-md border text-[11px] font-medium transition-colors",
                    on ? "bg-primary text-primary-foreground border-primary" : "bg-secondary/30 border-border text-muted-foreground hover:bg-secondary")}>
                  <Icon className="h-3 w-3" /> {label}
                </button>
              )
            })}
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={save}>Save</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditing(false); setDraft(legacy ? PERKS.map(p => p.key) : u.perks) }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function UsersDialog({ open, onClose }) {
  const [users, setUsers]       = useState([])
  const [loading, setLoading]   = useState(false)
  const [tab, setTab]           = useState("all")
  const [form, setForm]         = useState({ username: "", password: "", perks: [] })
  const [addLoading, setAddLoading] = useState(false)
  const [err, setErr]           = useState("")
  const auth = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" })
  const togglePerk = (k) => setForm(p => ({ ...p, perks: p.perks.includes(k) ? p.perks.filter(x => x !== k) : [...p.perks, k] }))

  const load = async () => {
    setLoading(true)
    try { const r = await fetch("/api/admin/users", { headers: auth() }); const d = await r.json(); setUsers(d.users || []) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (open) { load(); setTab("all"); setErr(""); setForm({ username: "", password: "", perks: [] }) } }, [open])

  const act = async (username, action) => {
    await fetch("/api/admin/users", { method: "PATCH", headers: auth(), body: JSON.stringify({ username, action }) }); load()
  }
  const del = async (username) => {
    await fetch(`/api/admin/users?username=${username}`, { method: "DELETE", headers: auth() }); load()
  }
  const setUserPerks = async (username, perks) => {
    await fetch("/api/admin/users", { method: "PATCH", headers: auth(), body: JSON.stringify({ username, action: "setPerks", perks }) }); load()
  }
  const create = async () => {
    if (!form.username.trim() || !form.password.trim()) { setErr("Both fields are required"); return }
    setAddLoading(true); setErr("")
    try {
      const r = await fetch("/api/admin/users", { method: "POST", headers: auth(), body: JSON.stringify(form) })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || "Failed to create user"); return }
      setForm({ username: "", password: "", perks: [] }); setTab("all"); load()
    } finally { setAddLoading(false) }
  }

  const byTab = {
    all:        users,
    pending:    users.filter(u => !u.isAuthorized && !u.isTerminated),
    active:     users.filter(u => u.isAuthorized && !u.isTerminated),
    terminated: users.filter(u => u.isTerminated),
  }
  const counts = { all: users.length, pending: byTab.pending.length, active: byTab.active.length, terminated: byTab.terminated.length }

  const UserList = ({ items }) => {
    if (loading) return <div className="flex justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
    if (!items.length) return <p className="text-center text-sm text-muted-foreground py-10">No users here</p>
    return (
      <ScrollArea className="h-64">
        <div className="px-1">
          {items.map(u => <UserRow key={u._id} u={u} onAct={act} onDel={del} onPerks={setUserPerks} />)}
        </div>
      </ScrollArea>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="text-lg font-semibold">User Management</DialogTitle>
          <DialogDescription className="mt-1">Manage access to the platform.</DialogDescription>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="flex flex-col">
          <div className="px-6 pt-4 pb-0">
            <TabsList className="w-full">
              {[["all","All"],["pending","Pending"],["active","Active"],["terminated","Terminated"]].map(([v, l]) => (
                <TabsTrigger key={v} value={v} className="flex-1 text-xs gap-1.5">
                  {l}
                  {counts[v] > 0 && (
                    <span className={cn(
                      "text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none",
                      v === "pending"    ? "bg-warning/15 text-warning" :
                      v === "active"     ? "bg-success/15 text-success" :
                      v === "terminated" ? "bg-destructive/15 text-destructive" :
                      "bg-secondary text-muted-foreground"
                    )}>
                      {counts[v]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="px-6 pt-2 pb-4">
            <TabsContent value="all"        className="mt-0"><UserList items={byTab.all} /></TabsContent>
            <TabsContent value="pending"    className="mt-0"><UserList items={byTab.pending} /></TabsContent>
            <TabsContent value="active"     className="mt-0"><UserList items={byTab.active} /></TabsContent>
            <TabsContent value="terminated" className="mt-0"><UserList items={byTab.terminated} /></TabsContent>

            <TabsContent value="add" className="mt-0">
              <div className="space-y-4 py-2">
                {err && (
                  <div className="flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
                    <X className="h-3.5 w-3.5 text-destructive shrink-0" />
                    <p className="text-sm text-destructive">{err}</p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>Username</Label>
                  <Input value={form.username} onChange={e => setForm(p => ({...p, username: e.target.value}))}
                    placeholder="Enter a username" autoFocus />
                </div>
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <Input type="password" value={form.password} onChange={e => setForm(p => ({...p, password: e.target.value}))}
                    placeholder="Enter a password"
                    onKeyDown={e => e.key === "Enter" && create()} />
                </div>
                <div className="space-y-1.5">
                  <Label>Permissions</Label>
                  <p className="text-[11px] text-muted-foreground">Pick what this user is allowed to do. They'll only see these features.</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {PERKS.map(({ key, label, Icon }) => {
                      const on = form.perks.includes(key)
                      return (
                        <button key={key} type="button" onClick={() => togglePerk(key)}
                          className={cn("flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors",
                            on ? "bg-primary text-primary-foreground border-primary" : "bg-secondary/30 border-border text-muted-foreground hover:bg-secondary")}>
                          <Icon className="h-3.5 w-3.5" /> {label}
                          {on && <Check className="h-3 w-3" />}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground pt-1">Created without authorization — approve from the Pending tab.</p>
                </div>
                <Button className="w-full" onClick={create} disabled={addLoading}>
                  {addLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create User
                </Button>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {tab !== "add" ? (
          <div className="px-6 py-4 border-t border-border bg-secondary/10">
            <Button variant="outline" className="w-full" onClick={() => setTab("add")}>
              <Plus className="h-4 w-4" /> Add New User
            </Button>
          </div>
        ) : (
          <div className="px-6 py-4 border-t border-border bg-secondary/10">
            <Button variant="ghost" className="w-full text-muted-foreground"
              onClick={() => { setTab("all"); setErr(""); setForm({ username: "", password: "", perks: [] }) }}>
              ← Back to users
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete Confirmation ────────────────────────────────────────────────────

function DeleteDialog({ session, onConfirm, onCancel }) {
  return (
    <AlertDialog open={!!session}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete session?</AlertDialogTitle>
          <AlertDialogDescription>
            Remove <strong>{session?.name || `Account #${session?.index}`}</strong> permanently. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ─── Download Report Dialog ─────────────────────────────────────────────────

const SITE_KEY = process.env.NEXT_PUBLIC_SITE_KEY || "mirza_omtro"

async function signReport(payload) {
  const text = JSON.stringify(payload)
  const key  = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SITE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig  = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("")
}

// ─── Edit Profile Dialog ────────────────────────────────────────────────────

const RAND_FIRST = ["James","Mary","John","Patricia","Robert","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Charles","Karen","Daniel","Nancy","Matthew","Lisa","Anthony","Betty","Mark","Sandra","Donald","Ashley","Steven","Emily","Andrew","Kimberly","Joshua","Donna","Kevin","Michelle","Brian","Carol","Alex","Olivia","Liam","Emma","Noah","Ava","Lucas","Sophia","Ethan","Mia"]
const RAND_LAST  = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores"]
const randPick = (arr) => arr[Math.floor(Math.random() * arr.length)]

function EditProfileDialog({ open, onClose, session, send, addListener, botOnline, onProfileSaved }) {
  const [firstName,      setFirstName]      = useState("")
  const [lastName,       setLastName]       = useState("")
  const [username,       setUsername]       = useState("")
  const [bio,            setBio]            = useState("")
  const [photo,          setPhoto]          = useState(null)
  const [origUsername,   setOrigUsername]   = useState("")
  const [removePhoto,    setRemovePhoto]    = useState(false)
  const [rngFirst,       setRngFirst]       = useState(false)
  const [rngLast,        setRngLast]        = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [loading,        setLoading]        = useState(true)  // start true — avoids empty-field flash
  const [loadError,      setLoadError]      = useState(null)
  const [result,         setResult]         = useState(null)
  const [otp,            setOtp]            = useState(null)   // { ok, code, text, date, error }
  const [otpLoading,     setOtpLoading]     = useState(false)
  const [otpCopied,      setOtpCopied]      = useState(false)
  const fileRef    = useRef(null)
  const timeoutRef = useRef(null)
  const otpTimeoutRef = useRef(null)

  // Helper: populate fields from DB session as fallback
  const fillFromDb = useCallback((s) => {
    const parts = (s?.name || "").split(" ")
    setFirstName(parts[0] || "")
    setLastName(parts.slice(1).join(" ") || "")
    setUsername(s?.username || "")
    setOrigUsername(s?.username || "")
    setBio("")
    setLoading(false)
  }, [])

  // When dialog opens: fetch live profile data from Telegram
  useEffect(() => {
    if (!open || !session) return
    setLoading(true)
    setLoadError(null)
    setPhoto(null)
    setRemovePhoto(false)
    setResult(null)
    setOtp(null); setOtpLoading(false); setOtpCopied(false)
    clearTimeout(timeoutRef.current)
    clearTimeout(otpTimeoutRef.current)

    if (!botOnline) {
      // Bot offline — fill from DB immediately
      fillFromDb(session)
      setLoadError("Bot offline — showing stored data")
      return
    }

    send({ type: "getProfile", index: session.index })

    // 8s timeout fallback: if bot doesn't reply, fill from DB
    timeoutRef.current = setTimeout(() => {
      setLoading(false)
      fillFromDb(session)
      setLoadError("No response from bot — showing stored data")
    }, 8000)

    return () => clearTimeout(timeoutRef.current)
  }, [open, session, botOnline])

  useEffect(() => {
    if (!open) return

    const rmP = addListener("profileData", msg => {
      if (String(msg.index) !== String(session?.index)) return
      clearTimeout(timeoutRef.current)
      setLoading(false)
      if (msg.ok) {
        setFirstName(msg.firstName || "")
        setLastName(msg.lastName || "")
        setUsername(msg.username || "")
        setOrigUsername(msg.username || "")
        setBio(msg.bio || "")
        setLoadError(null)
        if (msg.photo) setPhoto({ preview: msg.photo, b64: null })
      } else {
        // Bot replied with error (session not active etc.) — fall back to DB
        fillFromDb(session)
        setLoadError(msg.error || "Could not load from Telegram — showing stored data")
      }
    })

    // Handle bot-offline error responses
    const rmErr = addListener("error", msg => {
      clearTimeout(timeoutRef.current)
      setLoading(false)
      fillFromDb(session)
      setLoadError(msg.message || "Bot offline — showing stored data")
    })

    const rmE = addListener("editProfileResult", msg => {
      if (String(msg.index) !== String(session?.index)) return
      setSaving(false)
      setResult({ ok: msg.ok, error: msg.error, action: msg.action, warning: msg.usernameWarning })
      if (msg.ok && msg.name) onProfileSaved?.(msg.index, msg.name)
    })

    const rmOtp = addListener("otpResult", msg => {
      if (String(msg.index) !== String(session?.index)) return
      clearTimeout(otpTimeoutRef.current)
      setOtpLoading(false)
      setOtp(msg)
    })

    return () => { rmP(); rmErr(); rmE(); rmOtp(); clearTimeout(timeoutRef.current); clearTimeout(otpTimeoutRef.current) }
  }, [open, session, addListener, fillFromDb])

  const fetchOtp = () => {
    if (!session) return
    if (!botOnline) { setOtp({ ok: false, error: "Bot offline" }); return }
    setOtp(null); setOtpCopied(false); setOtpLoading(true)
    send({ type: "fetchOtp", index: session.index })
    clearTimeout(otpTimeoutRef.current)
    otpTimeoutRef.current = setTimeout(() => {
      setOtpLoading(false)
      setOtp({ ok: false, error: "No response from bot" })
    }, 8000)
  }

  const copyOtp = () => {
    if (!otp?.code) return
    try { navigator.clipboard?.writeText(otp.code) } catch {}
    setOtpCopied(true)
    setTimeout(() => setOtpCopied(false), 1200)
  }

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setRemovePhoto(false)
    const preview = URL.createObjectURL(file)
    const reader  = new FileReader()
    reader.onload = (ev) => setPhoto({ preview, b64: ev.target.result.split(",")[1] })
    reader.readAsDataURL(file)
  }

  const toggleRemovePhoto = () => {
    setRemovePhoto(v => {
      const next = !v
      if (next) setPhoto(null)   // mark current photo for removal
      return next
    })
  }

  const handleSave = () => {
    if (!session) return
    setSaving(true); setResult(null)
    send({
      type: "editProfile", index: session.index,
      firstName: firstName.trim(), lastName: lastName.trim(),
      username: username.trim().replace(/^@/, ""),
      bio: bio.trim(), photo: photo?.b64 || null,
      removePhoto: removePhoto && !photo?.b64,
    })
  }

  const usernameCleared = origUsername && !username.trim()

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)] sm:w-full p-0 overflow-hidden gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="text-base flex items-center gap-2">
            <Pencil className="h-4 w-4 text-primary" /> Edit Profile
          </DialogTitle>
          <DialogDescription className="text-xs">Changes apply directly to the Telegram account.</DialogDescription>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
          className="px-5 py-5 flex flex-col items-center gap-5"
        >
          {/* ── Avatar ── */}
          <div className="flex flex-col items-center gap-2.5">
            <div className="relative group">
              <motion.button
                type="button" onClick={() => fileRef.current?.click()}
                whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}
                className={cn(
                  "h-20 w-20 rounded-full overflow-hidden border-2 transition-colors relative",
                  removePhoto ? "border-destructive/60 bg-destructive/5" : "border-border bg-secondary hover:border-ring"
                )}
              >
                {loading
                  ? <div className="h-full w-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" /></div>
                  : photo?.preview
                    ? <img src={photo.preview} alt="" className="h-full w-full object-cover" />
                    : <div className={cn("h-full w-full flex items-center justify-center", removePhoto ? "text-destructive/40" : "text-muted-foreground/30")}>
                        {removePhoto ? <ImageOff className="h-7 w-7" /> : <Users className="h-7 w-7" />}
                      </div>
                }
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Camera className="h-5 w-5 text-white drop-shadow" />
                </div>
              </motion.button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />

            <div className="flex gap-1.5">
              <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs gap-1.5"
                onClick={() => fileRef.current?.click()}>
                <Camera className="h-3 w-3" /> {photo?.b64 ? "Change" : "Upload"}
              </Button>
              <Button type="button" variant="outline" size="sm"
                onClick={toggleRemovePhoto}
                className={cn("h-7 px-2.5 text-xs gap-1.5",
                  removePhoto ? "border-destructive/50 text-destructive bg-destructive/10" : "text-muted-foreground")}>
                <ImageOff className="h-3 w-3" /> {removePhoto ? "Keep photo" : "Remove"}
              </Button>
            </div>
            <AnimatePresence>
              {removePhoto && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  className="text-[10px] text-destructive/70">
                  Photo will be removed on save
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* ── Fields ── */}
          <div className="w-full flex flex-col gap-3.5">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">First name</Label>
                <div className="flex gap-1.5">
                  <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First" className="h-9 text-sm flex-1" />
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Random first name"
                    disabled={rngFirst}
                    onClick={() => { setRngFirst(true); setTimeout(() => { setFirstName(randPick(RAND_FIRST)); setRngFirst(false) }, 250) }}>
                    {rngFirst ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Dices className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Last name</Label>
                <div className="flex gap-1.5">
                  <Input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last" className="h-9 text-sm flex-1" />
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Random last name"
                    disabled={rngLast}
                    onClick={() => { setRngLast(true); setTimeout(() => { setLastName(randPick(RAND_LAST)); setRngLast(false) }, 250) }}>
                    {rngLast ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Dices className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-muted-foreground">Username</Label>
                <AnimatePresence>
                  {usernameCleared && (
                    <motion.span
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="text-[10px] text-warning">will be removed</motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="relative">
                <AtSign className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
                <Input value={username} onChange={e => setUsername(e.target.value.replace(/^@/, ""))}
                  placeholder="username (leave empty to remove)" className="h-9 text-sm pl-7" />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-muted-foreground">Bio</Label>
                <span className="text-[10px] text-muted-foreground/40 tabular-nums">{bio.length}/70</span>
              </div>
              <Input value={bio} onChange={e => setBio(e.target.value)} placeholder="About me…" className="h-9 text-sm" maxLength={70} />
            </div>

            {/* ── Last login code (OTP) — fetched from Telegram service notifs (777000) ── */}
            <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <KeyRound className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="text-[11px] font-medium text-muted-foreground truncate">Last login code</span>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs gap-1.5 shrink-0"
                  onClick={fetchOtp} disabled={otpLoading}>
                  {otpLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  Fetch
                </Button>
              </div>
              <AnimatePresence mode="wait">
                {otp?.ok ? (
                  <motion.div key="otpok" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <code className="text-xl font-bold tabular-nums tracking-[0.2em] text-foreground">{otp.code}</code>
                      <button type="button" onClick={copyOtp} title="Copy code"
                        className="text-muted-foreground hover:text-foreground transition-colors">
                        {otpCopied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                      {otp.date && <span className="ml-auto text-[10px] text-muted-foreground/50">{new Date(otp.date).toLocaleString()}</span>}
                    </div>
                    {otp.text && <p className="text-[10px] leading-snug text-muted-foreground/60 line-clamp-3">{otp.text}</p>}
                  </motion.div>
                ) : otp ? (
                  <motion.p key="otperr" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-[11px] text-destructive flex items-center gap-1.5">
                    <X className="h-3 w-3 shrink-0" /> {otp.error || "No login code found"}
                  </motion.p>
                ) : (
                  <p className="text-[10px] text-muted-foreground/40 leading-snug">Fetches the latest login code Telegram sent to this account (from 777000).</p>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence mode="wait">
              {loadError && !result && (
                <motion.p key="loaderr" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="text-[11px] text-warning flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0" /> {loadError}
                </motion.p>
              )}
              {result && (
                <motion.p key="result" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className={cn("text-xs flex items-center gap-1.5",
                    !result.ok ? "text-destructive" : result.warning ? "text-warning" : "text-success")}>
                  {!result.ok ? <X className="h-3.5 w-3.5 shrink-0" />
                    : result.warning ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                  {!result.ok ? (result.error || "Update failed.")
                    : result.warning ? `Saved, but username: ${result.warning}`
                    : "Profile updated successfully."}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        <DialogFooter className="gap-2 px-5 py-4 border-t border-border/60">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DownloadDialog({ open, onClose, logs, reportMeta }) {
  const download = async () => {
    const results = logs
      .filter(l => l.type === "reportProgress")
      .map((l, i) => ({
        index:   i + 1,
        account: l.client || l.clientName || null,
        worked:  l.worked,
        msgIds:  Array.isArray(l.msgIds) ? l.msgIds : (l.messageId ? [l.messageId] : null),
        reason:  l.reasonLabel || l.reason || null,
        format:  l.format || null,
        error:   l.error || null,
        time:    l.time || l.timestamp || null,
      }))

    const payload = {
      owner:       "Mirza @omtro",
      telegram:    "t.me/mirzyave",
      panel:       "mirza",
      hash:        reportMeta?.hash,
      type:        reportMeta?.type,
      sessions:    reportMeta?.sessionCount,
      reasons:     reportMeta?.reasons,
      completedAt: new Date().toISOString(),
      results,
    }

    const sig  = await signReport(payload)
    const file = { ...payload, _sig: sig }

    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `mirza-report-${(reportMeta?.hash || "export").slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Report Complete</DialogTitle>
          <DialogDescription>
            The report finished. Download the full results as a JSON file or dismiss.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex gap-2 mt-2">
          <Button variant="ghost" className="flex-1" onClick={onClose}>Dismiss</Button>
          <Button className="flex-1" onClick={download}>
            <Download className="h-4 w-4" /> Download JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Join Dialog ───────────────────────────────────────────────────────────

function JoinDialog({ visible, onClose, onMinimize, selected, sessions, send, addListener }) {
  const [link, setLink]               = useState("")
  const [linkError, setLinkError]     = useState("")
  const [delayRange, setDelayRange]   = useState([2, 5])
  const [delayMax, setDelayMax]       = useState(15)
  const [running, setRunning]         = useState(false)

  useEffect(() => {
    const rmC = addListener("joinComplete", () => setRunning(false))
    const rmE = addListener("joinError",    () => setRunning(false))
    return () => { rmC(); rmE() }
  }, [addListener])

  const validate = () => {
    const l = link.trim()
    if (!l) return "Paste a Telegram link"
    if (!l.includes("t.me/")) return "Must be a t.me link (public or invite)"
    return ""
  }

  const handleJoin = () => {
    const err = validate()
    if (err) { setLinkError(err); return }
    setLinkError("")
    setRunning(true)
    send({ type: "joinChat", clients: selected, link: link.trim(), delayMin: delayRange[0], delayMax: delayRange[1] })
  }

  const clientCount = selected.length

  return (
    <Dialog open={visible} onOpenChange={v => { if (!v) (running ? onMinimize() : onClose()) }}>
      <DialogContent className="w-[28rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-auto flex flex-col gap-0 p-0 min-w-0 min-h-0 sm:resize sm:min-w-[340px] sm:min-h-[260px]">
        <MinimizeBtn onClick={onMinimize} />
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-foreground" />
            Join Chat
          </DialogTitle>
          <DialogDescription>
            {clientCount} account{clientCount !== 1 ? "s" : ""} selected · paste any t.me link to join them all
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 space-y-4">
          {/* Link */}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Telegram Link</Label>
            <Input
              value={link}
              onChange={e => { setLink(e.target.value); setLinkError("") }}
              placeholder="https://t.me/+ABC123  or  https://t.me/username"
              disabled={running}
            />
            {linkError && <p className="text-[11px] text-destructive mt-1">{linkError}</p>}
          </div>

          {/* Delay */}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Delay: {delayRange[0]}s – {delayRange[1]}s
            </Label>
            <div className="flex items-center gap-2 pt-1">
              <Slider
                min={0} max={delayMax} step={1} value={delayRange}
                onValueChange={v => { if (!running) setDelayRange(v) }}
                disabled={running} className="flex-1"
              />
              <div style={{ width: 52, flexShrink: 0 }}>
                <NumberInput min={0} max={300} value={delayMax}
                  onChange={v => {
                    const n = Math.max(0, v || 15)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={running} className="h-7 px-1 text-center" />
              </div>
            </div>
          </div>
        </div>

        {running && (
          <div className="px-6 pb-2">
            <p className="text-xs text-muted-foreground/60 text-center">Joining… watch Live Events panel for progress</p>
          </div>
        )}

        <div className="px-6 py-4 border-t border-border flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={running}>
            Close
          </Button>
          <Button className="flex-1" onClick={handleJoin} disabled={running || !clientCount}>
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Joining…</>
              : <><UserPlus className="h-4 w-4" /> Join {clientCount} Account{clientCount !== 1 ? "s" : ""}</>
            }
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Leave Dialog ──────────────────────────────────────────────────────────

function LeaveDialog({ visible, onClose, onMinimize, selected, send, addListener }) {
  const [chat, setChat]               = useState("")
  const [chatError, setChatError]     = useState("")
  const [delayRange, setDelayRange]   = useState([2, 5])
  const [delayMax, setDelayMax]       = useState(15)
  const [running, setRunning]         = useState(false)

  useEffect(() => {
    const rmC = addListener("leaveComplete", () => setRunning(false))
    const rmE = addListener("leaveError",    () => setRunning(false))
    return () => { rmC(); rmE() }
  }, [addListener])

  const validate = () => {
    const c = chat.trim()
    if (!c) return "Enter a chat ID or username"
    return ""
  }

  const handleLeave = () => {
    const err = validate()
    if (err) { setChatError(err); return }
    setChatError("")
    setRunning(true)
    send({ type: "leaveChat", clients: selected, chat: chat.trim(), delayMin: delayRange[0], delayMax: delayRange[1] })
  }

  const clientCount = selected.length

  return (
    <Dialog open={visible} onOpenChange={v => { if (!v) (running ? onMinimize() : onClose()) }}>
      <DialogContent className="w-[28rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-auto flex flex-col gap-0 p-0 min-w-0 min-h-0 sm:resize sm:min-w-[340px] sm:min-h-[260px]">
        <MinimizeBtn onClick={onMinimize} />
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <UserMinus className="h-4 w-4 text-destructive" />
            Leave Chat
          </DialogTitle>
          <DialogDescription>
            {clientCount} account{clientCount !== 1 ? "s" : ""} selected · enter a chat ID or username to leave
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 space-y-4">
          {/* Chat ID / username */}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Chat ID or Username</Label>
            <Input
              value={chat}
              onChange={e => { setChat(e.target.value); setChatError("") }}
              placeholder="-1001234567890  or  @username  or  username"
              disabled={running}
            />
            {chatError && <p className="text-[11px] text-destructive mt-1">{chatError}</p>}
          </div>

          {/* Delay */}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Delay: {delayRange[0]}s – {delayRange[1]}s
            </Label>
            <div className="flex items-center gap-2 pt-1">
              <Slider
                min={0} max={delayMax} step={1} value={delayRange}
                onValueChange={v => { if (!running) setDelayRange(v) }}
                disabled={running} className="flex-1"
              />
              <div style={{ width: 52, flexShrink: 0 }}>
                <NumberInput min={0} max={300} value={delayMax}
                  onChange={v => {
                    const n = Math.max(0, v || 15)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={running} className="h-7 px-1 text-center" />
              </div>
            </div>
          </div>
        </div>

        {running && (
          <div className="px-6 pb-2">
            <p className="text-xs text-muted-foreground/60 text-center">Leaving… watch Live Events panel for progress</p>
          </div>
        )}

        <div className="px-6 py-4 border-t border-border flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={running}>
            Close
          </Button>
          <Button variant="destructive" className="flex-1" onClick={handleLeave} disabled={running || !clientCount}>
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Leaving…</>
              : <><UserMinus className="h-4 w-4" /> Leave {clientCount} Account{clientCount !== 1 ? "s" : ""}</>
            }
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Raid Dialog ────────────────────────────────────────────────────────────

function RaidDialog({ visible, onClose, onMinimize, selected, send, addListener, showToast }) {
  const [mode, setMode]             = useState("chat")       // "chat" | "vc"
  const [chat, setChat]             = useState("")
  const [messages, setMessages]     = useState([""])
  const [count, setCount]           = useState(null)        // # of messages to send (null = one per client)
  const [replyMsgId, setReplyMsgId] = useState("")          // optional fixed message id
  const [replyUser, setReplyUser]   = useState("")          // optional user → reply to their latest msg
  const [delayRange, setDelayRange] = useState([2, 5])
  const [delayMax, setDelayMax]     = useState(15)
  const [photos, setPhotos]         = useState([])          // [{b64, preview}]
  const [photoRatio, setPhotoRatio] = useState(50)          // % of sends that are photos
  const [running, setRunning]       = useState(false)
  const [done, setDone]             = useState(false)
  const [total, setTotal]           = useState(0)
  const [sentCount, setSentCount]   = useState(0)

  const addPhotos = (fileList) => {
    Array.from(fileList || []).filter(f => f.type.startsWith("image/")).forEach(file => {
      const reader = new FileReader()
      reader.onload = e => setPhotos(p => [...p, { b64: e.target.result.split(",")[1], preview: e.target.result }])
      reader.readAsDataURL(file)
    })
  }

  useEffect(() => {
    const rmC = addListener("raidComplete", msg => {
      setRunning(false); setDone(true); setTotal(msg.total || 0); setSentCount(msg.sent ?? msg.total ?? 0)
    })
    return () => rmC()
  }, [addListener])

  const addMsg    = () => setMessages(p => [...p, ""])
  const removeMsg = (i) => setMessages(p => p.length > 1 ? p.filter((_, j) => j !== i) : p)
  const updateMsg = (i, v) => setMessages(p => p.map((m, j) => j === i ? v : m))

  const handleRun = () => {
    if (!chat.trim()) { showToast(mode === "vc" ? "Enter the voice chat (call) link/ID" : "Enter a chat username or ID", "error"); return }
    const validMsgs = messages.map(m => m.trim()).filter(Boolean)
    // Photos are chat-only (VC group-call messages are text); allow photo-only raids.
    const usePhotos = mode === "chat" && photos.length > 0
    if (!validMsgs.length && !usePhotos) { showToast("Enter a message or add a photo", "error"); return }
    if (!selected.length) { showToast("Select accounts first", "error"); return }
    setRunning(true); setDone(false)
    send({
      type: "raid", mode, clients: selected, chat: chat.trim(), messages: validMsgs,
      count: count && count > 0 ? count : selected.length,
      // Reply targets are chat-only; voice-chat messages don't support them.
      replyToMsgId: mode === "chat" ? (replyMsgId.trim() || null) : null,
      replyToUser:  mode === "chat" ? (replyUser.trim()  || null) : null,
      photos: usePhotos ? photos.map(p => p.b64) : undefined,
      photoRatio: usePhotos ? photoRatio : undefined,
      delayMin: delayRange[0], delayMax: delayRange[1],
    })
  }

  const clientCount = selected.length
  const effectiveCount = count && count > 0 ? count : clientCount

  return (
    <Dialog open={visible} onOpenChange={v => { if (!v) (running ? onMinimize() : onClose()) }}>
      <DialogContent className="w-[28rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-auto flex flex-col gap-0 p-0 min-w-0 min-h-0 sm:resize sm:min-w-[340px] sm:min-h-[260px]">
        <MinimizeBtn onClick={onMinimize} />
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            {mode === "vc" ? <PhoneCall className="h-4 w-4 text-destructive" /> : <Zap className="h-4 w-4 text-destructive" />}
            {mode === "vc" ? "Raid Voice Chat" : "Raid Chat"}
          </DialogTitle>
          <DialogDescription>
            {mode === "vc"
              ? <>{effectiveCount} message{effectiveCount !== 1 ? "s" : ""} into the call from in-call accounts — each picks a random message</>
              : <>{effectiveCount} message{effectiveCount !== 1 ? "s" : ""} across {clientCount} account{clientCount !== 1 ? "s" : ""} — each picks a random message</>}
          </DialogDescription>
        </DialogHeader>

        {/* Mode toggle: normal chat raid vs voice-chat (group call) raid */}
        <div className="px-6 pt-4">
          <div className="flex gap-1 p-1 rounded-lg bg-secondary/50 border border-border/30">
            {[["chat", "Chat", Zap], ["vc", "Voice Chat", PhoneCall]].map(([v, l, Ico]) => (
              <button key={v} type="button" onClick={() => { if (!running) setMode(v) }}
                className={cn("flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-sm font-medium transition-all",
                  mode === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                <Ico className="h-3.5 w-3.5" /> {l}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          {mode === "vc" && (
            <div className="flex items-start gap-2 rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-[11px] text-muted-foreground">
              <PhoneCall className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
              <span>Selected accounts must already be in this voice chat — join it from the <span className="text-foreground">Voice chat</span> window first. Messages are sent into the call.</span>
            </div>
          )}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{mode === "vc" ? "Voice Chat (call)" : "Target Chat"}</Label>
            <Input
              value={chat}
              onChange={e => setChat(e.target.value)}
              placeholder="-1001234567890  or  @username  or  username"
              disabled={running}
              className="mt-1.5"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Messages ({messages.length})
              </Label>
              <Button size="icon" variant="ghost" className="h-5 w-5" onClick={addMsg} disabled={running}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="space-y-2 max-h-[220px] overflow-y-auto pr-0.5">
              {messages.map((m, i) => (
                <div key={i} className="flex gap-1.5 items-start">
                  <Textarea
                    value={m}
                    onChange={e => updateMsg(i, e.target.value)}
                    placeholder={`Message ${i + 1}…`}
                    disabled={running}
                    className="min-h-[60px] max-h-[120px] flex-1 text-sm resize-none"
                  />
                  {messages.length > 1 && (
                    <Button size="icon" variant="ghost" className="h-7 w-7 mt-0.5 text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeMsg(i)} disabled={running}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Photos (chat raid only) + text/photo ratio */}
          {mode === "chat" && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Photos ({photos.length})</Label>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1" onClick={() => document.getElementById("raid-photos")?.click()} disabled={running}>
                  <ImageIcon className="h-3 w-3" /> Add
                </Button>
              </div>
              <input id="raid-photos" type="file" accept="image/*" multiple className="hidden"
                onChange={e => { addPhotos(e.target.files); e.target.value = "" }} />
              {photos.length === 0 ? (
                <p className="text-[10px] text-muted-foreground/40">Optional — attach photos to mix into the raid.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {photos.map((p, i) => (
                      <div key={i} className="relative h-12 w-12 rounded-md overflow-hidden border border-border/50 group">
                        <img src={p.preview} alt="" className="h-full w-full object-cover" />
                        <button onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))} disabled={running}
                          className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                          <X className="h-3.5 w-3.5 text-white" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {messages.some(m => m.trim()) && (
                    <div className="mt-2.5">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Text {100 - photoRatio}%</span>
                        <span>Photo {photoRatio}%</span>
                      </div>
                      <Slider min={0} max={100} step={5} value={[photoRatio]} onValueChange={([v]) => setPhotoRatio(v)} disabled={running} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* How many messages to send total (round-robin across clients) */}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Messages to send
            </Label>
            <div className="pt-1.5">
              <NumberInput min={1} max={100000} value={count}
                placeholder={`${clientCount} (one per account)`}
                onChange={v => setCount(v)} disabled={running} className="h-9" />
            </div>
            <p className="text-[10px] text-muted-foreground/50 mt-1">Total messages, cycled across selected accounts. Blank = one per account.</p>
          </div>

          {/* Optional reply target — chat raids only (voice-chat messages can't reply) */}
          {mode === "chat" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Reply to Msg ID</Label>
                  <Input
                    value={replyMsgId}
                    onChange={e => setReplyMsgId(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="optional"
                    disabled={running || !!replyUser.trim()}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Reply to User</Label>
                  <Input
                    value={replyUser}
                    onChange={e => setReplyUser(e.target.value)}
                    placeholder="@user or id"
                    disabled={running}
                    className="mt-1.5"
                  />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground/50 -mt-2">
                User takes priority: replies always target that user's <span className="text-muted-foreground/70">latest</span> message (survives deletions).
              </p>
            </>
          )}

          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Delay: {delayRange[0]}s – {delayRange[1]}s
            </Label>
            <div className="flex items-center gap-2 pt-1.5">
              <Slider
                min={0} max={delayMax} step={1} value={delayRange}
                onValueChange={v => { if (!running) setDelayRange(v) }}
                disabled={running} className="flex-1"
              />
              <div style={{ width: 52, flexShrink: 0 }}>
                <NumberInput min={0} max={300} value={delayMax}
                  onChange={v => {
                    const n = Math.max(0, v || 15)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={running} className="h-7 px-1 text-center" />
              </div>
            </div>
          </div>

          {done && (
            <p className="text-xs text-success text-center">
              Raid complete — {sentCount}/{total} message{total !== 1 ? "s" : ""} sent
            </p>
          )}
          {running && (
            <p className="text-xs text-muted-foreground/60 text-center">Raiding… watch Live Events panel for progress</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={running}>Close</Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={handleRun}
            disabled={running || !clientCount}
          >
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Raiding…</>
              : <><Zap className="h-4 w-4" /> Run Raid</>
            }
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}


// ─── VC Dialog ───────────────────────────────────────────────────────────────

function VCDialog({ visible, onClose, onMinimize, selected, sessions, send, addListener, showToast }) {
  const [phase, setPhase]         = useState("setup")   // "setup" | "resolving" | "active"
  const [chat, setChat]           = useState("")
  const [chatError, setChatError] = useState("")
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved]   = useState([])         // [{index, name, ok, title, error}]
  const [clientStatuses, setClientStatuses] = useState({}) // {index: "joining"|"joined"|"failed"}
  const [mutedClients, setMutedClients] = useState({})      // {index: true} → server-muted
  const [covertClients, setCovertClients] = useState({})    // {index: true} → covert speak (shown muted, heard)
  const [joinError, setJoinError] = useState(null)

  // Audio state
  const [micMuted,  setMicMuted]  = useState(false)
  const [streaming, setStreaming] = useState(false)
  // Start with aggressive denoise + boost for crystal-clear, louder voice by default
  const [effects, setEffects]     = useState({ gain: 6.0, bass: 0.0, treble: 0.0, pitch: 0.0, robotic: 0.0, thickness: 0.0, gate: 0.0, sharpen: 0.4, compress: 0.6, crush: 0.5, denoise: 0.85 })
  const audioRef = useRef({ ctx: null, stream: null, node: null })
  // Media playback engine: a <video>/<audio> element OR a screen-share stream feeds
  // the SAME capture worklet → PCM frames → server → unmuted clients (so a file or
  // screen plays exactly like the live mic, on whichever clients you've unmuted).
  const playbackEngineRef = useRef(null)   // screen-share engine { ctx, node, stream }
  const playbackStateRef  = useRef({ cancelled: false, paused: false, seekSample: null })  // audio-file loop flags
  const fileRawRef        = useRef(null)   // decoded Float32Array (for seeking)
  const fileEncodedRef    = useRef(null)  // pre-encoded base64 chunks to eliminate encoding overhead during playback
  const fileLoopRef       = useRef(false)  // current loop setting (read inside the async loop)
  const mediaRecRef       = useRef(null)   // { rec, stream, el, url } for live video/screen
  const videoElRef        = useRef(null)   // <video> element driving a video-file stream
  const [playingFile, setPlayingFile] = useState(false)
  const [filePaused, setFilePaused]   = useState(false)
  const [fileLoop, setFileLoop]       = useState(false)
  const [filePos, setFilePos]         = useState(0)   // 0..1 playback position
  const [fileDur, setFileDur]         = useState(0)   // seconds
  const [screenSharing, setScreenSharing] = useState(false)
  // Server-side VIDEO play (picture + audio) on an unmuted client via pytgcalls
  const [videoBusy, setVideoBusy]       = useState(false)
  const [videoPlaying, setVideoPlaying] = useState(false)
  // Voice looper: record mic frames to a buffer, then loop them out to the clients
  const recordBufferRef = useRef([])          // [Int16Array] captured 40ms frames
  const recordingRef = useRef(false)
  const loopingRef   = useRef(false)
  const loopTimerRef = useRef(null)
  const [recording, setRecording] = useState(false)
  const [looping, setLooping]     = useState(false)
  // Video presentation (one presenter account streams a video file into the call)
  const micMutedRef = useRef(false)
  const effectsRef  = useRef(effects)

  useEffect(() => { micMutedRef.current = micMuted }, [micMuted])
  useEffect(() => {
    effectsRef.current = effects
    if (phase === "active") send({ type: "vcSetEffects", ...effects })
  }, [effects])

  // ── Keep the audio flowing when the browser is minimized / the tab is hidden ──
  // Backgrounded tabs have their timers throttled to ~1/s and can be frozen outright,
  // which stalls the mic / file / loop sends. A tab that is *playing audio* is exempt,
  // so while we're in a call we keep a sub-audible 18 Hz tone alive WHENEVER the tab is
  // hidden — inaudible on any real speaker, and fully silent while the tab is visible
  // (so you never hear it). This keeps every send path running, minimized or not.
  useEffect(() => {
    if (phase !== "active") return
    let ctx, osc, gain, onVis
    try {
      ctx  = new (window.AudioContext || window.webkitAudioContext)()
      osc  = ctx.createOscillator()
      gain = ctx.createGain()
      osc.frequency.value = 18
      gain.gain.value = 0
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start()
      ctx.resume().catch(() => {})
      onVis = () => {
        try {
          if (ctx.state === "suspended") ctx.resume().catch(() => {})
          gain.gain.setTargetAtTime(document.hidden ? 0.006 : 0.0, ctx.currentTime, 0.05)
        } catch {}
      }
      document.addEventListener("visibilitychange", onVis)
      onVis()
    } catch {}
    return () => {
      try { document.removeEventListener("visibilitychange", onVis) } catch {}
      try { osc && osc.stop() } catch {}
      try { ctx && ctx.close() } catch {}
    }
  }, [phase])

  // Stop audio only when the dialog is fully closed (unmounted), NOT when minimized —
  // minimizing keeps the component mounted so the mic/stream keeps running.
  useEffect(() => {
    return () => stopAudio()
  }, [])

  useEffect(() => {
    const rmR = addListener("vcResolved",     msg => { setResolving(false); setResolved(msg.results || []) })
    const rmC = addListener("vcClientStatus", msg => {
      setClientStatuses(p => ({ ...p, [msg.index]: msg.status }))
      if (msg.status === "joined") setPhase("active")
    })
    const rmCov = addListener("vcCovertStatus", msg => {
      if (msg.error) { showToast(msg.error, "error"); return }
      setCovertClients(p => ({ ...p, [msg.index]: !!msg.on }))
      setMutedClients(p => ({ ...p, [msg.index]: !msg.on }))   // covert on = transmitting
    })
    const rmMedia = addListener("vcMediaStatus", msg => {
      if (msg.error) { showToast(msg.error, "error"); stopMedia() }
    })
    return () => { rmR(); rmC(); rmCov(); rmMedia() }
  }, [addListener])

  const handleResolve = () => {
    if (!chat.trim()) { setChatError("Enter a chat username or ID"); return }
    setChatError(""); setResolving(true); setResolved([])
    send({ type: "vcResolve", clients: selected, chat: chat.trim() })
  }

  const handleJoin = () => {
    // Prefer the ref (_id) echoed back by the resolver; fall back to index→_id lookup
    const okClients = resolved.filter(r => r.ok).map(r => {
      if (r.ref) return String(r.ref)
      const s = sessions.find(ss => ss.index === r.index)
      return s ? s._id.toString() : null
    }).filter(Boolean)
    if (!okClients.length) { showToast("No clients resolved successfully", "error"); return }
    // Optimistically flip every joining client into the active grid
    setClientStatuses(p => {
      const next = { ...p }
      resolved.filter(r => r.ok).forEach(r => { next[r.index] = "joining" })
      return next
    })
    // All clients join MUTED by default — unmute them one by one
    setMutedClients(() => {
      const m = {}
      resolved.filter(r => r.ok).forEach(r => { m[r.index] = true })
      return m
    })
    setPhase("active")
    send({ type: "vcJoin", clients: okClients, chat: chat.trim() })
  }

  const handleLeave = () => {
    send({ type: "vcLeave" })
    stopAudio()
    onClose()
  }

  // Per-client mic: mutes/unmutes on Telegram AND stops streaming our audio there
  const toggleClientMute = (idx) => {
    // a normal mute also turns covert OFF for that client
    if (covertClients[idx]) setCovertClients(p => ({ ...p, [idx]: false }))
    setMutedClients(prev => {
      const muted = !prev[idx]
      send({ type: "vcMuteClients", [muted ? "mute" : "unmute"]: [idx] })
      return { ...prev, [idx]: muted }
    })
  }

  // Magic covert speak: transmit while the account shows the self-muted icon
  const toggleCovert = (idx) => {
    setCovertClients(prev => {
      const on = !prev[idx]
      send({ type: "vcCovert", index: idx, on })
      setMutedClients(m => ({ ...m, [idx]: !on }))   // optimistic: covert on = transmitting
      return { ...prev, [idx]: on }
    })
  }

  const joinedIdxs = () => resolved.filter(r => (clientStatuses[r.index] || "") === "joined").map(r => r.index)
  const muteAll = () => {
    const idxs = joinedIdxs(); if (!idxs.length) return
    send({ type: "vcMuteClients", mute: idxs })
    setMutedClients(prev => { const n = { ...prev }; idxs.forEach(i => { n[i] = true }); return n })
  }
  const unmuteAll = () => {
    const idxs = joinedIdxs(); if (!idxs.length) return
    send({ type: "vcMuteClients", unmute: idxs })
    setMutedClients(prev => { const n = { ...prev }; idxs.forEach(i => { n[i] = false }); return n })
  }

  // ── Audio capture ──────────────────────────────────────────────────────────

  function base64Encode(buffer) {
    let binary = ""
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  // AudioWorklet runs on the audio render thread → glitch-free capture. It buffers
  // mic input into steady 1920-sample (40 ms) chunks and posts them to the main
  // thread. Larger chunks = half the WS messages → less main-thread send jitter
  // (the server re-chunks to 20 ms frames anyway and has a deep jitter buffer).
  const WORKLET_SRC = `
    class VCCapture extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(1920); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === 1920) { this.port.postMessage(this.buf.slice()); this.n = 0; }
          }
        }
        return true;
      }
    }
    registerProcessor('vc-capture', VCCapture);
  `

  const startAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      })
      const ctx = new AudioContext({ sampleRate: 48000 })
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }))
      await ctx.audioWorklet.addModule(blobUrl)
      URL.revokeObjectURL(blobUrl)

      const source = ctx.createMediaStreamSource(stream)
      const node   = new AudioWorkletNode(ctx, "vc-capture")

      node.port.onmessage = (e) => {
        if (micMutedRef.current) return
        const float32 = e.data
        const int16   = new Int16Array(float32.length)
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]))
          int16[i] = s < 0 ? s * 32768 : s * 32767
        }
        if (recordingRef.current) recordBufferRef.current.push(int16)   // secretly capture while live
        // Stagger mic sends by 20ms from file playback to avoid collision/burst when both are active
        // File sends at T=0,40,80ms → mic sends at T=20,60,100ms → no contention, smooth mixing
        setTimeout(() => {
          if (!micMutedRef.current) send({ type: "vcAudio", data: base64Encode(int16.buffer) })
        }, 20)
      }

      source.connect(node)
      // Do NOT connect to destination — that would echo the mic out the local speakers.
      audioRef.current = { ctx, stream, node }
      setStreaming(true)
    } catch (err) {
      showToast(`Mic error: ${err.message}`, "error")
    }
  }

  const stopAudio = () => {
    stopPlayback()   // stop any file/screen playback
    // Stop the looper
    loopingRef.current = false; recordingRef.current = false
    setLooping(false); setRecording(false)
    if (loopTimerRef.current) { clearInterval(loopTimerRef.current); loopTimerRef.current = null }
    recordBufferRef.current = []
    // Stop the mic capture
    const { ctx, stream, node } = audioRef.current
    if (node) { try { node.port.onmessage = null; node.disconnect() } catch {} }
    if (stream) stream.getTracks().forEach(t => t.stop())
    if (ctx) ctx.close().catch(() => {})
    audioRef.current = { ctx: null, stream: null, node: null }
    setStreaming(false)
  }

  // ── Live media (video file / screen) → MediaRecorder → bot → ntgcalls publish ─
  // Encodes the picture+sound to webm and streams chunks to the bot, which pipes
  // them into ffmpeg so the actual VIDEO shows up in the call (not just audio).
  const startMediaStream = (stream, el, url) => {
    if (typeof MediaRecorder === "undefined") {
      showToast("This browser can't record media", "error")
      try { stream.getTracks().forEach(t => t.stop()) } catch {}
      if (url) URL.revokeObjectURL(url)
      return false
    }
    let mime = "video/webm;codecs=vp8,opus"
    if (!MediaRecorder.isTypeSupported(mime)) mime = MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : ""
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    const hasAudio = stream.getAudioTracks().length > 0   // media sound replaces the mic; if none, mic stays live
    send({ type: "vcMediaStart", hasAudio })   // backend spawns ffmpeg; only now that we know we can record
    rec.ondataavailable = async (ev) => {
      if (!ev.data || !ev.data.size) return
      try { send({ type: "vcMediaChunk", data: base64Encode(await ev.data.arrayBuffer()) }) } catch {}
    }
    rec.start(250)   // emit a webm chunk every 250 ms
    mediaRecRef.current = { rec, stream, el, url }
    return true
  }

  const stopMedia = () => {
    const m = mediaRecRef.current
    mediaRecRef.current = null
    videoElRef.current = null
    if (m) {
      try { if (m.rec && m.rec.state !== "inactive") m.rec.stop() } catch {}
      try { m.stream?.getTracks().forEach(t => t.stop()) } catch {}
      try { if (m.el) { m.el.pause(); m.el.src = "" } } catch {}
      try { if (m.url) URL.revokeObjectURL(m.url) } catch {}
    }
    send({ type: "vcMediaStop" })
    setVideoPlaying(false); setScreenSharing(false); setVideoBusy(false)
    setFilePos(0); setFileDur(0); setFilePaused(false)
  }

  const stopPlayback = () => {
    playbackStateRef.current.cancelled = true   // cancel the audio-file loop
    const eng = playbackEngineRef.current        // tear down the screen-share engine
    playbackEngineRef.current = null
    if (eng) {
      try { eng.stream?.getTracks().forEach(t => t.stop()) } catch {}
      try { if (eng.node) { eng.node.port.onmessage = null; eng.node.disconnect() } } catch {}
      try { eng.ctx?.close() } catch {}
    }
    setPlayingFile(false); setFilePaused(false); setFilePos(0); setFileDur(0); setScreenSharing(false)
  }

  // Play an audio OR video file. Audio decodes + streams as PCM (with seek/pause/
  // loop). A VIDEO needs a real video track, so it's sent to the bot which streams
  // the file (picture + sound) onto an unmuted client via pytgcalls + ffmpeg.
  const playFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return

    if (file.type.startsWith("video/")) {
      const unmuted = resolved.filter(r => (clientStatuses[r.index] || "") === "joined" && !mutedClients[r.index])
      if (!unmuted.length) { showToast("Unmute a client first — the video plays on it", "error"); return }
      stopPlayback(); stopMedia()
      try {
        const url = URL.createObjectURL(file)
        const el  = document.createElement("video")
        el.src = url; el.loop = fileLoop; el.muted = true   // muted locally; sound rides the recorded stream
        videoElRef.current = el
        el.onloadedmetadata = () => setFileDur(el.duration || 0)
        el.ontimeupdate     = () => setFilePos(el.duration ? el.currentTime / el.duration : 0)
        el.onended          = () => { if (!el.loop) stopMedia() }   // no loop → end the stream (no black screen)
        await el.play()
        const stream = el.captureStream(30)   // live picture+sound of the playing file
        if (startMediaStream(stream, el, url)) { setVideoPlaying(true); setFilePaused(false) }
        else { videoElRef.current = null }
      } catch (err) {
        stopMedia()
        showToast(`Video error: ${err.message}`, "error")
      }
      return
    }

    stopPlayback()
    try {
      const arrayBuf = await file.arrayBuffer()
      const dctx     = new AudioContext({ sampleRate: 48000 })
      const decoded  = await dctx.decodeAudioData(arrayBuf)
      const raw      = decoded.getChannelData(0)
      await dctx.close()
      fileRawRef.current = raw
      playbackStateRef.current = { cancelled: false, paused: false, seekSample: null }
      setPlayingFile(true); setFilePaused(false); setFilePos(0); setFileDur(decoded.duration)

      // Pre-encode all file chunks to base64 to eliminate encoding overhead during playback.
      // Use 1920 samples (40ms) per chunk to exactly match mic worklet chunk size and timing,
      // so file + mic streams arrive at the server in perfect sync without timing jitter.
      const chunkSize = 1920
      const encoded = []
      for (let i = 0; i < raw.length; i += chunkSize) {
        const chunk = raw.slice(i, Math.min(i + chunkSize, raw.length))
        const int16 = new Int16Array(chunk.length)
        for (let j = 0; j < chunk.length; j++) {
          const s = Math.max(-1, Math.min(1, chunk[j]))
          int16[j] = s < 0 ? s * 32768 : s * 32767
        }
        encoded.push(base64Encode(int16.buffer))
      }
      fileEncodedRef.current = encoded
      // Playback loop: just iterate through pre-encoded chunks and send them
      // No encoding overhead on the main thread — keeps timing precise even with mic running
      let chunkIdx = 0, lastUi = 0, startTime = performance.now()
      const msPerChunk = (chunkSize / 48000) * 1000  // how long each chunk plays
      while (!playbackStateRef.current.cancelled) {
        if (chunkIdx >= encoded.length) { if (fileLoopRef.current) { chunkIdx = 0; startTime = performance.now() } else break }
        if (playbackStateRef.current.seekSample != null) {
          chunkIdx = Math.floor(playbackStateRef.current.seekSample / chunkSize)
          playbackStateRef.current.seekSample = null
          startTime = performance.now()
        }
        while (playbackStateRef.current.paused && !playbackStateRef.current.cancelled) {
          await new Promise(r => setTimeout(r, 60))
          startTime = performance.now()
        }
        if (playbackStateRef.current.cancelled) break
        send({ type: "vcAudio", data: encoded[chunkIdx] })
        const samplePos = chunkIdx * chunkSize
        if (samplePos - lastUi > 12000) { lastUi = samplePos; setFilePos(samplePos / raw.length) }
        chunkIdx++
        const targetTime = startTime + (chunkIdx * msPerChunk)
        const sleepMs = Math.max(0, targetTime - performance.now())
        if (sleepMs > 1) await new Promise(r => setTimeout(r, sleepMs))
      }
      setPlayingFile(false); setFilePaused(false); setFilePos(0)
    } catch (err) {
      setPlayingFile(false)
      showToast(`File error: ${err.message}`, "error")
    }
  }

  // Live screen share — native picker (with the "share audio" checkbox). Picture +
  // sound are recorded and published into the call on an unmuted client.
  const startScreenShare = async () => {
    const unmuted = resolved.filter(r => (clientStatuses[r.index] || "") === "joined" && !mutedClients[r.index])
    if (!unmuted.length) { showToast("Unmute a client first — it shows the screen", "error"); return }
    stopPlayback(); stopMedia()
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      const vt = stream.getVideoTracks()[0]
      if (vt) vt.onended = () => stopMedia()   // browser's "Stop sharing"
      if (!startMediaStream(stream, null, null)) return
      setScreenSharing(true)
      if (!stream.getAudioTracks().length) showToast("Sharing screen (tick 'Share audio' in the picker for sound)")
    } catch (err) {
      stopMedia()
      if (err?.name !== "NotAllowedError") showToast(`Screen share error: ${err.message}`, "error")
    }
  }

  // ── Voice looper: Record → Loop → Live ──────────────────────────────────────
  const startRecording = () => {
    if (!streaming) { showToast("Start the mic first", "error"); return }
    recordBufferRef.current = []
    recordingRef.current = true
    setRecording(true)
  }
  const stopRecordingStartLoop = () => {
    recordingRef.current = false
    setRecording(false)
    const buf = recordBufferRef.current
    if (!buf.length) { showToast("Nothing was recorded", "error"); return }
    loopingRef.current = true
    setLooping(true)
    let i = 0
    loopTimerRef.current = setInterval(() => {
      if (!loopingRef.current || !buf.length) return
      send({ type: "vcAudio", data: base64Encode(buf[i % buf.length].buffer) })
      i++
    }, 40)   // 40 ms per captured chunk (matches the worklet)
  }
  const stopLoop = () => {
    loopingRef.current = false
    setLooping(false)
    if (loopTimerRef.current) { clearInterval(loopTimerRef.current); loopTimerRef.current = null }
    recordBufferRef.current = []
  }
  // One cycling button: Live → Recording → Looping → Live
  const cycleLooper = () => {
    if (looping) stopLoop()
    else if (recording) stopRecordingStartLoop()
    else startRecording()
  }

  // Playback controls work for BOTH the audio-file loop and the video element
  const togglePauseFile = () => {
    const el = videoElRef.current
    if (el) { if (el.paused) { el.play(); setFilePaused(false) } else { el.pause(); setFilePaused(true) }; return }
    playbackStateRef.current.paused = !playbackStateRef.current.paused
    setFilePaused(playbackStateRef.current.paused)
  }
  const stopFile  = () => stopPlayback()
  const stopVideo = () => stopMedia()
  const seekFile = (v) => {
    const el = videoElRef.current
    if (el && el.duration) { el.currentTime = v * el.duration; setFilePos(v); return }
    if (!fileRawRef.current) return
    playbackStateRef.current.seekSample = Math.floor(v * fileRawRef.current.length)
    setFilePos(v)
  }
  const toggleFileLoop = () => {
    setFileLoop(prev => {
      const next = !prev
      fileLoopRef.current = next
      if (videoElRef.current) videoElRef.current.loop = next
      return next
    })
  }
  const fmtTime = (s) => { const m = Math.floor(s / 60), sec = Math.floor(s % 60); return `${m}:${String(sec).padStart(2, "0")}` }

  // Hard stop: kill ALL local audio (mic + file) and flush the bot's audio buffers
  // immediately, so every client goes silent — without leaving the call.
  const hardStop = () => {
    stopAudio()
    setMicMuted(false)
    send({ type: "vcStopAudio" })
    showToast("Audio stopped")
  }

  const clientCount = selected.length
  const okCount     = resolved.filter(r => r.ok).length

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={visible} onOpenChange={v => { if (!v) ((phase === "active" || resolving) ? onMinimize() : onClose()) }}>
      <DialogContent className="w-[34rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-auto flex flex-col gap-0 p-0 min-w-0 min-h-0 sm:resize sm:min-w-[380px] sm:min-h-[340px]">
        <MinimizeBtn onClick={onMinimize} />

        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-foreground" />
            {phase === "active" ? "Voice Call — Live" : "Join Voice Call"}
          </DialogTitle>
          <DialogDescription>
            {phase === "setup" && `${clientCount} account${clientCount !== 1 ? "s" : ""} selected · enter the chat to join its voice call`}
            {phase === "resolving" && `Resolving ${clientCount} client${clientCount !== 1 ? "s" : ""}…`}
            {phase === "active" && "Everyone joins muted — unmute a client (or Unmute all) to transmit your audio through it"}
          </DialogDescription>
        </DialogHeader>

        {/* ── Setup phase ── */}
        {(phase === "setup" || phase === "resolving") && (
          <div className="px-6 py-4 space-y-4">
            <div>
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Chat Username or ID</Label>
              <Input
                value={chat}
                onChange={e => { setChat(e.target.value); setChatError("") }}
                placeholder="@groupname  or  -1001234567890"
                disabled={resolving}
                className="mt-1.5"
              />
              {chatError && <p className="text-[11px] text-destructive mt-1">{chatError}</p>}
            </div>

            {/* Resolution results */}
            {resolved.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Resolution — {okCount}/{resolved.length} ready
                </p>
                <ScrollArea className="h-40 rounded-lg border border-border/30 bg-secondary/10">
                  <div className="p-2 space-y-1">
                    {resolved.map(r => (
                      <div key={r.index} className={cn(
                        "px-3 py-2 rounded-lg text-[11px]",
                        r.ok ? "bg-success/10 border border-success/30" : "bg-destructive/10 border border-destructive/30"
                      )}>
                        <div className="flex items-center gap-2">
                          <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", r.ok ? "bg-success" : "bg-destructive")} />
                          <span className="font-medium flex-1 break-words">{r.name}</span>
                        </div>
                        <p className="text-muted-foreground/70 break-words whitespace-pre-wrap mt-0.5 pl-3.5">
                          {r.ok ? r.title : r.error}
                        </p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        )}

        {/* ── Active VC phase ── */}
        {phase === "active" && (
          <div className="px-6 py-4 space-y-4">
            {/* Clients — header (pinned) + ONLY the list scrolls so controls stay on screen */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Clients <span className="text-muted-foreground/40 normal-case tracking-normal">
                    ({resolved.filter(r => (clientStatuses[r.index] || "") === "joined").length}/{resolved.length})
                  </span>
                </p>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1 text-success hover:text-success hover:bg-success/10" onClick={unmuteAll}>
                    <Mic className="h-3 w-3" /> Unmute all
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={muteAll}>
                    <MicOff className="h-3 w-3" /> Mute all
                  </Button>
                </div>
              </div>
              <div className="max-h-[34vh] overflow-y-auto overscroll-contain pr-1 space-y-1.5">
                {resolved.map(r => {
                  const status  = clientStatuses[r.index] || "joining"
                  const isMuted = !!mutedClients[r.index]
                  const isCovert = !!covertClients[r.index]
                  const sess    = sessions.find(s => s.index === r.index)
                  const live    = status === "joined" && !isMuted && streaming && !micMuted
                  return (
                    <div key={r.index} className={cn(
                      "group flex items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 transition-colors",
                      status === "failed" ? "border-destructive/30 bg-destructive/5"
                        : live ? "border-success/50 bg-success/5"
                        : "border-border/60",
                    )}>
                      <div className="relative shrink-0">
                        <Avatar className="h-9 w-9">
                          {sess?.photoUrl ? <AvatarImage src={sess.photoUrl} alt={r.name} /> : null}
                          <AvatarFallback className="bg-secondary text-[11px] font-semibold text-foreground">
                            {(r.name || "?").trim().slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className={cn(
                          "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card",
                          status === "joined" ? "bg-success" : status === "failed" ? "bg-destructive" : "bg-muted-foreground/40 pulse-dot",
                        )} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-foreground leading-tight">{r.name}</p>
                        <p className={cn("text-[10px] leading-snug mt-0.5 break-words whitespace-pre-wrap",
                          status === "failed" ? "text-destructive/80" : isCovert ? "text-primary" : live ? "text-success" : "text-muted-foreground/70")}>
                          {status === "joined"
                            ? (isCovert ? "✦ Covert · shown muted, heard" : isMuted ? "Muted · not transmitting" : (live ? "Live · transmitting" : "Unmuted · mic idle"))
                            : status === "failed" ? (r.error || "Failed to join") : "Joining…"}
                        </p>
                      </div>
                      {live && (
                        <div className="flex items-end gap-[3px] h-4 shrink-0" aria-hidden>
                          {[0, 1, 2, 3].map(i => (
                            <span key={i} className="w-[3px] h-full origin-bottom rounded-full bg-success"
                              style={{ animation: `vcBar 0.7s ease-in-out ${i * 0.12}s infinite` }} />
                          ))}
                        </div>
                      )}
                      {status === "joined" && (
                        <>
                          <Button size="icon" variant={isCovert ? "secondary" : "ghost"}
                            className={cn("h-8 w-8 shrink-0", isCovert
                              ? "bg-primary/15 text-primary hover:bg-primary/25"
                              : "text-muted-foreground hover:text-primary")}
                            onClick={() => toggleCovert(r.index)}
                            title={isCovert ? "Covert ON — speaking while shown muted. Click to stop." : "Magic: speak while staying self-muted"}>
                            <Sparkles className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant={isMuted ? "ghost" : "secondary"}
                            className={cn("h-8 w-8 shrink-0", isMuted
                              ? "text-muted-foreground hover:text-foreground"
                              : "bg-success/15 text-success hover:bg-success/25")}
                            onClick={() => toggleClientMute(r.index)}
                            title={isMuted ? "Unmute in call" : "Mute in call"}>
                            {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                          </Button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Audio controls */}
            <div className="space-y-3 rounded-xl border border-border/30 bg-secondary/10 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Audio</p>

              {/* Mic row */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={!streaming ? "default" : micMuted ? "destructive" : "secondary"}
                  onClick={() => { if (!streaming) { startAudio(); return } setMicMuted(v => !v) }}
                >
                  {!streaming ? <Mic className="h-3.5 w-3.5" /> : micMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  {!streaming ? "Start Mic" : micMuted ? "Unmute" : "Mute"}
                </Button>

                {streaming && (
                  <Button size="sm" variant="outline" onClick={stopAudio}>
                    <Square className="h-3 w-3" /> Stop Mic
                  </Button>
                )}

                {/* Voice looper — Record → Loop → Live */}
                {streaming && (
                  <Button size="sm"
                    variant={looping ? "secondary" : recording ? "destructive" : "outline"}
                    className={cn(looping && "text-success border-success/40 hover:text-success")}
                    onClick={cycleLooper}>
                    {looping ? <RotateCcw className="h-3.5 w-3.5" />
                      : recording ? <Circle className="h-3.5 w-3.5 fill-current animate-pulse" />
                      : <Circle className="h-3.5 w-3.5" />}
                    {looping ? "Stop Loop" : recording ? "Stop & Loop" : "Rec Loop"}
                  </Button>
                )}

                {/* Play File (audio OR video) + Screen Share — on the UNMUTED clients */}
                {!playingFile && !screenSharing && !videoPlaying && !videoBusy && (
                  <>
                    <Button size="sm" variant="outline" asChild>
                      <label className="cursor-pointer">
                        <Upload className="h-3.5 w-3.5" /> Play File
                        <input type="file" accept="audio/*,video/*" className="hidden" onChange={playFile} />
                      </label>
                    </Button>
                    <Button size="sm" variant="outline" onClick={startScreenShare}>
                      <PhoneCall className="h-3.5 w-3.5" /> Screen Share
                    </Button>
                  </>
                )}
                {videoBusy && (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading video…
                  </span>
                )}
                {videoPlaying && (
                  <>
                    <span className="flex items-center gap-1.5 text-[11px] text-success">
                      <PhoneCall className="h-3 w-3" /> Video playing in call
                    </span>
                    <Button size="sm" variant="secondary" onClick={togglePauseFile}>
                      {filePaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5 fill-current" />}
                      {filePaused ? "Resume" : "Pause"}
                    </Button>
                    <Button size="sm" variant={fileLoop ? "secondary" : "outline"} onClick={toggleFileLoop}
                      className={cn(fileLoop && "text-success")} title="Loop the video">
                      <RotateCcw className="h-3.5 w-3.5" /> Loop
                    </Button>
                    <Button size="sm" variant="outline" onClick={stopVideo}>
                      <Square className="h-3 w-3" /> Stop Video
                    </Button>
                  </>
                )}
                {playingFile && (
                  <>
                    <Button size="sm" variant="secondary" onClick={togglePauseFile}>
                      {filePaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5 fill-current" />}
                      {filePaused ? "Resume" : "Pause"}
                    </Button>
                    <Button size="sm" variant={fileLoop ? "secondary" : "outline"} onClick={toggleFileLoop}
                      className={cn(fileLoop && "text-success")} title="Loop the file">
                      <RotateCcw className="h-3.5 w-3.5" /> Loop
                    </Button>
                    <Button size="sm" variant="outline" onClick={stopFile}>
                      <Square className="h-3 w-3" /> Stop
                    </Button>
                  </>
                )}
                {screenSharing && (
                  <>
                    <span className="flex items-center gap-1.5 text-[11px] text-success">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                      </span>
                      Sharing screen
                    </span>
                    <Button size="sm" variant="outline" onClick={stopMedia}>
                      <Square className="h-3 w-3" /> Stop Share
                    </Button>
                  </>
                )}
              </div>

              {/* Seek bar for audio OR video file playback */}
              {(playingFile || videoPlaying) && fileDur > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums w-8 text-right">{fmtTime(filePos * fileDur)}</span>
                  <Slider min={0} max={1} step={0.001} value={[filePos]} onValueChange={([v]) => seekFile(v)} className="flex-1" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums w-8">{fmtTime(fileDur)}</span>
                </div>
              )}

              {(recording || looping) && (
                <p className={cn("text-[10px]", recording ? "text-destructive/80" : "text-success")}>
                  {recording
                    ? "● You're still LIVE — keep talking, it's recording in the background. Hit Stop & Loop to rest and play your take on repeat."
                    : "↻ Looping your take to the unmuted clients — rest up. Hit Stop Loop to discard it and go back to live mic."}
                </p>
              )}

              {/* Effects */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">Boost</span>
                  <Slider
                    min={0} max={50} step={0.5}
                    value={[effects.gain]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, gain: v }))}
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-10 text-right">{effects.gain.toFixed(1)}x</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">Bass</span>
                  <Slider
                    min={-12} max={12} step={1}
                    value={[effects.bass]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, bass: v }))}
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{effects.bass > 0 ? "+" : ""}{effects.bass}dB</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">Treble</span>
                  <Slider
                    min={-12} max={12} step={1}
                    value={[effects.treble]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, treble: v }))}
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{effects.treble > 0 ? "+" : ""}{effects.treble}dB</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">Pitch</span>
                  <Slider
                    min={-12} max={12} step={1}
                    value={[effects.pitch]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, pitch: v }))}
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{effects.pitch > 0 ? "+" : ""}{effects.pitch}st</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">Robotic</span>
                  <Slider
                    min={0} max={1} step={0.05}
                    value={[effects.robotic]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, robotic: v }))}
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round(effects.robotic * 100)}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">Thick</span>
                  <Slider
                    min={0} max={1} step={0.05}
                    value={[effects.thickness]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, thickness: v }))}
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round(effects.thickness * 100)}%</span>
                </div>

                {/* Voice-domination chain */}
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-success w-12 shrink-0 font-semibold" title="Noise reduction — low-cut + expander cleans hiss/rumble/room so the boost stays clear, not noisy">Denoise</span>
                  <Slider min={0} max={1} step={0.05} value={[effects.denoise || 0]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, denoise: v }))} className="flex-1" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round((effects.denoise || 0) * 100)}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-primary/80 w-12 shrink-0" title="Noise gate — cuts background/silence">Gate</span>
                  <Slider min={0} max={1} step={0.05} value={[effects.gate || 0]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, gate: v }))} className="flex-1" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round((effects.gate || 0) * 100)}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-primary/80 w-12 shrink-0" title="Presence — makes the voice cut through and stab into the ears">Sharp</span>
                  <Slider min={0} max={1} step={0.05} value={[effects.sharpen || 0]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, sharpen: v }))} className="flex-1" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round((effects.sharpen || 0) * 100)}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-primary/80 w-12 shrink-0" title="Compressor — crushes dynamics so the voice stays relentlessly loud">Punch</span>
                  <Slider min={0} max={1} step={0.05} value={[effects.compress || 0]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, compress: v }))} className="flex-1" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round((effects.compress || 0) * 100)}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-destructive/90 w-12 shrink-0 font-semibold" title="Multiband maximizer — crushes every frequency band so the whole spectrum is slammed (max loudness)">Crush</span>
                  <Slider min={0} max={1} step={0.05} value={[effects.crush || 0]}
                    onValueChange={([v]) => setEffects(p => ({ ...p, crush: v }))} className="flex-1" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">{Math.round((effects.crush || 0) * 100)}%</span>
                </div>

                {/* Voice presets */}
                <div className="space-y-1.5 pt-1">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Voice Presets</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Button size="sm" className="h-7 px-2.5 text-[11px] font-semibold" onClick={() => setEffects({ gain: 12, bass: 2, treble: 3, pitch: 0, robotic: 0, thickness: 0, gate: 0, sharpen: 0.7, compress: 0.8, crush: 0.8, denoise: 0.88 })}>
                      🔥 Dominate
                    </Button>
                    <Button size="sm" className="h-7 px-2.5 text-[11px] font-semibold" onClick={() => setEffects({ gain: 8, bass: 1, treble: 2, pitch: 0, robotic: 0, thickness: 0, gate: 0, sharpen: 0.5, compress: 0.65, crush: 0.55, denoise: 0.92 })}>
                      🎙 Crystal Clear
                    </Button>
                    {[
                      { label: "Male",    e: { gain: 1.0, bass: 4,  treble: 0, pitch: -5, robotic: 0,    thickness: 0.25 } },
                      { label: "Female",  e: { gain: 1.0, bass: 0,  treble: 3, pitch:  5, robotic: 0,    thickness: 0.15 } },
                      { label: "Robot",   e: { gain: 1.0, bass: 0,  treble: 2, pitch: -2, robotic: 0.8,  thickness: 0    } },
                      { label: "Deep",    e: { gain: 1.1, bass: 7,  treble: -2, pitch: -8, robotic: 0,   thickness: 0.3  } },
                      { label: "Chipmunk",e: { gain: 1.0, bass: -4, treble: 4, pitch: 10, robotic: 0,    thickness: 0    } },
                    ].map(p => (
                      <Button key={p.label} size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={() => setEffects(prev => ({ ...prev, ...p.e }))}>
                        {p.label}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[11px] text-muted-foreground" onClick={() => setEffects({ gain: 1.0, bass: 0, treble: 0, pitch: 0, robotic: 0, thickness: 0, gate: 0, sharpen: 0, compress: 0, crush: 0, denoise: 0 })}>
                      Reset
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex gap-2">
          {phase !== "active" ? (
            <>
              <Button variant="ghost" className="flex-1" onClick={onClose} disabled={resolving}>Close</Button>
              {resolved.length === 0
                ? <Button className="flex-1" onClick={handleResolve} disabled={resolving || !clientCount}>
                    {resolving ? <><Loader2 className="h-4 w-4 animate-spin" /> Resolving…</> : <><PhoneCall className="h-4 w-4" /> Resolve Clients</>}
                  </Button>
                : <Button className="flex-1" onClick={handleJoin} disabled={okCount === 0}>
                    <PhoneCall className="h-4 w-4" /> Join VC ({okCount} {okCount === 1 ? "client" : "clients"})
                  </Button>
              }
            </>
          ) : (
            <>
              <Button
                variant="outline"
                className="flex-1 border-warning/30 text-warning hover:bg-warning/10 hover:text-warning"
                onClick={hardStop}
                disabled={!streaming && !playingFile}
                title="Stop all audio (mic + file) without leaving the call"
              >
                <Square className="h-4 w-4" /> Hard Stop
              </Button>
              <Button variant="destructive" className="flex-1" onClick={handleLeave}>
                <PhoneOff className="h-4 w-4" /> Leave Call
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}


// ─── Minimized window dock ────────────────────────────────────────────────────

// Minimize button — sits to the left of the dialog's built-in close (X).
function MinimizeBtn({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Minimize (keeps running)"
      className="absolute right-12 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 z-10"
    >
      <Minus className="h-4 w-4" />
      <span className="sr-only">Minimize</span>
    </button>
  )
}

function MinimizedDock({ windows, onRestore }) {
  if (!windows.length) return null
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2">
      {windows.map(({ key, label, Icon }) => (
        <button
          key={key}
          onClick={() => onRestore(key)}
          className="flex items-center gap-2 pl-3 pr-3.5 py-2 rounded-xl border border-border bg-card text-foreground shadow-lg backdrop-blur-md text-xs font-semibold transition-colors hover:bg-accent"
          title={`Restore ${label}`}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}


// ─── Randomize Dialog ─────────────────────────────────────────────────────────

function RandomizeDialog({ visible, onClose, onMinimize, selected, sessions, botActiveSessions, send, addListener, showToast }) {
  const [tab, setTab]           = useState("names")
  const [customNames, setCustomNames] = useState([]) // [{firstName,lastName}] from uploaded .txt
  const [images, setImages]     = useState([])      // [b64]
  const [loadingImgs, setLoadingImgs] = useState(false)
  const [runningKind, setRunningKind] = useState(null) // "name" | "avatar" | null
  const [progress, setProgress] = useState([])      // [{index, ok, error}]
  const [summary, setSummary]   = useState(null)    // {kind, done, total}

  // Target = explicitly selected accounts, else every active account
  const targetIds = selected.length
    ? selected
    : sessions.filter(s => botActiveSessions === null || botActiveSessions.includes(s.index)).map(s => s._id.toString())
  const targetCount = targetIds.length

  useEffect(() => {
    const rmP = addListener("randomizeProgress", msg => setProgress(p => [...p, msg]))
    const rmC = addListener("randomizeComplete", msg => {
      setRunningKind(null)
      setSummary({ kind: msg.kind, done: msg.done || 0, total: msg.total || 0 })
    })
    return () => { rmP(); rmC() }
  }, [addListener])

  const downscale = (file, max = 512) => new Promise((resolve) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement("canvas")
      canvas.width = w; canvas.height = h
      canvas.getContext("2d").drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1])
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })

  const handleFolder = async (fileList) => {
    const imgFiles = Array.from(fileList || []).filter(f => f.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(f.name))
    if (!imgFiles.length) { showToast("No images found in that folder", "error"); return }
    setLoadingImgs(true)
    const encoded = (await Promise.all(imgFiles.map(f => downscale(f)))).filter(Boolean)
    setImages(encoded)
    setLoadingImgs(false)
  }

  // Parse an uploaded .txt of names: one per line. A single word → first name only
  // (last name cleared); "first last" → first + rest as last name.
  const handleNamesFile = async (file) => {
    if (!file) return
    const text = await file.text()
    const parsed = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
      const parts = line.split(/\s+/)
      return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
    })
    if (!parsed.length) { showToast("No names found in that file", "error"); return }
    setCustomNames(parsed)
    showToast(`Loaded ${parsed.length} name${parsed.length !== 1 ? "s" : ""}`)
  }

  const runNames = () => {
    if (!targetCount) { showToast("No active accounts to randomize", "error"); return }
    setProgress([]); setSummary(null); setRunningKind("name")
    send({ type: "randomizeNames", clients: targetIds, customNames: customNames.length ? customNames : undefined })
  }

  const runAvatars = () => {
    if (!targetCount) { showToast("No active accounts to randomize", "error"); return }
    if (!images.length) { showToast("Select a folder of images first", "error"); return }
    setProgress([]); setSummary(null); setRunningKind("avatar")
    send({ type: "randomizeAvatars", clients: targetIds, images })
  }

  const running = runningKind !== null
  const doneCount = progress.filter(p => p.ok).length

  return (
    <Dialog open={visible} onOpenChange={v => { if (!v) (running ? onMinimize() : onClose()) }}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)] sm:w-full p-0 overflow-hidden gap-0">
        <MinimizeBtn onClick={onMinimize} />
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Dices className="h-4 w-4 text-primary" /> Randomize
          </DialogTitle>
          <DialogDescription className="text-xs">
            Applies to {selected.length ? `${targetCount} selected` : `all ${targetCount} active`} account{targetCount !== 1 ? "s" : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pt-3">
          <div className="flex gap-1 p-1 rounded-lg bg-secondary/50 border border-border/30">
            {[["names", "Names"], ["pics", "Profile Pics"]].map(([v, l]) => (
              <button key={v} onClick={() => { if (!running) { setTab(v); setProgress([]); setSummary(null) } }}
                className={cn("flex-1 py-1.5 rounded-md text-sm font-medium transition-all",
                  tab === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {tab === "names" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Gives every targeted account a fresh random <span className="text-foreground">Hindi</span> first &amp; last name. Names update live on the cards.
              </p>
              <div className="rounded-lg border border-border/40 bg-secondary/10 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-muted-foreground">Custom list (optional)</p>
                  {customNames.length > 0 && (
                    <button className="text-[10px] text-muted-foreground/60 hover:text-foreground" onClick={() => setCustomNames([])} disabled={running}>clear</button>
                  )}
                </div>
                {customNames.length > 0 ? (
                  <div className="flex items-center gap-2 text-[11px] text-success">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    {customNames.length} name{customNames.length !== 1 ? "s" : ""} loaded — random pick per account
                  </div>
                ) : (
                  <button onClick={() => document.getElementById("rand-names-txt")?.click()} disabled={running}
                    className="w-full rounded-lg border border-dashed border-border/40 hover:border-border/80 hover:bg-secondary/20 transition-all py-3 flex flex-col items-center gap-1 disabled:opacity-50">
                    <Upload className="h-4 w-4 text-muted-foreground/50" />
                    <p className="text-[11px] text-muted-foreground/70 font-medium">Upload .txt of names</p>
                    <p className="text-[9px] text-muted-foreground/40">one per line · single word = first only · "first last" = both</p>
                  </button>
                )}
                <input id="rand-names-txt" type="file" accept=".txt,text/plain" className="hidden"
                  onChange={e => { handleNamesFile(e.target.files?.[0]); e.target.value = "" }} />
              </div>
            </div>
          ) : (
            <>
              <button onClick={() => document.getElementById("rand-folder")?.click()} disabled={running}
                className="w-full rounded-lg border border-dashed border-border/40 hover:border-border/80 hover:bg-secondary/20 transition-all py-6 flex flex-col items-center gap-1.5 disabled:opacity-50">
                {loadingImgs
                  ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
                  : <Folder className="h-5 w-5 text-muted-foreground/50" />}
                <p className="text-xs text-muted-foreground/70 font-medium">
                  {images.length ? `${images.length} image${images.length !== 1 ? "s" : ""} loaded` : "Select a folder of images"}
                </p>
                <p className="text-[10px] text-muted-foreground/40">each account gets a random one</p>
              </button>
              <input id="rand-folder" type="file" className="hidden" webkitdirectory="" directory="" accept="image/*"
                onChange={e => handleFolder(e.target.files)} />
              {images.length > 0 && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <ImageIcon className="h-3.5 w-3.5" /> {images.length} ready · {targetCount} accounts
                  <button className="ml-auto text-muted-foreground/60 hover:text-foreground" onClick={() => setImages([])} disabled={running}>clear</button>
                </div>
              )}
            </>
          )}

          {/* Progress */}
          <AnimatePresence>
            {(running || summary) && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0 }}
                className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {running
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Randomizing… {doneCount}/{targetCount}</>
                    : <span className="text-success flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Done — {summary.done}/{summary.total}</span>}
                </div>
                {progress.length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border/30 bg-secondary/10 p-1.5 space-y-1">
                    {[...progress].reverse().slice(0, 60).map((p, i) => (
                      <div key={i} className="flex items-start gap-2 px-2 py-1 rounded text-[11px]">
                        {p.ok ? <CheckCircle2 className="h-3 w-3 text-success shrink-0 mt-0.5" /> : <X className="h-3 w-3 text-destructive shrink-0 mt-0.5" />}
                        <span className="text-muted-foreground shrink-0">#{p.index}</span>
                        <div className="flex-1 min-w-0">
                          <span className="break-words">{p.kind === "name" ? p.name : (p.ok ? "photo set" : "")}</span>
                          {!p.ok && p.error && <p className="text-destructive/70 break-words whitespace-pre-wrap mt-0.5">{p.error}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter className="gap-2 px-5 py-4 border-t border-border/60">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={running}>Close</Button>
          {tab === "names" ? (
            <Button className="flex-1" onClick={runNames} disabled={running || !targetCount}>
              {runningKind === "name" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Dices className="h-4 w-4" />}
              Randomize Names
            </Button>
          ) : (
            <Button className="flex-1" onClick={runAvatars} disabled={running || !targetCount || !images.length}>
              {runningKind === "avatar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
              Randomize Pics
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


// ─── Bulk Profile Dialog ──────────────────────────────────────────────────────
// Manual counterpart to Randomize: set the SAME first/last name, bio and/or photo
// on every selected account at once. Blank fields are left untouched.

function BulkProfileDialog({ visible, onClose, onMinimize, selected, sessions, botActiveSessions, send, addListener, showToast }) {
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName]   = useState("")
  const [bio, setBio]             = useState("")
  const [photo, setPhoto]         = useState(null)   // { b64, preview }
  const [running, setRunning]     = useState(false)
  const [progress, setProgress]   = useState([])     // [{index, ok, name, error}]
  const [summary, setSummary]     = useState(null)   // {done, total}

  const targetIds = selected.length
    ? selected
    : sessions.filter(s => botActiveSessions === null || botActiveSessions.includes(s.index)).map(s => s._id.toString())
  const targetCount = targetIds.length


  useEffect(() => {
    const rmP = addListener("bulkProfileProgress", msg => setProgress(p => [...p, msg]))
    const rmC = addListener("bulkProfileComplete", msg => {
      setRunning(false); setSummary({ done: msg.done || 0, total: msg.total || 0 })
      if (msg.error) showToast(msg.error, "error")
    })
    return () => { rmP(); rmC() }
  }, [addListener, showToast])

  const downscale = (file, max = 512) => new Promise((resolve) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement("canvas")
      canvas.width = w; canvas.height = h
      canvas.getContext("2d").drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL("image/jpeg", 0.85))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })

  const onPhoto = async (file) => {
    if (!file) return
    const dataUrl = await downscale(file)
    if (dataUrl) setPhoto({ b64: dataUrl.split(",")[1], preview: dataUrl })
    else showToast("Couldn't read that image", "error")
  }

  const run = () => {
    if (!targetCount) { showToast("No accounts selected", "error"); return }
    if (!firstName.trim() && !lastName.trim() && !bio.trim() && !photo) { showToast("Fill at least one field", "error"); return }
    setProgress([]); setSummary(null); setRunning(true)
    send({
      type: "bulkProfile", clients: targetIds,
      firstName: firstName.trim(), lastName: lastName.trim(), bio: bio.trim(),
      photo: photo?.b64 || null,
    })
  }

  const doneCount = progress.filter(p => p.ok).length

  return (
    <Dialog open={visible} onOpenChange={v => { if (!v) (running ? onMinimize() : onClose()) }}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)] sm:w-full p-0 overflow-hidden gap-0">
        <MinimizeBtn onClick={onMinimize} />
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <IdCard className="h-4 w-4 text-primary" /> Set Profile on All
          </DialogTitle>
          <DialogDescription className="text-xs">
            Applies to {selected.length ? `${targetCount} selected` : `all ${targetCount} active`} account{targetCount !== 1 ? "s" : ""}. Blank fields are left unchanged.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          <div className="flex gap-3">
            <button type="button" onClick={() => document.getElementById("bulk-photo")?.click()} disabled={running}
              className="relative h-16 w-16 shrink-0 rounded-full border border-dashed border-border/50 hover:border-border bg-secondary/20 overflow-hidden flex items-center justify-center disabled:opacity-50">
              {photo ? <img src={photo.preview} alt="" className="h-full w-full object-cover" /> : <Camera className="h-5 w-5 text-muted-foreground/50" />}
            </button>
            <input id="bulk-photo" type="file" accept="image/*" className="hidden" onChange={e => onPhoto(e.target.files?.[0])} />
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">First name</Label>
                <Input value={firstName} onChange={e => setFirstName(e.target.value)} disabled={running} className="mt-1.5" placeholder="optional" />
              </div>
              <div>
                <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Last name</Label>
                <Input value={lastName} onChange={e => setLastName(e.target.value)} disabled={running} className="mt-1.5" placeholder="optional" />
              </div>
            </div>
          </div>
          {photo && (
            <button type="button" className="text-[11px] text-muted-foreground/60 hover:text-foreground" onClick={() => setPhoto(null)} disabled={running}>remove photo</button>
          )}
          <div>
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Bio</Label>
            <Textarea value={bio} onChange={e => setBio(e.target.value)} disabled={running} placeholder="optional" className="mt-1.5 min-h-[60px] max-h-[120px] text-sm resize-none" />
          </div>

          {/* Progress */}
          <AnimatePresence>
            {(running || summary) && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0 }} className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {running
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying… {doneCount}/{targetCount}</>
                    : <span className="text-success flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Done — {summary.done}/{summary.total}</span>}
                </div>
                {progress.length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border/30 bg-secondary/10 p-1.5 space-y-1">
                    {[...progress].reverse().slice(0, 60).map((p, i) => (
                      <div key={i} className="flex items-start gap-2 px-2 py-1 rounded text-[11px]">
                        {p.ok ? <CheckCircle2 className="h-3 w-3 text-success shrink-0 mt-0.5" /> : <X className="h-3 w-3 text-destructive shrink-0 mt-0.5" />}
                        <span className="text-muted-foreground shrink-0">#{p.index}</span>
                        <div className="flex-1 min-w-0">
                          <span className="break-words">{p.ok ? (p.name || "updated") : ""}</span>
                          {!p.ok && p.error && <p className="text-destructive/70 break-words whitespace-pre-wrap mt-0.5">{p.error}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter className="gap-2 px-5 py-4 border-t border-border/60">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={running}>Close</Button>
          <Button className="flex-1" onClick={run} disabled={running || !targetCount}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <IdCard className="h-4 w-4" />}
            Apply to {targetCount}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


// ─── Dashboard ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const router = useRouter()
  const { wsRef, send, botOnline, connected, botSessionCount, botActiveReports, botActiveSessions, addListener } = useWs()

  const [sessions, setSessions]     = useState([])
  const [selected, setSelected]     = useState([])
  const [editMode, setEditMode]     = useState(false)
  const [addOpen, setAddOpen]       = useState(false)
  const [editingId, setEditingId]   = useState(null)
  const [editName, setEditName]     = useState("")
  const [dragging, setDragging]     = useState(null)
  const [dragOver, setDragOver]     = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const [visibility, setVisibility]       = useState("public")
  const [amount, setAmount]               = useState(null)
  const [formatsInput, setFormatsInput]   = useState("")
  const [isFormatsValid, setIsFormatsValid] = useState(null)
  const [treeValue, setTreeValue]         = useState([])
  const [delayRange, setDelayRange]       = useState([5, 20])
  const [delayMax, setDelayMax]           = useState(30)
  const [telegramLinks, setTelegramLinks] = useState("")
  const [isFocused, setIsFocused]         = useState(false)
  const [parsedData, setParsedData]       = useState(null)
  const [userTarget, setUserTarget]       = useState("")  // username string for user reports

  const [isRunning, setIsRunning]     = useState(false)
  const [hasStopped, setHasStopped]   = useState(false)
  const [progressLogs, setProgressLogs] = useState([])
  const [currentHash, setCurrentHash] = useState(null)
  const [reportMeta, setReportMeta]   = useState(null)   // { hash, type, sessionCount, reasons }
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)

  const [isAdmin, setIsAdmin]           = useState(false)
  const [perks, setPerks]               = useState(null)   // array of perk keys; null = unknown/legacy = all
  const [isMobile, setIsMobile]         = useState(false)  // phone viewport — side panels become drawers
  const [vcLocks, setVcLocks]           = useState({})     // { accountIndex: username } — accounts in a call
  const [myUser, setMyUser]             = useState(null)   // this browser's username (for "in your call")
  // Capability check — admins implicitly have everything; legacy (null) = full access.
  const can = (p) => isAdmin || perks === null || perks.includes(p)
  const [usersOpen, setUsersOpen]       = useState(false)
  const [leftOpen, setLeftOpen]         = useState(true)
  const [rightOpen, setRightOpen]       = useState(true)
  const [toast, setToast]               = useState(null)
  const [reloading, setReloading]       = useState(false)
  const [privacyMode, setPrivacyMode]   = useState(false)
  const [joinOpen, setJoinOpen]                 = useState(false)
  const [leaveOpen, setLeaveOpen]               = useState(false)
  const [editProfileOpen, setEditProfileOpen]   = useState(false)
  const [editProfileSession, setEditProfileSession] = useState(null)
  const [noRepeat, setNoRepeat]                 = useState(false)
  const [startingSession, setStartingSession]   = useState(null) // index being started
  const [raidOpen, setRaidOpen]                 = useState(false)
  const [vcOpen, setVcOpen]                     = useState(false)
  const [randomizeOpen, setRandomizeOpen]       = useState(false)
  const [bulkProfileOpen, setBulkProfileOpen]   = useState(false)
  const [aiOpen, setAiOpen]                     = useState(false)
  const [mailOpen, setMailOpen]                 = useState(false)
  const [aiMode, setAiMode]                     = useState("report")  // "report" | "email"
  const [aiNewChat, setAiNewChat]               = useState(0)
  const [emailDraft, setEmailDraft]             = useState(null)      // {to,subject,html,_ts}
  // Which action windows are minimized (hidden to the dock but still running)
  const [minimized, setMinimized]               = useState({}) // { vc:true, join:false, ... }
  const openWin     = (key, setter) => { setMinimized(m => ({ ...m, [key]: false })); setter(true) }
  const minimizeWin = (key)         => setMinimized(m => ({ ...m, [key]: true }))
  const restoreWin  = (key)         => setMinimized(m => ({ ...m, [key]: false }))

  const left  = useHResize(264, 180, 420, "left")
  const right = useHResize(274, 200, 420, "right")

  useEffect(() => {
    const token = localStorage.getItem("token")
    if (!token) { router.push("/"); return }
    setIsAdmin(localStorage.getItem("isAdmin") === "1")
    setMyUser(localStorage.getItem("username"))
    try { const p = JSON.parse(localStorage.getItem("perks") || "null"); setPerks(Array.isArray(p) ? p : null) }
    catch { setPerks(null) }
    loadSessions(token)
  }, [])

  // Phone detection — collapse the side panels into drawers on small screens
  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(max-width: 768px)")
    const apply = () => { setIsMobile(mq.matches); if (mq.matches) { setLeftOpen(false); setRightOpen(false) } }
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])

  useEffect(() => {
    if (!formatsInput.trim()) { setIsFormatsValid(null); return }
    try { const p = JSON.parse(formatsInput); setIsFormatsValid(Array.isArray(p) && p.every(x => typeof x === "string")) }
    catch { setIsFormatsValid(false) }
  }, [formatsInput])

  useEffect(() => {
    const rmP = addListener("reportProgress", msg =>
      setProgressLogs(p => [...p, {
        ...msg,
        eventType:   "report",
        timestamp:   Date.now(),
        reasonLabel: msg.reason ? (REASON_MAP[msg.reason] || msg.reason) : null,
      }])
    )
    const rmD = addListener("reportComplete", msg => {
      setProgressLogs(p => [...p, { ...msg, eventType: "report", timestamp: Date.now() }])
      setIsRunning(false)
      setHasStopped(true)
      setDownloadOpen(true)
      setHistoryRefreshKey(k => k + 1)
    })
    const rmS = addListener("botStatus", msg => {
      setReloading(false)
      if (msg.reloadResult) {
        const { added, total, refreshed = 0 } = msg.reloadResult
        showToast(`Reload done — ${added} new, ${refreshed} refreshed. ${total} active.`)
        // Pull the freshly re-synced DB values (names, photos, premium…) onto the cards
        loadSessions(typeof window !== "undefined" ? localStorage.getItem("token") : null)
      }
      if (msg.toast) showToast(msg.toast)
    })
    const rmR = addListener("renameResult", msg => {
      if (msg.ok) {
        showToast(`Account #${msg.index} renamed`)
        // Update the session name in local state immediately (no refetch needed)
        if (msg.name) setSessions(p => p.map(s => s.index === msg.index ? { ...s, name: msg.name } : s))
      } else {
        showToast(msg.error || "Rename failed", "error")
      }
    })
    // Randomize: update session card names live as they change
    const rmRand = addListener("randomizeProgress", msg => {
      if (msg.kind === "name" && msg.ok && msg.name) {
        setSessions(p => p.map(s => s.index === msg.index ? { ...s, name: msg.name } : s))
      }
    })
    // Bulk profile: reflect new names on the cards live (photos refresh on reload)
    const rmBulk = addListener("bulkProfileProgress", msg => {
      if (msg.ok && msg.name && msg.index != null) {
        setSessions(p => p.map(s => s.index === msg.index ? { ...s, name: msg.name } : s))
      }
    })
    const rmSS = addListener("startSessionResult", msg => {
      setStartingSession(null)
      if (msg.ok) {
        showToast(msg.already ? `Session #${msg.index} already active` : `Session #${msg.index} started`)
      } else {
        showToast(msg.error || `Failed to start session #${msg.index}`, "error")
      }
    })
    // Global error handler — shows toast for bot-offline and other server errors
    const rmErr = addListener("error", msg => {
      showToast(msg.message || "An error occurred", "error")
    })

    // Route all event types to the unified Live Events log
    const rmJP = addListener("joinProgress",   msg => setProgressLogs(p => [...p, { ...msg, eventType: "join",  timestamp: Date.now() }]))
    const rmLP = addListener("leaveProgress",  msg => setProgressLogs(p => [...p, { ...msg, eventType: "leave", timestamp: Date.now() }]))
    const rmRP = addListener("raidProgress",   msg => setProgressLogs(p => [...p, { ...msg, eventType: "raid",  timestamp: Date.now() }]))
    const rmLocks = addListener("vcLocks", msg => setVcLocks(msg.locks || {}))
    const rmVC = addListener("vcClientStatus", msg => setProgressLogs(p => [...p, {
      ...msg,
      eventType: "vc",
      client: msg.name || `#${msg.index}`,
      worked: msg.status === "joined" || msg.status === "joining",
      error: msg.status === "failed" ? (msg.error || "Failed to join") : msg.status === "joining" ? "Joining…" : null,
      timestamp: Date.now(),
    }]))
    return () => { rmP(); rmD(); rmS(); rmR(); rmRand(); rmBulk(); rmSS(); rmErr(); rmJP(); rmLP(); rmRP(); rmVC(); rmLocks() }
  }, [addListener])

  // Ask bot for its current status as soon as WS connects
  useEffect(() => {
    if (connected && botOnline) send({ type: "getBotStatus" })
  }, [connected, botOnline])

  const handleReloadSessions = () => {
    if (!botOnline) { showToast("Bot is offline", "error"); return }
    setReloading(true)
    send({ type: "reloadSessions" })
    // Safety timeout — reset if bot doesn't reply within 8s
    setTimeout(() => setReloading(false), 8000)
  }

  const showToast = (msg, type = "info") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  const loadSessions = async (token) => {
    try {
      const r = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token || localStorage.getItem("token")}` } })
      if (r.status === 402) { router.push("/"); return }
      const d = await r.json()
      setSessions((d.sessions || []).sort((a, b) => a.index - b.index))
    } catch {}
  }

  const validate = () => {
    const errs = []
    if (!selected.length) errs.push("Select at least one account")
    if (!amount) errs.push("Enter report amount")
    if (visibility === "public") {
      if (!parsedData || parsedData.hasError || !parsedData.messageIds.length) errs.push("Valid public Telegram links required")
      if (!treeValue.length) errs.push("Select at least one reason")
    }
    if (visibility === "private") {
      if (!parsedData || parsedData.hasError || !parsedData.messageIds.length) errs.push("Valid private Telegram links required")
      if (!treeValue.length) errs.push("Select at least one reason")
    }
    if (visibility === "userId") {
      if (!userTarget.trim()) errs.push("Username required for user reports")
      if (!treeValue.length) errs.push("Select at least one reason")
    }
    if (isFormatsValid === false) errs.push("Invalid formats JSON")
    if (errs.length) { showToast(errs[0], "error"); return false }
    return true
  }

  const handleStart = async () => {
    if (hasStopped) { showToast("Reset first", "error"); return }
    if (!validate()) return
    const formats = (isFormatsValid && formatsInput) ? JSON.parse(formatsInput) : []
    const hash = generateHash()
    const data = { type: visibility, uniformDelay: `${delayRange[0]}, ${delayRange[1]}`, amount, timestamp: new Date().toISOString() }

    if (visibility === "public") {
      data.username   = parsedData.extractedUsername
      data.messageIds = parsedData.messageIds
      data.options    = treeValue
    } else if (visibility === "private") {
      data.chatId     = parsedData.chatId   // already -100xxx
      data.messageIds = parsedData.messageIds
      data.options    = treeValue
    } else {
      data.username = userTarget  // username string for user report
      data.reasons  = treeValue
      data.options  = []
    }

    const payload = { hash, clients: selected, data, formats, noRepeat }
    try {
      const r = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
        body: JSON.stringify(payload),
      })
      if (!r.ok) { const d = await r.json(); showToast(d.error || "Failed", "error"); return }
    } catch { showToast("Network error", "error"); return }

    setCurrentHash(hash)
    setIsRunning(true)
    setProgressLogs([])
    setReportMeta({ hash, type: visibility, sessionCount: selected.length, reasons: treeValue })
    send({ type: "startReport", ...payload })
    showToast("Report started")
  }

  const handleStop = () => {
    send({ type: "stopReport", hash: currentHash })
    setIsRunning(false)
    setHasStopped(true)
  }

  const handleReset = () => {
    setSelected([]); setAmount(null); setFormatsInput(""); setIsFormatsValid(null)
    setTreeValue([]); setVisibility("public"); setUserTarget("")
    setTelegramLinks(""); setParsedData(null); setDelayRange([5, 20])
    setIsRunning(false); setHasStopped(false); setProgressLogs([])
    setCurrentHash(null); setReportMeta(null); setDownloadOpen(false)
    setNoRepeat(false)
  }

  // AI assistant fills the report form via the fill_report tool
  const applyReportConfig = useCallback((cfg) => {
    if (!cfg || typeof cfg !== "object") return
    const type = ["public", "private", "userId"].includes(cfg.chatType) ? cfg.chatType : "public"
    setVisibility(type)
    if (cfg.amount != null && !isNaN(cfg.amount)) setAmount(Number(cfg.amount))
    if (Array.isArray(cfg.formats) && cfg.formats.length) {
      try { setFormatsInput(JSON.stringify(cfg.formats)); setIsFormatsValid(true) } catch {}
    }
    if (type === "userId") {
      if (cfg.userTarget) setUserTarget(String(cfg.userTarget).replace(/^@/, ""))
    } else if (cfg.links != null) {
      setTelegramLinks(String(cfg.links))
      setParsedData(parseTelegramLinks(String(cfg.links)))
    }
    if (Array.isArray(cfg.reasonTitles) && cfg.reasonTitles.length) {
      const tree = type === "userId" ? USER_TREE : MSG_TREE
      const norm = (s) => String(s).toLowerCase().replace(/[,]/g, "").replace(/\s+/g, " ").trim()
      const wanted = cfg.reasonTitles.map(norm)
      const vals = []
      // Only ever select LEAF nodes (no children). Selecting a parent in this
      // checkable tree auto-checks all of its children, which is exactly the
      // "it picked everything" bug. Childless parents (Copyright, etc.) count as leaves.
      const walk = (nodes) => nodes.forEach(n => {
        const isLeaf = !n.children || !n.children.length
        if (isLeaf && wanted.includes(norm(n.title))) vals.push(n.value)
        if (n.children) walk(n.children)
      })
      walk(tree)
      if (vals.length) setTreeValue([...new Set(vals)])
    }
    showToast("AI filled the report form")
    setRightOpen(true)
  }, [])

  const logout = () => { localStorage.clear(); document.cookie = "token=; max-age=0; path=/"; router.push("/") }

  const deleteSession = async (s) => {
    await fetch(`/api/admin/sessions?id=${s._id}`, { method: "DELETE", headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } })
    setSelected(p => p.filter(id => id !== s._id.toString()))
    setDeleteTarget(null); loadSessions()
  }

  const saveSessionName = async (s) => {
    if (!editName.trim()) { setEditingId(null); return }
    const name = editName.trim()
    setEditingId(null); setEditName("")
    // Optimistic update
    setSessions(p => p.map(s2 => s2._id === s._id ? { ...s2, name } : s2))
    await fetch("/api/admin/sessions", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: s._id.toString(), name }),
    })
    send({ type: "renameAccount", index: s.index, name })
  }

  const handleDrop = async (e, target) => {
    e.preventDefault()
    if (!dragging || dragging._id === target._id) { setDragging(null); setDragOver(null); return }
    const arr = [...sessions]
    const fi = arr.findIndex(s => s._id === dragging._id)
    const ti = arr.findIndex(s => s._id === target._id)
    const temp = arr[fi].index
    arr[fi] = { ...arr[fi], index: arr[ti].index }; arr[ti] = { ...arr[ti], index: temp }
    arr.sort((a, b) => a.index - b.index); setSessions(arr)
    const h = { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" }
    await Promise.all([
      fetch("/api/admin/sessions", { method: "PATCH", headers: h, body: JSON.stringify({ id: dragging._id.toString(), index: arr[ti].index }) }),
      fetch("/api/admin/sessions", { method: "PATCH", headers: h, body: JSON.stringify({ id: target._id.toString(), index: temp }) }),
    ])
    setDragging(null); setDragOver(null)
  }

  const countries = [...new Set(sessions.map(s => s.country || phoneToCountry(s.phone)).filter(Boolean))]
  const dcIds     = [...new Set(sessions.map(s => s.dcId).filter(Boolean))].sort((a, b) => a - b)
  const worked    = progressLogs.filter(l => l.type === "reportProgress" && l.worked).length
  const total     = progressLogs.filter(l => l.type === "reportProgress").length

  // Panels defined once, reused by both the desktop columns and the mobile drawers
  const leftPanelEl = (
    <LeftPanel logs={progressLogs} onLogout={logout} onClearLogs={() => setProgressLogs([])} historyRefreshKey={historyRefreshKey} />
  )
  const optionsPanelEl = (
    <OptionsPanel
      visibility={visibility} setVisibility={setVisibility}
      amount={amount} setAmount={setAmount}
      formatsInput={formatsInput} setFormatsInput={setFormatsInput}
      isFormatsValid={isFormatsValid}
      delayRange={delayRange} setDelayRange={setDelayRange}
      delayMax={delayMax} setDelayMax={setDelayMax}
      telegramLinks={telegramLinks} setTelegramLinks={setTelegramLinks}
      parsedData={parsedData} setParsedData={setParsedData}
      isFocused={isFocused} setIsFocused={setIsFocused}
      treeValue={treeValue} setTreeValue={setTreeValue}
      userTarget={userTarget} setUserTarget={setUserTarget}
      noRepeat={noRepeat} setNoRepeat={setNoRepeat}
      isRunning={isRunning} hasStopped={hasStopped}
    />
  )

  return (
    <TooltipProvider>
      <div className="h-screen bg-background overflow-hidden flex gap-0 p-2">

        {/* ─── Left Panel — desktop inline (mobile renders it as a drawer below) ─ */}
        {!isMobile && (
        <motion.div
          animate={{ width: leftOpen ? left.width : 0, opacity: leftOpen ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="shrink-0 overflow-hidden"
        >
          <div style={{ width: left.width }} className="h-full">
            {leftPanelEl}
          </div>
        </motion.div>
        )}

        {/* Left handle */}
        {!isMobile && leftOpen && (
          <div className="w-3 shrink-0 flex items-center justify-center cursor-col-resize group"
            onMouseDown={left.onMouseDown}>
            <div className="w-px h-12 rounded-full bg-border/20 group-hover:bg-primary/40 group-hover:h-20 group-hover:w-0.5 transition-all" />
          </div>
        )}

        {/* ─── Center ──────────────────────────────────── */}
        <div className="flex-1 flex flex-col gap-2 min-w-0">

          {/* Top bar */}
          <Card className="flex items-center gap-1 px-2 h-12 shrink-0">
            <ToolbarIconButton icon={PanelLeft} label="Toggle feed" onClick={() => setLeftOpen(v => !v)} />

            {/* Bot status pill */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn(
                  "flex items-center gap-1.5 px-2 h-7 rounded-md border cursor-default select-none text-[11px] font-medium shrink-0",
                  botOnline ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"
                )}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", botOnline ? "bg-success pulse-dot" : "bg-destructive")} />
                  {botOnline ? "Online" : "Offline"}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {botOnline
                  ? `Bot connected · ${botSessionCount ?? 0} active sessions${botActiveReports > 0 ? ` · ${botActiveReports} running` : ""}`
                  : "Bot is not connected"}
              </TooltipContent>
            </Tooltip>

            {/* Scrollable action cluster — never overflows onto the side panels */}
            <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
              <div className="flex items-center gap-1 w-max px-0.5">
                {!hasStopped && (
                  <>
                    {isAdmin && (
                      <>
                        <ToolbarIconButton icon={RefreshCw} label="Sync sessions to bot" onClick={handleReloadSessions} disabled={reloading || !botOnline} />
                        <ToolbarIconButton
                          icon={privacyMode ? EyeOff : Eye}
                          label={privacyMode ? "Show account info" : "Hide account info (streaming mode)"}
                          active={privacyMode}
                          onClick={() => setPrivacyMode(v => !v)}
                        />
                        <ToolbarIconButton icon={Users} label="Manage users" onClick={() => setUsersOpen(true)} />
                        <ToolbarIconButton icon={Plus} label="Add account" onClick={() => setAddOpen(true)} />
                        <Separator orientation="vertical" className="mx-1 h-5" />
                      </>
                    )}
                    {can("join")    && <ToolbarIconButton icon={UserPlus}  label="Join chat"  onClick={() => openWin("join", setJoinOpen)}   disabled={!selected.length} />}
                    {can("join")    && <ToolbarIconButton icon={UserMinus} label="Leave chat" onClick={() => openWin("leave", setLeaveOpen)} disabled={!selected.length} />}
                    {can("raid")    && <ToolbarIconButton icon={Zap}       label="Raid"       onClick={() => openWin("raid", setRaidOpen)}   disabled={!selected.length} />}
                    {can("vc")      && <ToolbarIconButton icon={PhoneCall} label="Voice chat" onClick={() => openWin("vc", setVcOpen)}       disabled={!selected.length} />}
                    {can("profile") && <ToolbarIconButton icon={Dices}     label="Randomize names & avatars"        onClick={() => openWin("randomize", setRandomizeOpen)} />}
                    {can("profile") && <ToolbarIconButton icon={IdCard}    label="Set profile on selected accounts" onClick={() => openWin("bulkprofile", setBulkProfileOpen)} disabled={!selected.length} />}
                    {can("ai")      && <ToolbarIconButton icon={Sparkles}  label="AI report assistant" onClick={() => { setAiMode("report"); openWin("ai", setAiOpen) }} />}
                    {can("mail")    && <ToolbarIconButton icon={Mail}      label="Mailbox"    onClick={() => openWin("mail", setMailOpen)} />}
                  </>
                )}

                {isRunning && (
                  <div className="flex items-center gap-2 px-1">
                    <div className="flex gap-1">
                      {[0,1,2].map(i => (
                        <span key={i} className="h-1.5 w-1.5 rounded-full bg-success inline-block"
                          style={{ animation: `pulseDot 1.2s ease-in-out ${i*0.2}s infinite` }} />
                      ))}
                    </div>
                    <span className="text-xs font-bold text-success tracking-wide">RUNNING</span>
                  </div>
                )}
                {hasStopped && !isRunning && <span className="px-1 text-xs font-bold text-destructive tracking-wide">STOPPED</span>}
                {currentHash && <code className="text-[10px] text-muted-foreground/40 font-mono">#{currentHash.slice(0,8)}</code>}
              </div>
            </div>

            {/* Primary run controls — pinned right (reporting perk only) */}
            <div className="flex items-center gap-1 shrink-0">
              {can("report") && (
                <>
                  {hasStopped && (
                    <Button variant="outline" size="sm" onClick={handleReset}>
                      <RotateCcw className="h-3.5 w-3.5" />Reset
                    </Button>
                  )}
                  {isRunning
                    ? <Button variant="destructive" size="sm" onClick={handleStop}><Square className="h-3.5 w-3.5 fill-current" />Stop</Button>
                    : !hasStopped
                      ? <Button size="sm" onClick={handleStart} disabled={!selected.length}><Play className="h-3.5 w-3.5 fill-current" />Start</Button>
                      : null}
                  <Separator orientation="vertical" className="mx-0.5 h-5" />
                  <ToolbarIconButton icon={PanelRight} label="Toggle options" onClick={() => setRightOpen(v => !v)} />
                </>
              )}
            </div>
          </Card>

          {/* Accounts Card */}
          <Card className="flex-1 flex flex-col overflow-hidden">
            <CardHeader className="flex-row items-center gap-2 px-4 py-2.5 border-b border-border space-y-0 shrink-0">
              <span className="text-sm font-semibold">Accounts</span>
              <span className="text-xs text-muted-foreground">{selected.length}/{sessions.filter(s => botActiveSessions === null || botActiveSessions.includes(s.index)).length}</span>
              <div className="flex-1" />

              {!editMode && !hasStopped && (
                <>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                    onClick={() => setSelected(sessions.filter(s => botActiveSessions === null || botActiveSessions.includes(s.index)).map(s => s._id.toString()))}>Select All</Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                    onClick={() => setSelected([])}>Clear</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <Filter className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={4}>
                      <DropdownMenuItem onClick={() => setSelected(sessions.filter(s => s.premium).map(s => s._id.toString()))}>
                        Premium only
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSelected(sessions.filter(s => !s.premium).map(s => s._id.toString()))}>
                        Non-premium
                      </DropdownMenuItem>
                      {dcIds.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          {dcIds.map(dc => (
                            <DropdownMenuItem key={dc} onClick={() => setSelected(sessions.filter(s => s.dcId === dc).map(s => s._id.toString()))}>
                              DC{dc}
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                      {countries.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          {countries.map(c => (
                            <DropdownMenuItem key={c} onClick={() => setSelected(sessions.filter(s => (s.country || phoneToCountry(s.phone)) === c).map(s => s._id.toString()))}>
                              {c}
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}

              {isAdmin && (
                <Button variant={editMode ? "secondary" : "ghost"} size="icon" className="h-7 w-7"
                  onClick={() => setEditMode(v => !v)}>
                  {editMode ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                </Button>
              )}
            </CardHeader>

            <ScrollArea className="flex-1">
              <div className="p-3">
                {sessions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 gap-3">
                    <p className="text-sm text-muted-foreground">No accounts added</p>
                    {isAdmin && (
                      <Button size="sm" onClick={() => { setEditMode(true); setAddOpen(true) }}>
                        <Plus className="h-3.5 w-3.5" />Add Account
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))" }}>
                    {sessions.map(session => {
                      const sid = session._id.toString()
                      const isSel = selected.includes(sid)
                      const country = session.country || phoneToCountry(session.phone)
                      const rawName = session.name || `Account #${session.index}`
                      const displayName = privacyMode ? "*".repeat(rawName.length) : rawName
                      const displayPhone = privacyMode && session.phone ? "*".repeat(session.phone.length) : session.phone
                      // A session is "active" if bot hasn't reported its session list yet (null = unknown = assume active),
                      // OR if its index appears in the bot's active sessions list
                      const isActive = botActiveSessions === null || botActiveSessions.includes(session.index)
                      const isStarting = startingSession === session.index
                      // VC lock: who (if anyone) currently has this account in a call
                      const lockOwner   = vcLocks[session.index] || null
                      const lockedMine  = lockOwner && lockOwner === myUser
                      const lockedOther = lockOwner && lockOwner !== myUser && !isAdmin   // others can't grab it
                      const selectable  = !editMode && !hasStopped && isActive && !lockedOther

                      return (
                        <motion.div key={sid} layout
                          draggable={editMode}
                          onDragStart={editMode ? (e) => { setDragging(session); e.dataTransfer.effectAllowed = "move" } : undefined}
                          onDragOver={editMode ? (e) => { e.preventDefault(); if (dragging && session._id !== dragging._id) setDragOver(session._id) } : undefined}
                          onDragLeave={editMode ? () => setDragOver(null) : undefined}
                          onDrop={editMode ? (e) => handleDrop(e, session) : undefined}
                          onClick={() => { if (selectable) setSelected(p => p.includes(sid) ? p.filter(c => c !== sid) : [...p, sid]); else if (lockedOther) showToast(`In use by ${lockOwner}`, "error") }}
                          whileHover={selectable ? { scale: 1.025 } : {}}
                          whileTap={!editMode && !hasStopped && isActive ? { scale: 0.975 } : {}}
                          transition={{ type: "spring", stiffness: 400, damping: 25 }}
                          className={cn(
                            "relative rounded-xl p-3 border select-none transition-colors",
                            isActive
                              ? cn(
                                  "cursor-pointer",
                                  isSel
                                    ? "bg-secondary border-border shadow-sm"
                                    : session.premium
                                      ? "bg-destructive/10 border-destructive/30 hover:bg-destructive/10 hover:border-destructive/30"
                                      : "bg-secondary/10 border-border/30 hover:bg-secondary/25 hover:border-border/60",
                                  editMode && "cursor-grab",
                                  hasStopped && !editMode && "opacity-50 pointer-events-none",
                                )
                              : cn("cursor-default opacity-50 bg-secondary/5 border-border/20", editMode && "cursor-grab"),
                            dragOver === session._id && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                            lockedOther && "opacity-60",
                            lockedMine && "ring-1 ring-success/40",
                          )}
                        >
                          {/* Edit mode icons — active: pencil + trash; inactive: trash only */}
                          {editMode && (
                            <div className="absolute top-2 right-2 flex items-center gap-1">
                              {isActive && (
                                <button onClick={e => { e.stopPropagation(); setEditProfileSession(session); setEditProfileOpen(true) }}
                                  className="h-5 w-5 flex items-center justify-center text-muted-foreground/40 hover:text-foreground transition-colors">
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}
                              <button onClick={e => { e.stopPropagation(); setDeleteTarget(session) }}
                                className="h-5 w-5 flex items-center justify-center text-muted-foreground/40 hover:text-destructive transition-colors">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          )}

                          {/* Inactive (not edit mode): play button in corner like check icon */}
                          {!isActive && !editMode && (
                            <div className="absolute top-2 right-2">
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  if (isStarting) return
                                  setStartingSession(session.index)
                                  send({ type: "startSession", index: session.index })
                                }}
                                className="h-5 w-5 flex items-center justify-center text-muted-foreground/30 hover:text-success transition-colors"
                                title="Start session"
                              >
                                {isStarting
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <Play className="h-3 w-3 fill-current" />
                                }
                              </button>
                            </div>
                          )}

                          <p className="text-[9px] text-muted-foreground/25 mb-1.5 font-mono">#{session.index}</p>

                          <div className="flex items-center gap-2 mb-1">
                            <AccountAvatar
                              session={privacyMode ? { name: "?" } : session}
                              className="h-8 w-8 shrink-0 text-[11px] border border-border/40"
                            />
                            <div className="min-w-0 flex-1">
                              {editingId === session._id ? (
                                <div onClick={e => e.stopPropagation()}>
                                  <Input value={editName} onChange={e => setEditName(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") saveSessionName(session); if (e.key === "Escape") setEditingId(null) }}
                                    onBlur={() => saveSessionName(session)}
                                    className="h-6 text-xs px-1 rounded-sm" autoFocus />
                                </div>
                              ) : (
                                <p onDoubleClick={editMode && isActive ? e => { e.stopPropagation(); setEditingId(session._id); setEditName(session.name || "") } : undefined}
                                  className="text-sm font-semibold truncate leading-tight">
                                  {displayName}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1 flex-wrap">
                            {displayPhone && <span className="text-[10px] text-muted-foreground font-mono">{privacyMode ? displayPhone : `+${displayPhone}`}</span>}
                            {country && !privacyMode && <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-medium">{country}</span>}
                            {session.dcId && !privacyMode && <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-medium">DC{session.dcId}</span>}
                          </div>

                          {/* VC lock — in a call (greyed for others; admin can kick it out) */}
                          {lockOwner && !editMode && (
                            <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                              <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1",
                                lockedMine ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>
                                {lockedMine ? <Radio className="h-2.5 w-2.5" /> : <KeyRound className="h-2.5 w-2.5" />}
                                {lockedMine ? "In your call" : (privacyMode ? "In use" : `In use · ${lockOwner}`)}
                              </span>
                              {isAdmin && (
                                <button
                                  onClick={e => { e.stopPropagation(); send({ type: "vcAdminLeave", index: session.index }); showToast(`Removing #${session.index} from its call`) }}
                                  className="text-[9px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive hover:bg-destructive/25 flex items-center gap-1"
                                  title="Force-leave this account from its call">
                                  <PhoneOff className="h-2.5 w-2.5" /> Kick
                                </button>
                              )}
                            </div>
                          )}

                          {isSel && !editMode && isActive && (
                            <div className="absolute top-2 right-2">
                              <CheckCircle2 className="h-3.5 w-3.5 text-primary/60" />
                            </div>
                          )}
                        </motion.div>
                      )
                    })}

                    {editMode && isAdmin && (
                      <button onClick={() => setAddOpen(true)}
                        className="rounded-xl p-3 border border-dashed border-border/20 hover:border-border/50 hover:bg-secondary/10 transition-colors flex flex-col items-center justify-center gap-1.5 min-h-[80px]">
                        <Plus className="h-4 w-4 text-muted-foreground/25" />
                        <span className="text-[10px] text-muted-foreground/25 font-medium">Add account</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          </Card>
        </div>

        {/* Right handle (desktop, reporting perk only) */}
        {!isMobile && can("report") && rightOpen && (
          <div className="w-3 shrink-0 flex items-center justify-center cursor-col-resize group"
            onMouseDown={right.onMouseDown}>
            <div className="w-px h-12 rounded-full bg-border/20 group-hover:bg-primary/40 group-hover:h-20 group-hover:w-0.5 transition-all" />
          </div>
        )}

        {/* ─── Right Panel — desktop inline (mobile renders it as a drawer below) ─ */}
        {!isMobile && can("report") && (
        <motion.div
          animate={{ width: rightOpen ? right.width : 0, opacity: rightOpen ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="shrink-0 overflow-hidden"
        >
          <div style={{ width: right.width }} className="h-full">
            {optionsPanelEl}
          </div>
        </motion.div>
        )}

      </div>

      {/* ─── Mobile drawers ───────────────────────────── */}
      {isMobile && leftOpen && (
        <div className="fixed inset-0 z-[9000]">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setLeftOpen(false)} />
          <motion.div initial={{ x: "-100%" }} animate={{ x: 0 }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            className="absolute left-0 top-0 bottom-0 w-[86vw] max-w-[360px] p-2">
            {leftPanelEl}
          </motion.div>
        </div>
      )}
      {isMobile && rightOpen && can("report") && (
        <div className="fixed inset-0 z-[9000]">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setRightOpen(false)} />
          <motion.div initial={{ x: "100%" }} animate={{ x: 0 }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            className="absolute right-0 top-0 bottom-0 w-[86vw] max-w-[360px] p-2">
            {optionsPanelEl}
          </motion.div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={cn(
            "fixed top-5 left-1/2 -translate-x-1/2 z-[10000] px-5 py-2.5 rounded-xl text-sm font-medium shadow-2xl",
            toast.type === "error"
              ? "bg-destructive text-destructive-foreground"
              : "bg-secondary text-foreground border border-border"
          )}
        >
          {toast.msg}
        </motion.div>
      )}

      <DeleteDialog session={deleteTarget} onConfirm={() => deleteSession(deleteTarget)} onCancel={() => setDeleteTarget(null)} />
      <AddSessionDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={loadSessions} wsRef={wsRef} availableIndexes={sessions.map(s => s.index)} />
      <UsersDialog open={usersOpen} onClose={() => setUsersOpen(false)} />
      <DownloadDialog open={downloadOpen} onClose={() => setDownloadOpen(false)} logs={progressLogs} reportMeta={reportMeta} />
      {joinOpen && (
        <JoinDialog  visible={!minimized.join}  onMinimize={() => minimizeWin("join")}  onClose={() => setJoinOpen(false)}  selected={selected} sessions={sessions} send={send} addListener={addListener} />
      )}
      {leaveOpen && (
        <LeaveDialog visible={!minimized.leave} onMinimize={() => minimizeWin("leave")} onClose={() => setLeaveOpen(false)} selected={selected} send={send} addListener={addListener} />
      )}
      {raidOpen && (
        <RaidDialog  visible={!minimized.raid}  onMinimize={() => minimizeWin("raid")}  onClose={() => setRaidOpen(false)}  selected={selected} send={send} addListener={addListener} showToast={showToast} />
      )}
      {vcOpen && (
        <VCDialog    visible={!minimized.vc}    onMinimize={() => minimizeWin("vc")}    onClose={() => setVcOpen(false)}    selected={selected} sessions={sessions} send={send} addListener={addListener} showToast={showToast} />
      )}

      <MinimizedDock
        windows={[
          { key: "vc",    open: vcOpen,    label: "Voice Call",   Icon: PhoneCall },
          { key: "join",  open: joinOpen,  label: "Join Chat",    Icon: UserPlus  },
          { key: "leave", open: leaveOpen, label: "Leave Chat",   Icon: UserMinus },
          { key: "raid",  open: raidOpen,  label: "Raid",         Icon: Zap       },
          { key: "ai",    open: aiOpen,    label: "AI Assistant", Icon: Sparkles  },
          { key: "mail",  open: mailOpen,  label: "Mailbox",      Icon: Mail      },
          { key: "randomize",   open: randomizeOpen,   label: "Randomize",   Icon: Dices  },
          { key: "bulkprofile", open: bulkProfileOpen, label: "Set Profile", Icon: IdCard },
        ].filter(w => w.open && minimized[w.key])}
        onRestore={restoreWin}
      />
      <EditProfileDialog open={editProfileOpen} onClose={() => setEditProfileOpen(false)} session={editProfileSession} send={send} addListener={addListener} botOnline={botOnline}
        onProfileSaved={(index, name) => { if (name) setSessions(p => p.map(s => s.index === index ? { ...s, name } : s)) }}
      />
      {randomizeOpen && (
        <RandomizeDialog visible={!minimized.randomize} onMinimize={() => minimizeWin("randomize")} onClose={() => setRandomizeOpen(false)} selected={selected} sessions={sessions} botActiveSessions={botActiveSessions} send={send} addListener={addListener} showToast={showToast} />
      )}
      {bulkProfileOpen && (
        <BulkProfileDialog visible={!minimized.bulkprofile} onMinimize={() => minimizeWin("bulkprofile")} onClose={() => setBulkProfileOpen(false)} selected={selected} sessions={sessions} botActiveSessions={botActiveSessions} send={send} addListener={addListener} showToast={showToast} />
      )}
      {aiOpen && (
        <AiChat
          visible={!minimized.ai}
          onMinimize={() => minimizeWin("ai")}
          onClose={() => setAiOpen(false)}
          send={send} addListener={addListener}
          sessions={sessions} botActiveSessions={botActiveSessions} selected={selected}
          mode={aiMode} newChatKey={aiNewChat}
          applyReportConfig={applyReportConfig}
          onEmailDraft={(d) => setEmailDraft({ ...d, _ts: Date.now() })}
          showToast={showToast}
        />
      )}
      {mailOpen && (
        <Mailbox
          visible={!minimized.mail}
          onMinimize={() => minimizeWin("mail")}
          onClose={() => setMailOpen(false)}
          emailDraft={emailDraft}
          onRequestAiDraft={() => { setAiMode("email"); setAiNewChat(n => n + 1); openWin("ai", setAiOpen) }}
          showToast={showToast}
        />
      )}
    </TooltipProvider>
  )
}
