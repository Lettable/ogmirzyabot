export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest } from "@/lib/auth"
import { PREVIEW_MOCK, mockSessions } from "@/lib/previewMock"

// GET /api/sessions — list all valid sessions (for report panel)
export async function GET(request) {
  const result = await validateRequest(request)
  if (!result.valid) return NextResponse.json({ error: result.error }, { status: result.status })

  if (PREVIEW_MOCK) return NextResponse.json({ sessions: mockSessions() })

  const db = await getDb()
  const sessions = await db.collection("sessions")
    .find({}, { projection: { sessionString: 0 } })
    .sort({ index: 1 })
    .toArray()

  return NextResponse.json({ sessions })
}
