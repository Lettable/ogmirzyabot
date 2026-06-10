"use client"

import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CheckCircle2, X } from "lucide-react"
import { cn } from "@/lib/utils"

function fmtTime(ts) {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d)) return null
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function LiveNotificationList({ logs, reportMeta }) {
  const items = [...logs]
    .filter(l => l.type === "reportProgress")
    .reverse()

  const isMsg        = reportMeta?.type === "public" || reportMeta?.type === "private"
  const total        = logs.filter(l => l.type === "reportProgress").length

  if (!items.length) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <p className="text-xs text-muted-foreground">No activity yet</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-2.5 space-y-1.5">
        <AnimatePresence initial={false}>
          {items.map((item, i) => {
            const index    = total - i
            const timeStr  = fmtTime(item.time || item.timestamp)
            const msgIds   = Array.isArray(item.msgIds)
              ? item.msgIds.join(", ")
              : (item.messageId ? String(item.messageId) : null)

            return (
              <motion.div
                key={item.time || item.timestamp || i}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              >
                {/* Same shape as session card — plain border, no color tint */}
                <div className="relative rounded-xl p-3 border border-border/30 bg-secondary/10 select-none">

                  {/* Top-right: check or X — mirrors session selected indicator */}
                  <div className="absolute top-2 right-2">
                    {item.worked
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/60" />
                      : <X           className="h-3.5 w-3.5 text-destructive/50" />
                    }
                  </div>

                  {/* Index line — same tiny mono as session #index */}
                  <p className="text-[9px] text-muted-foreground/25 mb-1 font-mono">#{index}</p>

                  {/* Account name — same weight/size as session name */}
                  <p className="text-sm font-semibold truncate mb-1 leading-tight pr-5">
                    {item.client || item.clientName || "Unknown"}
                  </p>

                  {/* Tags row — mirrors session country/DC tags */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {isMsg && msgIds && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-mono">
                        {msgIds}
                      </span>
                    )}
                    {(item.reasonLabel || item.reason) && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-border/30 text-muted-foreground font-medium">
                        {item.reasonLabel || item.reason}
                      </span>
                    )}
                    {!item.worked && item.error && (
                      <span className="text-[9px] text-destructive/60 truncate max-w-[110px]" title={item.error}>
                        {item.error}
                      </span>
                    )}
                  </div>

                  {/* Time — same faint mono as session phone */}
                  {timeStr && (
                    <p className="text-[9px] text-muted-foreground/40 font-mono mt-1 tabular-nums">{timeStr}</p>
                  )}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ScrollArea>
  )
}
