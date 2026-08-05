export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"
import { validateRequest } from "@/lib/auth"
import { PREVIEW_MOCK, mockEmails } from "@/lib/previewMock"

const FROM = process.env.EMAIL_FROM || "report@abusenotifications.org"

const normSubject = (s) => String(s || "").replace(/^((re|fwd|fw)\s*:\s*)+/i, "").trim().toLowerCase()
const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()))

// GET — the shared mailbox (all stored emails, newest activity first)
export async function GET(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (PREVIEW_MOCK) return NextResponse.json({ emails: mockEmails(), from: FROM })

  const db = await getDb()
  const emails = await db.collection("emails")
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: 1 })
    .limit(1000)
    .toArray()

  return NextResponse.json({ emails, from: FROM })
}

// POST — send an email via Resend (HTTP API)
export async function POST(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Email not configured — set RESEND_API_KEY on the server." }, { status: 503 })
  }

  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }) }

  const to      = body.to
  const subject = (body.subject || "").trim()
  const html    = body.html || ""
  const text    = body.text || ""
  if (!to || (Array.isArray(to) && !to.length)) return NextResponse.json({ error: "Recipient required" }, { status: 400 })
  if (!subject) return NextResponse.json({ error: "Subject required" }, { status: 400 })
  if (!html && !text) return NextResponse.json({ error: "Body required" }, { status: 400 })

  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter(a => a?.filename && a?.content).map(a => ({ filename: a.filename, content: a.content }))
    : []

  const payload = {
    from: FROM, to, subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(body.replyTo ? { reply_to: body.replyTo } : {}),
    ...(body.cc ? { cc: body.cc } : {}),
    ...(attachments.length ? { attachments } : {}),
  }

  let resendId = null
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify(payload),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return NextResponse.json({ error: d?.message || d?.error || "Resend rejected the email" }, { status: r.status })
    resendId = d.id || null
  } catch (e) {
    return NextResponse.json({ error: e.message || "Network error sending email" }, { status: 502 })
  }

  const db = await getDb()
  // Thread ONLY when this is an explicit reply (threadId passed). A brand-new
  // compose always starts its own thread — two separate sends are two entries,
  // even with the same subject. (Inbound replies still chain by subject.)
  const threadId = body.threadId || uid()

  const doc = {
    id: uid(), threadId, direction: "outbound",
    from: FROM, to: Array.isArray(to) ? to : [to], subject, normSubject: normSubject(subject),
    html, text, resendId, owner: auth.user.username, status: "sent",
    attachments: attachments.map(a => ({ filename: a.filename })),
    createdAt: new Date(),
  }
  await db.collection("emails").insertOne({ ...doc })
  return NextResponse.json({ ok: true, email: doc })
}

// DELETE — remove a single message (?id=) or a whole conversation (?threadId=)
export async function DELETE(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  const threadId = searchParams.get("threadId")
  if (!id && !threadId) return NextResponse.json({ error: "id or threadId required" }, { status: 400 })

  const db = await getDb()
  const res = threadId
    ? await db.collection("emails").deleteMany({ threadId })
    : await db.collection("emails").deleteOne({ id })
  return NextResponse.json({ ok: true, deleted: res.deletedCount ?? 0 })
}
