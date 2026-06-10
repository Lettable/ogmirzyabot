"use client"
import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useWs } from "@/lib/useWs"
import { cn } from "@/lib/utils"
import { motion } from "motion/react"

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

// icons
import { Play, Square, RotateCcw, RefreshCw, Plus, Trash2, Pencil, Check, X, Users, LogOut, Filter, Loader2, CheckCircle2, PanelLeft, PanelRight, Search, Download, AlertTriangle, Eye, EyeOff, UserPlus, UserMinus } from "lucide-react"

// antd
import { Input as AntInput, InputNumber as AntInputNumber } from "antd"
import { TreeSelect } from "antd"
import "antd/dist/reset.css"

// shadcn Textarea
import { Textarea } from "@/components/ui/textarea"

// local
import AddSessionDialog from "@/components/ui/addSessionDialog"
import { LiveNotificationList } from "@/components/ui/live-notifications"

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
    <ScrollArea className="max-h-[55vh]">
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
                      ? "bg-emerald-950/50 text-emerald-400"
                      : "bg-red-950/50 text-red-400"
                  )}>
                    {log.worked ? "OK" : "FAIL"}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{msgIds}</TableCell>
                <TableCell className="text-muted-foreground text-xs max-w-[120px] truncate" title={reasonDisplay}>{reasonDisplay}</TableCell>
                <TableCell className="text-destructive/70 text-xs max-w-[140px] truncate" title={log.error || ""}>{log.error || "—"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground/60 tabular-nums">{timeStr}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </ScrollArea>
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

function LeftPanel({ logs, reportMeta, onLogout, onClearLogs, historyRefreshKey }) {
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
          <span className="text-xs font-semibold flex-1">Live Reports</span>
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
          <LiveNotificationList logs={logs} reportMeta={reportMeta} />
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
            <AntInputNumber
              min={1} max={100000} placeholder="e.g. 100"
              value={amount} onChange={v => setAmount(v)}
              disabled={disabled} style={{ width: "100%", height: 36 }}
              controls={false}
            />
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
              <p className={cn("text-[11px] mt-1", isFormatsValid ? "text-emerald-500" : "text-destructive")}>
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
                <AntInputNumber
                  min={1} max={300} value={delayMax} controls={false}
                  onChange={v => {
                    const n = Math.max(1, v || 30)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={disabled}
                  style={{ width: 52, height: 28 }}
                />
              </div>
            </div>
          </Field>

          {/* Telegram Links (public + private) */}
          {(isPublic || isPrivate) && (
            <Field label="Telegram Links">
              <AntInput.TextArea
                value={display}
                onChange={e => { if (!disabled) setTelegramLinks(e.target.value) }}
                onFocus={() => setIsFocused(true)}
                onBlur={handleBlur}
                placeholder={isPublic ? "t.me/user/123, t.me/user/456 …" : "t.me/c/3896228938/1, t.me/c/3896228938/2 …"}
                autoSize={{ minRows: 2, maxRows: 4 }}
                status={parsedData?.hasError ? "error" : ""}
                disabled={disabled}
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
                  <span className={cn("text-[11px]", parsedData.hasError ? "text-destructive" : "text-emerald-500")}>
                    {parsedData.hasError ? "Parse error" : `${parsedData.messageIds.length} IDs`}
                  </span>
                )}
              </div>
            </Field>
          )}

          {/* Reasons */}
          <Field label="Reasons">
            <TreeSelect
              treeData={isUserId ? USER_TREE : MSG_TREE}
              value={treeValue} onChange={onTreeChange}
              treeCheckable showCheckedStrategy={TreeSelect.SHOW_ALL}
              placeholder="Select reasons" style={{ width: "100%" }}
              showSearch disabled={isRunning} size="middle"
              filterTreeNode={(input, node) =>
                (node.title ?? "").toString().toLowerCase().includes(input.toLowerCase())
              }
            />
          </Field>

          {/* Public: extracted username (disabled) */}
          {isPublic && (
            <Field label="Chat Username">
              <AntInput
                value={extractedUsername}
                disabled
                placeholder="Auto-filled from links"
                style={{ height: 36 }}
              />
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
              <AntInput
                value={extractedChatId}
                disabled
                placeholder="Auto-filled from links (e.g. -1003896228938)"
                style={{ height: 36 }}
              />
            </Field>
          )}

          {/* User: username string */}
          {isUserId && (
            <Field label="Username">
              <AntInput
                value={userTarget}
                onChange={e => setUserTarget(e.target.value)}
                placeholder="@username"
                disabled={disabled}
                style={{ height: 36 }}
              />
            </Field>
          )}

        </div>
      </ScrollArea>
    </Card>
  )
}

// ─── Users Dialog ────────────────────────────────────────────────────────────

function UserRow({ u, onAct, onDel }) {
  const status = u.isTerminated ? "terminated" : u.isAuthorized ? "active" : "pending"
  return (
    <div className="flex items-center gap-3 py-3 px-1 border-b border-border/30 last:border-0">
      <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center shrink-0 text-sm font-bold text-muted-foreground uppercase">
        {u.username[0]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">{u.username}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 capitalize">{status}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!u.isAuthorized && !u.isTerminated && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-500 hover:bg-emerald-950/50"
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
  )
}

function UsersDialog({ open, onClose }) {
  const [users, setUsers]       = useState([])
  const [loading, setLoading]   = useState(false)
  const [tab, setTab]           = useState("all")
  const [form, setForm]         = useState({ username: "", password: "" })
  const [addLoading, setAddLoading] = useState(false)
  const [err, setErr]           = useState("")
  const auth = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" })

  const load = async () => {
    setLoading(true)
    try { const r = await fetch("/api/admin/users", { headers: auth() }); const d = await r.json(); setUsers(d.users || []) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (open) { load(); setTab("all"); setErr(""); setForm({ username: "", password: "" }) } }, [open])

  const act = async (username, action) => {
    await fetch("/api/admin/users", { method: "PATCH", headers: auth(), body: JSON.stringify({ username, action }) }); load()
  }
  const del = async (username) => {
    await fetch(`/api/admin/users?username=${username}`, { method: "DELETE", headers: auth() }); load()
  }
  const create = async () => {
    if (!form.username.trim() || !form.password.trim()) { setErr("Both fields are required"); return }
    setAddLoading(true); setErr("")
    try {
      const r = await fetch("/api/admin/users", { method: "POST", headers: auth(), body: JSON.stringify(form) })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || "Failed to create user"); return }
      setForm({ username: "", password: "" }); setTab("all"); load()
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
          {items.map(u => <UserRow key={u._id} u={u} onAct={act} onDel={del} />)}
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
                      v === "pending"    ? "bg-yellow-900/60 text-yellow-400" :
                      v === "active"     ? "bg-emerald-900/60 text-emerald-400" :
                      v === "terminated" ? "bg-red-900/60 text-red-400" :
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
                  <p className="text-[11px] text-muted-foreground">User will be created without authorization — approve them from the Pending tab.</p>
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
              onClick={() => { setTab("all"); setErr(""); setForm({ username: "", password: "" }) }}>
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

function EditProfileDialog({ open, onClose, session, send, addListener }) {
  const [firstName,     setFirstName]     = useState("")
  const [lastName,      setLastName]      = useState("")
  const [bio,           setBio]           = useState("")
  const [photo,         setPhoto]         = useState(null)    // { preview, b64 }
  const [saving,        setSaving]        = useState(false)
  const [deletingPhotos,setDeletingPhotos]= useState(false)
  const [result,        setResult]        = useState(null)    // { ok, error }
  const fileRef = useRef(null)

  useEffect(() => {
    if (!session) return
    const parts = (session.name || "").split(" ")
    setFirstName(parts[0] || "")
    setLastName(parts.slice(1).join(" ") || "")
    setBio("")
    setPhoto(null)
    setResult(null)
  }, [session])

  useEffect(() => {
    if (!open) return
    const rm = addListener("editProfileResult", msg => {
      if (String(msg.index) !== String(session?.index)) return
      setSaving(false)
      setDeletingPhotos(false)
      setResult({ ok: msg.ok, error: msg.error, action: msg.action })
    })
    return rm
  }, [open, session, addListener])

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    const reader  = new FileReader()
    reader.onload = (ev) => setPhoto({ preview, b64: ev.target.result.split(",")[1] })
    reader.readAsDataURL(file)
  }

  const handleSave = () => {
    if (!session) return
    setSaving(true); setResult(null)
    send({ type: "editProfile", index: session.index,
      firstName: firstName.trim(), lastName: lastName.trim(),
      bio: bio.trim(), photo: photo?.b64 || null })
  }

  const handleDeletePhotos = () => {
    if (!session) return
    setDeletingPhotos(true); setResult(null)
    send({ type: "editProfile", index: session.index, deletePhotos: true })
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription className="text-xs">Changes apply directly to the Telegram account.</DialogDescription>
        </DialogHeader>

        {/* Two-column layout: photo left, fields right */}
        <div className="flex gap-5 py-1">

          {/* Left — avatar + photo actions */}
          <div className="flex flex-col items-center gap-2 shrink-0">
            {/* Avatar */}
            <button type="button" onClick={() => fileRef.current?.click()}
              className="relative h-20 w-20 rounded-full overflow-hidden bg-secondary border border-border hover:border-ring transition-colors group">
              {photo?.preview
                ? <img src={photo.preview} alt="preview" className="h-full w-full object-cover" />
                : <div className="h-full w-full flex items-center justify-center text-muted-foreground/30">
                    <Users className="h-7 w-7" />
                  </div>
              }
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Pencil className="h-4 w-4 text-white" />
              </div>
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />

            {/* Change photo button */}
            <Button variant="outline" size="sm" className="h-7 text-xs w-full px-2"
              onClick={() => fileRef.current?.click()}>
              Change
            </Button>

            {/* Delete all photos */}
            <Button variant="outline" size="sm"
              className="h-7 text-xs w-full px-2 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              onClick={handleDeletePhotos} disabled={deletingPhotos}>
              {deletingPhotos
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <><Trash2 className="h-3 w-3 mr-1" />Delete all</>
              }
            </Button>
          </div>

          {/* Right — input fields */}
          <div className="flex-1 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">First Name</Label>
                <Input value={firstName} onChange={e => setFirstName(e.target.value)}
                  placeholder="First" className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Last Name</Label>
                <Input value={lastName} onChange={e => setLastName(e.target.value)}
                  placeholder="Last" className="h-8 text-sm" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Bio</Label>
              <Input value={bio} onChange={e => setBio(e.target.value)}
                placeholder="About me…" className="h-8 text-sm" maxLength={70} />
              <p className="text-[10px] text-muted-foreground/40 text-right tabular-nums">{bio.length}/70</p>
            </div>

            {result && (
              <p className={cn("text-xs", result.ok ? "text-emerald-500" : "text-destructive")}>
                {result.ok
                  ? (result.action === "deletePhotos" ? "All photos deleted." : "Profile updated.")
                  : (result.error || "Update failed.")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 mt-1">
          <Button variant="ghost" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            Save
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

function JoinDialog({ open, onClose, selected, sessions, send, addListener }) {
  const [link, setLink]               = useState("")
  const [linkError, setLinkError]     = useState("")
  const [delayRange, setDelayRange]   = useState([2, 5])
  const [delayMax, setDelayMax]       = useState(15)
  const [running, setRunning]         = useState(false)
  const [logs, setLogs]               = useState([])

  useEffect(() => {
    if (open) { setLogs([]); setLink(""); setRunning(false); setLinkError("") }
  }, [open])

  useEffect(() => {
    const rmP = addListener("joinProgress", (msg) => setLogs(p => [...p, msg]))
    const rmC = addListener("joinComplete",  ()    => setRunning(false))
    const rmE = addListener("joinError",     ()    => setRunning(false))
    return () => { rmP(); rmC(); rmE() }
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
    setLogs([])
    send({ type: "joinChat", clients: selected, link: link.trim(), delayMin: delayRange[0], delayMax: delayRange[1] })
  }

  const clientCount = selected.length

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !running) onClose() }}>
      <DialogContent className="max-w-md flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle>Join Chat</DialogTitle>
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
                <AntInputNumber
                  min={0} max={300} value={delayMax} controls={false}
                  onChange={v => {
                    const n = Math.max(0, v || 15)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={running}
                  style={{ width: 52, height: 28 }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Join logs */}
        {logs.length > 0 && (
          <div className="px-6 pb-2">
            <ScrollArea className="max-h-48 rounded-lg border border-border bg-secondary/10">
              <div className="p-2 space-y-1.5">
                {logs.map((l, i) => (
                  <div key={i} className={cn(
                    "flex items-center justify-between gap-2 rounded-lg px-3 py-2 border text-[11px]",
                    l.worked
                      ? "border-emerald-900/30 bg-emerald-950/10"
                      : "border-red-900/30 bg-red-950/10"
                  )}>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        l.worked ? "bg-emerald-500/70" : "bg-red-500/70"
                      )} />
                      <span className="font-semibold truncate">{l.client}</span>
                      {l.error && (
                        <span className="text-muted-foreground truncate">· {l.error}</span>
                      )}
                    </div>
                    <span className="font-mono text-muted-foreground/60 shrink-0">
                      {l.time ? new Date(l.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
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

function LeaveDialog({ open, onClose, selected, send, addListener }) {
  const [chat, setChat]               = useState("")
  const [chatError, setChatError]     = useState("")
  const [delayRange, setDelayRange]   = useState([2, 5])
  const [delayMax, setDelayMax]       = useState(15)
  const [running, setRunning]         = useState(false)
  const [logs, setLogs]               = useState([])

  useEffect(() => {
    if (open) { setLogs([]); setChat(""); setRunning(false); setChatError("") }
  }, [open])

  useEffect(() => {
    const rmP = addListener("leaveProgress", (msg) => setLogs(p => [...p, msg]))
    const rmC = addListener("leaveComplete",  ()    => setRunning(false))
    const rmE = addListener("leaveError",     ()    => setRunning(false))
    return () => { rmP(); rmC(); rmE() }
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
    setLogs([])
    send({ type: "leaveChat", clients: selected, chat: chat.trim(), delayMin: delayRange[0], delayMax: delayRange[1] })
  }

  const clientCount = selected.length

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !running) onClose() }}>
      <DialogContent className="max-w-md flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle>Leave Chat</DialogTitle>
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
                <AntInputNumber
                  min={0} max={300} value={delayMax} controls={false}
                  onChange={v => {
                    const n = Math.max(0, v || 15)
                    setDelayMax(n)
                    setDelayRange(p => [Math.min(p[0], n), Math.min(p[1], n)])
                  }}
                  disabled={running}
                  style={{ width: 52, height: 28 }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Leave logs */}
        {logs.length > 0 && (
          <div className="px-6 pb-2">
            <ScrollArea className="max-h-48 rounded-lg border border-border bg-secondary/10">
              <div className="p-2 space-y-1.5">
                {logs.map((l, i) => (
                  <div key={i} className={cn(
                    "flex items-center justify-between gap-2 rounded-lg px-3 py-2 border text-[11px]",
                    l.worked
                      ? "border-emerald-900/30 bg-emerald-950/10"
                      : "border-red-900/30 bg-red-950/10"
                  )}>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        l.worked ? "bg-emerald-500/70" : "bg-red-500/70"
                      )} />
                      <span className="font-semibold truncate">{l.client}</span>
                      {l.error && (
                        <span className="text-muted-foreground truncate">· {l.error}</span>
                      )}
                    </div>
                    <span className="font-mono text-muted-foreground/60 shrink-0">
                      {l.time ? new Date(l.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
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

// ─── Dashboard ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const router = useRouter()
  const { wsRef, send, botOnline, connected, botSessionCount, botActiveReports, addListener } = useWs()

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

  const left  = useHResize(264, 180, 420, "left")
  const right = useHResize(274, 200, 420, "right")

  useEffect(() => {
    const token = localStorage.getItem("token")
    if (!token) { router.push("/"); return }
    setIsAdmin(localStorage.getItem("isAdmin") === "1")
    loadSessions(token)
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
        timestamp:   Date.now(),
        reasonLabel: msg.reason ? (REASON_MAP[msg.reason] || msg.reason) : null,
      }])
    )
    const rmD = addListener("reportComplete", msg => {
      setProgressLogs(p => [...p, { ...msg, timestamp: Date.now() }])
      setIsRunning(false)
      setHasStopped(true)
      setDownloadOpen(true)
      setHistoryRefreshKey(k => k + 1)
    })
    const rmS = addListener("botStatus", msg => {
      setReloading(false)
      if (msg.reloadResult) {
        const { added, total } = msg.reloadResult
        showToast(added > 0 ? `Loaded ${added} new session(s). ${total} active.` : `No new sessions. ${total} active.`)
      }
      if (msg.toast) showToast(msg.toast)
    })
    const rmR = addListener("renameResult", msg => {
      if (msg.ok) {
        showToast(`Account #${msg.index} renamed on Telegram`)
      } else {
        showToast(msg.error || "Rename failed", "error")
      }
    })
    return () => { rmP(); rmD(); rmS(); rmR() }
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

    const payload = { hash, clients: selected, data, formats }
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
  }

  const logout = () => { localStorage.clear(); document.cookie = "token=; max-age=0; path=/"; router.push("/") }

  const deleteSession = async (s) => {
    await fetch(`/api/admin/sessions?id=${s._id}`, { method: "DELETE", headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } })
    setSelected(p => p.filter(id => id !== s._id.toString()))
    setDeleteTarget(null); loadSessions()
  }

  const saveSessionName = async (s) => {
    if (!editName.trim()) { setEditingId(null); return }
    const name = editName.trim()
    await fetch("/api/admin/sessions", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: s._id.toString(), name }),
    })
    // Also update the actual Telegram account's display name
    send({ type: "renameAccount", index: s.index, name })
    setEditingId(null); setEditName(""); loadSessions()
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

  return (
    <TooltipProvider>
      <div className="h-screen bg-background overflow-hidden flex gap-0 p-2">

        {/* ─── Left Panel ──────────────────────────────── */}
        <motion.div
          animate={{ width: leftOpen ? left.width : 0, opacity: leftOpen ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="shrink-0 overflow-hidden"
        >
          <div style={{ width: left.width }} className="h-full">
            <LeftPanel logs={progressLogs} reportMeta={reportMeta} onLogout={logout} onClearLogs={() => setProgressLogs([])} historyRefreshKey={historyRefreshKey} />
          </div>
        </motion.div>

        {/* Left handle */}
        {leftOpen && (
          <div className="w-3 shrink-0 flex items-center justify-center cursor-col-resize group"
            onMouseDown={left.onMouseDown}>
            <div className="w-px h-12 rounded-full bg-border/20 group-hover:bg-primary/40 group-hover:h-20 group-hover:w-0.5 transition-all" />
          </div>
        )}

        {/* ─── Center ──────────────────────────────────── */}
        <div className="flex-1 flex flex-col gap-2 min-w-0">

          {/* Top bar */}
          <Card className="flex items-center px-3 h-12 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLeftOpen(v => !v)}>
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle feed</TooltipContent>
            </Tooltip>

            <div className="flex-1" />

            <div className="flex items-center gap-2">
              {/* Bot status indicator */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md cursor-default select-none text-[11px] tabular-nums",
                    botOnline ? "bg-secondary/40 text-muted-foreground" : "bg-red-950/30 text-red-400/70"
                  )}>
                    {botOnline
                      ? `Bot · ${botSessionCount ?? 0} sessions`
                      : "Bot offline"}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {botOnline
                    ? `Bot connected · ${botSessionCount ?? 0} active sessions${botActiveReports > 0 ? ` · ${botActiveReports} running` : ""}`
                    : "Bot is not connected"}
                </TooltipContent>
              </Tooltip>

              {isAdmin && !isRunning && !hasStopped && (
                <>
                  <div className="w-px h-4 bg-border" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleReloadSessions} disabled={reloading || !botOnline}>
                        <RefreshCw className={cn("h-3.5 w-3.5", reloading && "animate-spin")} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Sync sessions to bot</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={privacyMode ? "secondary" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setPrivacyMode(v => !v)}
                      >
                        {privacyMode ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{privacyMode ? "Show account info" : "Hide account info (streaming mode)"}</TooltipContent>
                  </Tooltip>
                  <Button variant="ghost" size="sm" onClick={() => setUsersOpen(true)}>
                    <Users className="h-3.5 w-3.5" />Users
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />Add Account
                  </Button>
                  <div className="w-px h-4 bg-border mx-1" />
                </>
              )}

              {isRunning && (
                <>
                  <div className="flex gap-1">
                    {[0,1,2].map(i => (
                      <span key={i} className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block"
                        style={{ animation: `pulseDot 1.2s ease-in-out ${i*0.2}s infinite` }} />
                    ))}
                  </div>
                  <span className="text-xs font-bold text-emerald-500 tracking-wide">RUNNING</span>
                  {total > 0 && <span className="text-xs text-muted-foreground tabular-nums">{total}/{reportMeta?.amount ?? "?"}</span>}
                </>
              )}
              {hasStopped && !isRunning && <span className="text-xs font-bold text-destructive tracking-wide">STOPPED</span>}
              {currentHash && <code className="text-[10px] text-muted-foreground/25 font-mono">#{currentHash.slice(0,8)}</code>}

              {hasStopped && (
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  <RotateCcw className="h-3.5 w-3.5" />Reset
                </Button>
              )}
              {!isRunning && !hasStopped && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setJoinOpen(true)} disabled={!selected.length}>
                    <UserPlus className="h-3.5 w-3.5" />Join
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setLeaveOpen(true)} disabled={!selected.length}>
                    <UserMinus className="h-3.5 w-3.5" />Leave
                  </Button>
                </>
              )}
              {isRunning
                ? <Button variant="destructive" size="sm" onClick={handleStop}><Square className="h-3.5 w-3.5 fill-current" />Stop</Button>
                : !hasStopped
                  ? <Button size="sm" onClick={handleStart}><Play className="h-3.5 w-3.5 fill-current" />Start</Button>
                  : null}
            </div>

            <div className="flex-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setRightOpen(v => !v)}>
                  <PanelRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle options</TooltipContent>
            </Tooltip>
          </Card>

          {/* Accounts Card */}
          <Card className="flex-1 flex flex-col overflow-hidden">
            <CardHeader className="flex-row items-center gap-2 px-4 py-2.5 border-b border-border space-y-0 shrink-0">
              <span className="text-sm font-semibold">Accounts</span>
              <span className="text-xs text-muted-foreground">{selected.length}/{sessions.length}</span>
              <div className="flex-1" />

              {!editMode && !isRunning && !hasStopped && (
                <>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                    onClick={() => setSelected(sessions.map(s => s._id.toString()))}>Select All</Button>
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
                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))" }}>
                    {sessions.map(session => {
                      const sid = session._id.toString()
                      const isSel = selected.includes(sid)
                      const country = session.country || phoneToCountry(session.phone)
                      const rawName = session.name || `Account #${session.index}`
                      const displayName = privacyMode ? "*".repeat(rawName.length) : rawName
                      const displayPhone = privacyMode && session.phone ? "*".repeat(session.phone.length) : session.phone

                      return (
                        <motion.div key={sid} layout
                          draggable={editMode}
                          onDragStart={editMode ? (e) => { setDragging(session); e.dataTransfer.effectAllowed = "move" } : undefined}
                          onDragOver={editMode ? (e) => { e.preventDefault(); if (dragging && session._id !== dragging._id) setDragOver(session._id) } : undefined}
                          onDragLeave={editMode ? () => setDragOver(null) : undefined}
                          onDrop={editMode ? (e) => handleDrop(e, session) : undefined}
                          onClick={() => { if (!editMode && !isRunning && !hasStopped) setSelected(p => p.includes(sid) ? p.filter(c => c !== sid) : [...p, sid]) }}
                          whileHover={!editMode && !isRunning && !hasStopped ? { scale: 1.025 } : {}}
                          whileTap={!editMode && !isRunning && !hasStopped ? { scale: 0.975 } : {}}
                          transition={{ type: "spring", stiffness: 400, damping: 25 }}
                          className={cn(
                            "relative rounded-xl p-3 border cursor-pointer select-none transition-colors",
                            isSel ? "bg-secondary border-border shadow-sm" : "bg-secondary/10 border-border/30 hover:bg-secondary/25 hover:border-border/60",
                            editMode && "cursor-grab",
                            (isRunning || hasStopped) && !editMode && "opacity-50 pointer-events-none",
                            dragOver === session._id && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                          )}
                        >
                          {editMode && (
                            <div className="absolute top-2 right-2 flex items-center gap-1">
                              <button onClick={e => { e.stopPropagation(); setEditProfileSession(session); setEditProfileOpen(true) }}
                                className="h-5 w-5 flex items-center justify-center text-muted-foreground/40 hover:text-foreground transition-colors">
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button onClick={e => { e.stopPropagation(); setDeleteTarget(session) }}
                                className="h-5 w-5 flex items-center justify-center text-muted-foreground/40 hover:text-destructive transition-colors">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          )}

                          <p className="text-[9px] text-muted-foreground/25 mb-1 font-mono">#{session.index}</p>

                          {editingId === session._id ? (
                            <div onClick={e => e.stopPropagation()}>
                              <Input value={editName} onChange={e => setEditName(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") saveSessionName(session); if (e.key === "Escape") setEditingId(null) }}
                                onBlur={() => saveSessionName(session)}
                                className="h-6 text-xs px-1 mb-1 rounded-sm" autoFocus />
                            </div>
                          ) : (
                            <p onDoubleClick={editMode ? e => { e.stopPropagation(); setEditingId(session._id); setEditName(session.name || "") } : undefined}
                              className="text-sm font-semibold truncate mb-1 leading-tight">
                              {displayName}
                              {session.premium && !privacyMode && <span className="text-yellow-400 ml-1 text-xs">★</span>}
                            </p>
                          )}

                          <div className="flex items-center gap-1 flex-wrap">
                            {displayPhone && <span className="text-[10px] text-muted-foreground font-mono">{privacyMode ? displayPhone : `+${displayPhone}`}</span>}
                            {country && !privacyMode && <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-medium">{country}</span>}
                            {session.dcId && !privacyMode && <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-medium">DC{session.dcId}</span>}
                          </div>

                          {isSel && !editMode && (
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

        {/* Right handle */}
        {rightOpen && (
          <div className="w-3 shrink-0 flex items-center justify-center cursor-col-resize group"
            onMouseDown={right.onMouseDown}>
            <div className="w-px h-12 rounded-full bg-border/20 group-hover:bg-primary/40 group-hover:h-20 group-hover:w-0.5 transition-all" />
          </div>
        )}

        {/* ─── Right Panel ─────────────────────────────── */}
        <motion.div
          animate={{ width: rightOpen ? right.width : 0, opacity: rightOpen ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="shrink-0 overflow-hidden"
        >
          <div style={{ width: right.width }} className="h-full">
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
              isRunning={isRunning} hasStopped={hasStopped}
            />
          </div>
        </motion.div>

      </div>

      {/* Toast */}
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={cn(
            "fixed bottom-5 left-1/2 -translate-x-1/2 z-[300] px-5 py-2.5 rounded-xl text-sm font-medium shadow-2xl",
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
      <JoinDialog  open={joinOpen}  onClose={() => setJoinOpen(false)}  selected={selected} sessions={sessions} send={send} addListener={addListener} />
      <LeaveDialog open={leaveOpen} onClose={() => setLeaveOpen(false)} selected={selected} send={send} addListener={addListener} />
      <EditProfileDialog open={editProfileOpen} onClose={() => setEditProfileOpen(false)} session={editProfileSession} send={send} addListener={addListener} />
    </TooltipProvider>
  )
}
