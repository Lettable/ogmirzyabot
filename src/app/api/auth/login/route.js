export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { signToken, storeToken } from "@/lib/auth"

// All feature keys — legacy users with no `perks` field get full access.
const ALL_PERKS = ["report", "raid", "vc", "join", "profile", "ai", "mail"]

export async function POST(request) {
  try {
    const { username, password } = await request.json()

    if (!username || !password) {
      return NextResponse.json({ error: "Username and password required" }, { status: 400 })
    }

    const db = await getDb()

    // Check admins first
    const admin = await db.collection("admins").findOne({ username, password })
    if (admin) {
      const token = await signToken({ username, isAdmin: true })
      await storeToken(username, true, token)
      return NextResponse.json({ token, isAdmin: true, username })
    }

    // Check users
    const user = await db.collection("users").findOne({ username, password })
    if (!user) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
    }

    if (user.isTerminated) {
      return NextResponse.json({ error: "Account terminated" }, { status: 403 })
    }

    if (user.expireAt && new Date(user.expireAt) < new Date()) {
      return NextResponse.json({ error: "Account expired" }, { status: 403 })
    }

    // Legacy users (no perks field) keep full access; an explicit array (even []) is exact.
    const perks = Array.isArray(user.perks) ? user.perks : ALL_PERKS
    const token = await signToken({ username, isAdmin: false, isAuthorized: user.isAuthorized, perks })
    await storeToken(username, false, token)

    return NextResponse.json({ token, isAdmin: false, isAuthorized: user.isAuthorized, username, perks })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
