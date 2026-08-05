export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"

export async function POST(request) {
  try {
    const { username, password } = await request.json()

    if (!username || !password) {
      return NextResponse.json({ error: "Username and password required" }, { status: 400 })
    }

    if (username.length < 3 || password.length < 6) {
      return NextResponse.json({ error: "Username min 3 chars, password min 6 chars" }, { status: 400 })
    }

    const db = await getDb()

    const existing = await db.collection("users").findOne({ username })
    if (existing) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 })
    }

    const adminExisting = await db.collection("admins").findOne({ username })
    if (adminExisting) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 })
    }

    await db.collection("users").insertOne({
      username,
      password,
      addedAt: new Date(),
      expireAt: null,
      isAuthorized: false,
      isTerminated: false,
    })

    return NextResponse.json({ success: true, message: "Account created. Waiting for admin authorization." })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
