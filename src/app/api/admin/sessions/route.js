export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest } from "@/lib/auth"
import { ObjectId } from "mongodb"

async function requireAdmin(request) {
  const result = await validateRequest(request)
  if (!result.valid) return { error: result.error, status: result.status }
  if (!result.user.isAdmin) return { error: "Admin only", status: 403 }
  return { user: result.user }
}

// GET /api/admin/sessions
export async function GET(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = await getDb()
  const sessions = await db.collection("sessions")
    .find({}, { projection: { sessionString: 0 } })
    .sort({ index: 1 })
    .toArray()

  return NextResponse.json({ sessions })
}

// POST /api/admin/sessions — store validated session after bot confirms
export async function POST(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json()
  const { index, sessionString, name, country, dcId, phone, premium, emojiStatus, hasPhoto, photoUrl } = body

  if (index === undefined || !sessionString) {
    return NextResponse.json({ error: "index and sessionString required" }, { status: 400 })
  }

  const db = await getDb()

  // Ensure index is unique
  const existing = await db.collection("sessions").findOne({ index })
  if (existing) {
    return NextResponse.json({ error: `Index ${index} already in use` }, { status: 409 })
  }

  await db.collection("sessions").insertOne({
    index,
    sessionString,
    name: name || `session_${index}`,
    country: country || null,
    dcId: dcId || null,
    phone: phone || null,
    premium: premium || false,
    emojiStatus: emojiStatus || null,
    hasPhoto: hasPhoto || false,
    photoUrl: photoUrl || null,
    isValid: true,
    addedAt: new Date(),
    addedBy: auth.user.username,
  })

  return NextResponse.json({ success: true })
}

// PATCH /api/admin/sessions — edit name or index
export async function PATCH(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id, name, index } = await request.json()
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const db = await getDb()
  const update = {}
  if (name !== undefined) update.name = name
  if (index !== undefined) {
    const conflict = await db.collection("sessions").findOne({ index, _id: { $ne: new ObjectId(id) } })
    if (conflict) return NextResponse.json({ error: `Index ${index} already in use` }, { status: 409 })
    update.index = index
  }

  await db.collection("sessions").updateOne({ _id: new ObjectId(id) }, { $set: update })
  return NextResponse.json({ success: true })
}

// DELETE /api/admin/sessions?id=xxx
export async function DELETE(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const db = await getDb()
  await db.collection("sessions").deleteOne({ _id: new ObjectId(id) })
  return NextResponse.json({ success: true })
}
