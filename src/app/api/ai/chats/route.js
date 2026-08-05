export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest } from "@/lib/auth"

// Per-user AI chat tabs, persisted in the "aichats" collection.
// A "chat" doc: { id, owner, title, sessionIndex, sessionName, messages, createdAt, updatedAt }

export async function GET(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = await getDb()
  const chats = await db.collection("aichats")
    .find({ owner: auth.user.username }, { projection: { _id: 0 } })
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray()

  return NextResponse.json({ chats })
}

export async function POST(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }) }
  const { id, title, sessionIndex, sessionName, messages } = body
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const db = await getDb()
  const now = new Date()
  await db.collection("aichats").updateOne(
    { id, owner: auth.user.username },
    {
      $set: {
        title:        title || "New chat",
        sessionIndex: sessionIndex ?? null,
        sessionName:  sessionName  ?? null,
        messages:     Array.isArray(messages) ? messages : [],
        updatedAt:    now,
      },
      $setOnInsert: { id, owner: auth.user.username, createdAt: now },
    },
    { upsert: true },
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const db = await getDb()
  await db.collection("aichats").deleteOne({ id, owner: auth.user.username })
  return NextResponse.json({ ok: true })
}
