import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { signToken, storeToken } from "@/lib/auth"

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

    const token = await signToken({ username, isAdmin: false, isAuthorized: user.isAuthorized })
    await storeToken(username, false, token)

    return NextResponse.json({ token, isAdmin: false, isAuthorized: user.isAuthorized, username })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
