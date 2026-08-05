export const dynamic = "force-dynamic"
import { NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { validateRequest } from "@/lib/auth"

const MODEL = process.env.AI_MODEL || "claude-opus-4-8"

// Tools the model can call. All are executed CLIENT-SIDE (the browser runs the
// telegram fetch via the bot WS, applies the report config, or loads the email
// draft), so this route never executes them — it just relays tool_use blocks.
const REPORT_TOOLS = [
  {
    name: "fetch_telegram",
    description:
      "Fetch live information and recent messages from a public OR private Telegram group/channel/message using the operator's currently selected Telegram account. " +
      "Use this to read a link the user pasted (t.me/..., joinchat/+hash, or a specific message link like t.me/c/123/456) so you can understand the target before filling the report. " +
      "Call it whenever the user gives a link or refers to content you haven't seen yet.",
    input_schema: {
      type: "object",
      properties: {
        link: { type: "string", description: "The Telegram link or @username to fetch (public or private)." },
        limit: { type: "integer", description: "How many recent messages to fetch (default 25, max 60)." },
      },
      required: ["link"],
    },
  },
  {
    name: "fill_report",
    description:
      "Fill the mass-report form on the operator's dashboard. Do NOT call this until the operator has (a) confirmed your read of the target and (b) told you how many format variations and the amount they want. " +
      "Generate EXACTLY the number of format variations the operator asked for, and select ONLY the few reasons that genuinely apply — never all of them.",
    input_schema: {
      type: "object",
      properties: {
        chatType: {
          type: "string",
          enum: ["public", "private", "userId"],
          description: "public = report messages in a public chat; private = a private chat/invite; userId = report a user account.",
        },
        links: { type: "string", description: "Telegram links or message links to report, comma or newline separated. For message reports include the specific message links." },
        userTarget: { type: "string", description: "Username or numeric id of the user to report (only when chatType is userId)." },
        amount: { type: "integer", description: "Number of reports to send. Use the amount the operator specified." },
        formats: { type: "array", items: { type: "string" }, description: "Report comment variations. Produce EXACTLY the count the operator requested — no more, no fewer." },
        reasonTitles: {
          type: "array",
          items: { type: "string" },
          description: "The 1-3 specific LEAF report options that apply, using the exact leaf names from the reason catalog in the system prompt (e.g. 'Stolen data or credentials', 'Malware, phishing', 'Hate speech or symbols'). NEVER a top category like 'Violence' / 'Personal data' / 'Scam or fraud' — that selects all of its children.",
        },
        summary: { type: "string", description: "One-line plain-English summary of what this report targets and why." },
      },
      required: ["chatType"],
    },
  },
]

const DRAFT_EMAIL = {
  name: "draft_email",
  description:
    "Load a finished abuse-report email into the operator's compose window for review and sending. " +
    "Call this only after you've fetched the target and confirmed the details. Write a professional, factual complaint — " +
    "no threats or exaggeration. Pick the right recipient: abuse@telegram.org (general illegal content), dmca@telegram.org (copyright), stopCA@telegram.org (child-safety).",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient — default abuse@telegram.org; dmca@telegram.org for copyright; stopCA@telegram.org for child-safety." },
      subject: { type: "string", description: "Concise, specific subject line." },
      html: { type: "string", description: "The full email body as clean HTML: state the violation, the exact t.me/@ links, what the content is, the evidence, and a clear request to review/remove. Professional and factual." },
    },
    required: ["to", "subject", "html"],
  },
}
const EMAIL_TOOLS = [REPORT_TOOLS[0], DRAFT_EMAIL]   // fetch_telegram + draft_email

function systemPrompt(session) {
  const who = session?.name ? `"${session.name}" (account #${session.index})` : "the selected account"
  return [
    "You are the in-dashboard assistant for a Telegram mass-reporting tool. You help the operator build a report config through a SHORT CONVERSATION. You must NOT fill the form until the operator confirms.",
    `Fetches use the operator's selected account: ${who}.`,
    "",
    "Follow this flow in order — do not skip ahead:",
    "1. ASSESS. When the operator sends a Telegram link (or content/screenshot), call fetch_telegram to read it with the selected account (works for public AND private links). Analyze any images too.",
    "2. REPORT BACK in plain text: tell the operator what the channel/group/user appears to be and do, and what looks reportable. Then ask them to confirm or correct you. Do NOT call fill_report at this step.",
    "3. WAIT for the operator's confirmation/correction and incorporate it.",
    "4. GATHER SPECIFICS before filling. You must know: how many report-message variations (formats) they want, the amount (number of reports), and which reasons to use. If any is unknown — ESPECIALLY the number of formats — ask for it in plain text. Never guess the format count.",
    "5. FILL only once the target is confirmed and you know the format count + amount + reasons. Call fill_report. Produce EXACTLY the number of format variations requested.",
    "",
    "REASONS — CRITICAL. The form's reason picker is a checkable tree. You must return ONLY the specific lowest-level (leaf) option names — NEVER a top category like 'Violence', 'Personal data', 'Scam or fraud', 'Illegal goods and services', or 'Illegal adult content'. Returning a category checks ALL of its children, which is wrong. Pick the 1-3 leaf options that actually match, using these EXACT names:",
    "",
    "Message/chat reports (chatType public or private) — valid leaf options:",
    "  I don't like it | Child sexual abuse | Child physical abuse |",
    "  (Violence) Insults or false information; Graphic or disturbing content; Extreme violence, dismemberment; Hate speech or symbols; Calling for violence; Organized crime; Terrorism; Animal abuse |",
    "  (Illegal goods/services) Weapons; Drugs; Fake documents; Counterfeit money; Hacking tools and malware; Counterfeit merchandise; Other goods and services |",
    "  (Illegal adult content) Illegal sexual services; Non-consensual sexual imagery; Pornography; Other illegal sexual content |",
    "  (Personal data) Private images; Phone number; Address; Stolen data or credentials; Other personal information |",
    "  (Scam/fraud / Spam) Impersonation; Deceptive or unrealistic financial claims; Malware, phishing; Fraudulent seller, product or service |",
    "  Copyright | It's not illegal, but must be taken down",
    "",
    "User-account reports (chatType userId) — valid options: Child Abuse | Copyright | Fake | Illegal Drugs | Spam | Violence | Other",
    "",
    "Example: a channel selling stolen breach databases → reasonTitles: ['Stolen data or credentials', 'Malware, phishing', 'Deceptive or unrealistic financial claims'] — NOT ['Personal data', 'Scam or fraud'].",
    "",
    "Keep replies concise and ask one question at a time. After filling, briefly state what you set.",
  ].join("\n")
}

function emailSystemPrompt(session) {
  const who = session?.name ? `"${session.name}" (account #${session.index})` : "the selected account"
  return [
    "You help the operator draft a professional abuse-report EMAIL to Telegram's abuse team, then load it into their compose window.",
    `Fetches use the selected account: ${who}.`,
    "",
    "Flow:",
    "1. When the operator gives a link/content, call fetch_telegram to read the target and gather evidence (what it is, the t.me/@ links, message ids, what's posted).",
    "2. Briefly tell the operator what you found and what's reportable; ask them to confirm or add detail. Do NOT draft yet.",
    "3. Once confirmed, call draft_email with a concise, factual complaint addressed to the correct inbox (abuse@telegram.org general; dmca@telegram.org copyright; stopCA@telegram.org child-safety).",
    "",
    "The email must: clearly state the violation, list the exact t.me/@ links, describe the content and evidence, and request review/removal. Professional and factual — never threats, profanity, or exaggeration. Use clean simple HTML (paragraphs, a bulleted list of links). After drafting, tell the operator it's in the compose window to review and send.",
  ].join("\n")
}

export async function POST(request) {
  const auth = await validateRequest(request)
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI is not configured — set ANTHROPIC_API_KEY on the server." }, { status: 503 })
  }

  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }) }

  const messages = Array.isArray(body.messages) ? body.messages : null
  if (!messages || !messages.length) return NextResponse.json({ error: "messages required" }, { status: 400 })

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Lightweight title generation — used to name a chat tab automatically.
  if (body.mode === "title") {
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 24,
        system:
          "You name chat conversations for a Telegram reporting tool. " +
          "Given the conversation so far, reply with ONLY a concise 2-4 word title (Title Case, no quotes, no punctuation at the end) that captures the target or task. " +
          "Examples: 'Crypto Scam Channel', 'Leaked Database Report', 'Spam Bot Group'.",
        messages,
      })
      const text = (resp.content.find(b => b.type === "text")?.text || "").trim()
      const title = text.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 48)
      return NextResponse.json({ title })
    } catch (e) {
      return NextResponse.json({ error: e?.message || "title failed" }, { status: e?.status || 500 })
    }
  }

  const emailMode = body.mode === "email"

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: emailMode ? emailSystemPrompt(body.session) : systemPrompt(body.session),
      tools: emailMode ? EMAIL_TOOLS : REPORT_TOOLS,
      messages,
    })
    return NextResponse.json({
      content: response.content,
      stop_reason: response.stop_reason,
      model: response.model,
      usage: response.usage,
    })
  } catch (e) {
    const status = e?.status || 500
    const msg = e?.error?.error?.message || e?.message || "AI request failed"
    return NextResponse.json({ error: msg }, { status })
  }
}
