export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest, terminateUserTokens } from "@/lib/auth"
import { ObjectId } from "mongodb"

async function requireAdmin(request) {
  const result = await validateRequest(request)
  if (!result.valid) return { error: result.error, status: result.status }
  if (!result.user.isAdmin) return { error: "Admin only", status: 403 }
  return { user: result.user }
}

// GET /api/admin/users — list all users
export async function GET(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = await getDb()
  const users = await db.collection("users")
    .find({}, { projection: { password: 0 } })
    .sort({ addedAt: -1 })
    .toArray()

  return NextResponse.json({ users })
}

// POST /api/admin/users — create user
export async function POST(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { username, password, expireAt, perks } = await request.json()
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 })
  }

  const db = await getDb()
  const existing = await db.collection("users").findOne({ username })
  if (existing) return NextResponse.json({ error: "Username already taken" }, { status: 409 })

  await db.collection("users").insertOne({
    username,
    password,
    addedAt: new Date(),
    expireAt: expireAt ? new Date(expireAt) : null,
    isAuthorized: true,
    isTerminated: false,
    perks: Array.isArray(perks) ? perks : [],   // exactly the features the admin granted
  })

  return NextResponse.json({ success: true })
}

// PATCH /api/admin/users — authorize or terminate user
export async function PATCH(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { username, action, expireAt, perks } = await request.json()
  if (!username || !action) return NextResponse.json({ error: "username and action required" }, { status: 400 })

  const db = await getDb()

  if (action === "setPerks") {
    if (!Array.isArray(perks)) return NextResponse.json({ error: "perks array required" }, { status: 400 })
    await db.collection("users").updateOne({ username }, { $set: { perks } })
    await terminateUserTokens(username)   // force re-login so the new perks take effect in the JWT
    return NextResponse.json({ success: true })
  }

  if (action === "authorize") {
    await db.collection("users").updateOne(
      { username },
      { $set: { isAuthorized: true, isTerminated: false, expireAt: expireAt ? new Date(expireAt) : null } }
    )
    return NextResponse.json({ success: true })
  }

  if (action === "terminate") {
    await db.collection("users").updateOne(
      { username },
      { $set: { isTerminated: true, isAuthorized: false } }
    )
    await terminateUserTokens(username)
    return NextResponse.json({ success: true })
  }

  if (action === "revoke") {
    await db.collection("users").updateOne(
      { username },
      { $set: { isAuthorized: false } }
    )
    await terminateUserTokens(username)
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}

// DELETE /api/admin/users?username=xxx — delete user
export async function DELETE(request) {
  const auth = await requireAdmin(request)
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const username = searchParams.get("username")
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 })

  const db = await getDb()
  await terminateUserTokens(username)
  await db.collection("users").deleteOne({ username })

  return NextResponse.json({ success: true })
}
