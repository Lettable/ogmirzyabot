"use client"
import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import { cn } from "@/lib/utils"

function NotificationItem({ children, className, ...props }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -16, height: 0 }}
      animate={{ opacity: 1, x: 0, height: "auto" }}
      exit={{ opacity: 0, x: -16, height: 0 }}
      transition={{
        type: "spring",
        stiffness: 300,
        damping: 30,
        opacity: { duration: 0.15 },
      }}
      className={cn("overflow-hidden", className)}
      {...props}
    >
      <div className="pb-1.5">{children}</div>
    </motion.div>
  )
}

function NotificationList({ items, renderItem, className, emptyState, ...props }) {
  return (
    <div className={cn("flex flex-col", className)} {...props}>
      <AnimatePresence initial={false} mode="popLayout">
        {items && items.length > 0
          ? items.map((item, i) => (
              <NotificationItem key={item.id ?? i}>
                {renderItem(item, i)}
              </NotificationItem>
            ))
          : emptyState && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {emptyState}
              </motion.div>
            )}
      </AnimatePresence>
    </div>
  )
}

export { NotificationList, NotificationItem }
