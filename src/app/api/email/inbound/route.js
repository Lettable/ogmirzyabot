export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import crypto from "crypto"
import { getDb } from "@/lib/mongodb"

const normSubject = (s) => String(s || "").replace(/^((re|fwd|fw)\s*:\s*)+/i, "").trim().toLowerCase()
const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()))

// Coerce a Resend address (string | {email,name} | array) into a plain string
const asAddr = (v) => {
  if (v == null) return ""
  if (Array.isArray(v)) return v.map(asAddr).filter(Boolean).join(", ")
  if (typeof v === "object") return v.email || v.address || v.value || ""
  return String(v)
}

// Verify the Svix signature Resend sends. Returns true | false | "unconfigured".
function verifySvix(raw, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return "unconfigured"
  try {
    const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sigHeader = headers.get("svix-signature")
    if (!id || !ts || !sigHeader) return false
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
    const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")
    return sigHeader.split(" ").some(part => {
      const sig = part.includes(",") ? part.split(",")[1] : part
      try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) } catch { return false }
    })
  } catch { return false }
}

// Health check — hit https://.../api/email/inbound in a browser to confirm it's deployed
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "email inbound webhook",
    secretConfigured: !!process.env.RESEND_WEBHOOK_SECRET,
    resendKeyConfigured: !!process.env.RESEND_API_KEY,
  })
}

export async function POST(request) {
  const raw = await request.text()
  const verified = verifySvix(raw, request.headers)
  // Non-fatal: if a secret is set but the signature doesn't match, we log and
  // still store (so inbound never silently disappears) — the message is tagged
  // with verified:false so you can tell. Set RESEND_WEBHOOK_SECRET correctly to
  // get verified:true.
  if (verified === false) console.warn("[inbound] signature did not verify — storing anyway (check RESEND_WEBHOOK_SECRET)")

  let event
  try { event = JSON.parse(raw) } catch { return NextResponse.json({ ok: true }) }

  const type = event?.type || ""
  const data = event?.data || event || {}
  // Accept anything that looks like an inbound email (Resend uses "email.received")
  const looksInbound = /received|inbound/i.test(type) || !!(data.email_id || data.from)
  if (!looksInbound) {
    console.log(`[inbound] ignoring event type=${type}`)
    return NextResponse.json({ ok: true })
  }

  const emailId = data.email_id || data.id || null

  // The webhook is metadata-only — fetch the full body if we can
  let bodyDoc = {}
  if (emailId && process.env.RESEND_API_KEY) {
    for (const url of [
      `https://api.resend.com/emails/receiving/${emailId}`,
      `https://api.resend.com/emails/inbound/${emailId}`,
    ]) {
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } })
        if (r.ok) { bodyDoc = await r.json(); break }
      } catch {}
    }
  }

  const subject = bodyDoc.subject || data.subject || "(no subject)"
  const from    = asAddr(bodyDoc.from || data.from) || "unknown"
  const to      = asAddr(bodyDoc.to   || data.to)
  const html    = bodyDoc.html || data.html || ""
  const text    = bodyDoc.text || data.text || ""
  const ns      = normSubject(subject)

  try {
    const db = await getDb()
    if (emailId) {
      const dup = await db.collection("emails").findOne({ resendId: emailId, direction: "inbound" })
      if (dup) return NextResponse.json({ ok: true, duplicate: true })
    }
    const existing = ns ? await db.collection("emails").find({ normSubject: ns }).sort({ createdAt: -1 }).limit(1).toArray() : []
    const threadId = existing[0]?.threadId || uid()

    await db.collection("emails").insertOne({
      id: uid(), threadId, direction: "inbound",
      from, to: to ? [to] : [], subject, normSubject: ns,
      html, text, resendId: emailId, status: "received", verified: verified === true,
      attachments: Array.isArray(data.attachments) ? data.attachments.map(a => ({ filename: a.filename || a.name })) : [],
      createdAt: event.created_at ? new Date(event.created_at) : new Date(),
    })
    console.log(`[inbound] stored email from ${from} subj="${subject}" (verified=${verified})`)
  } catch (e) {
    console.error("[inbound] store failed:", e?.message)
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
