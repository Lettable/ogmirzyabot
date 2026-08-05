"use client"
import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CheckCircle2, X, Radio, UserPlus, UserMinus, Zap, Users } from "lucide-react"
import { cn } from "@/lib/utils"

const EVENT_META = {
  report: { label: "REPORT", color: "emerald", Icon: Radio },
  join:   { label: "JOIN",   color: "blue",    Icon: UserPlus },
  leave:  { label: "LEAVE",  color: "orange",  Icon: UserMinus },
  raid:   { label: "RAID",   color: "rose",    Icon: Zap },
  vc:     { label: "VC",     color: "violet",  Icon: Users },
}

const COLOR_CLASSES = {
  emerald: "bg-success/10 text-success",
  blue:    "bg-secondary    text-foreground",
  orange:  "bg-warning/10  text-warning",
  rose:    "bg-destructive/10    text-destructive",
  violet:  "bg-secondary  text-foreground",
}

function fmtTime(ts) {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d)) return null
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function EventRow({ item, index }) {
  const eventType = item.eventType || "report"
  const meta      = EVENT_META[eventType] || EVENT_META.report
  const { Icon }  = meta
  const timeStr   = fmtTime(item.time || item.timestamp)
  const msgIds    = Array.isArray(item.msgIds)
    ? item.msgIds.join(", ")
    : (item.messageId ? String(item.messageId) : null)
  const colorCls  = COLOR_CLASSES[meta.color]

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      <div className="relative rounded-xl p-3 border border-border/30 bg-secondary/10 select-none">

        {/* Status icon */}
        <div className="absolute top-2 right-2">
          {item.worked !== false
            ? <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            : <X           className="h-3.5 w-3.5 text-destructive/50" />
          }
        </div>

        {/* Index + badge row */}
        <div className="flex items-center gap-1.5 mb-1">
          <p className="text-[9px] text-muted-foreground/25 font-mono">#{index}</p>
          <span className={cn("inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-md", colorCls)}>
            <Icon className="h-2.5 w-2.5" />
            {meta.label}
          </span>
        </div>

        {/* Account name */}
        <p className="text-sm font-semibold truncate mb-1 leading-tight pr-5">
          {item.client || item.clientName || "Unknown"}
        </p>

        {/* Tags row */}
        <div className="flex items-center gap-1 flex-wrap">
          {msgIds && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-mono">{msgIds}</span>
          )}
          {(item.reasonLabel || item.reason) && eventType === "report" && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-medium">
              {item.reasonLabel || item.reason}
            </span>
          )}
        </div>

        {/* Full error/response text — the WHOLE thing, wrapped, never truncated */}
        {item.error && (
          <p className={cn(
            "text-[10px] mt-1 leading-snug whitespace-pre-wrap break-words",
            item.worked === false ? "text-destructive/70" : "text-muted-foreground/60"
          )}>
            {item.error}
          </p>
        )}

        {timeStr && (
          <p className="text-[9px] text-muted-foreground/40 font-mono mt-1 tabular-nums">{timeStr}</p>
        )}
      </div>
    </motion.div>
  )
}

export function LiveNotificationList({ logs }) {
  const items = [...logs].reverse()

  if (!items.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 gap-2">
        <Radio className="h-5 w-5 text-muted-foreground/20" />
        <p className="text-xs text-muted-foreground/40">No events yet</p>
      </div>
    )
  }

  const total = items.length

  return (
    <ScrollArea className="flex-1">
      <div className="p-2.5 space-y-1.5">
        <AnimatePresence initial={false}>
          {items.map((item, i) => (
            <EventRow key={item.time || item.timestamp || i} item={item} index={total - i} />
          ))}
        </AnimatePresence>
      </div>
    </ScrollArea>
  )
}
