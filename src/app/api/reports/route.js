export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest } from "@/lib/auth"
import { ObjectId } from "mongodb"

// GET /api/reports — list reports (all users see history, filtered by own for non-admin)
export async function GET(request) {
  const result = await validateRequest(request)
  if (!result.valid) return NextResponse.json({ error: result.error }, { status: result.status })

  const { searchParams } = new URL(request.url)
  const hash = searchParams.get("hash")
  const db = await getDb()

  if (hash) {
    const report = await db.collection("reports").findOne({ hash })
    if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ report })
  }

  const query = result.user.isAdmin ? {} : { startedBy: result.user.username }
  const reports = await db.collection("reports")
    .find(query, { projection: { logs: 0 } })
    .sort({ startedAt: -1 })
    .limit(50)
    .toArray()

  return NextResponse.json({ reports })
}

// POST /api/reports — start a report (authorized users + admins only)
export async function POST(request) {
  const result = await validateRequest(request)
  if (!result.valid) return NextResponse.json({ error: result.error }, { status: result.status })

  if (!result.user.isAdmin && !result.user.isAuthorized) {
    return NextResponse.json({ error: "Not authorized to start reports" }, { status: 403 })
  }
  // Reporting perk: admins always; users need "report" (legacy users have no perks
  // claim → null → allowed, matching the login fallback to full access).
  const perks = result.user.perks
  if (!result.user.isAdmin && Array.isArray(perks) && !perks.includes("report")) {
    return NextResponse.json({ error: "You don't have the reporting permission" }, { status: 403 })
  }

  const body = await request.json()
  const { hash, clients, data, formats } = body

  if (!hash || !clients || !data) {
    return NextResponse.json({ error: "hash, clients, data required" }, { status: 400 })
  }

  const db = await getDb()

  // Store report record
  await db.collection("reports").insertOne({
    hash,
    type: data.type,
    target: data.username || data.userId || data.chatId || null,
    messageIds: data.messageIds || [],
    options: data.options || [],
    clients,
    formats: formats || [],
    amount: data.amount,
    delay: data.uniformDelay,
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    startedBy: result.user.username,
    logs: {},
  })

  return NextResponse.json({ success: true, hash })
}

// PATCH /api/reports — update report status/logs (called internally by bot via WS indirectly)
export async function PATCH(request) {
  const result = await validateRequest(request)
  if (!result.valid) return NextResponse.json({ error: result.error }, { status: result.status })
  if (!result.user.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 })

  const { hash, status, logs, completedAt } = await request.json()
  if (!hash) return NextResponse.json({ error: "hash required" }, { status: 400 })

  const db = await getDb()
  const update = {}
  if (status) update.status = status
  if (logs) update.logs = logs
  if (completedAt) update.completedAt = new Date(completedAt)

  await db.collection("reports").updateOne({ hash }, { $set: update })
  return NextResponse.json({ success: true })
}
