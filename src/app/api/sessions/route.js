import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest } from "@/lib/auth"

// GET /api/sessions — list all valid sessions (for report panel)
export async function GET(request) {
  const result = await validateRequest(request)
  if (!result.valid) return NextResponse.json({ error: result.error }, { status: result.status })

  const db = await getDb()
  const sessions = await db.collection("sessions")
    .find({ isValid: true }, { projection: { sessionString: 0 } })
    .sort({ index: 1 })
    .toArray()

  return NextResponse.json({ sessions })
}
