"use client"
import { useState, useEffect, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Loader2, Upload, CheckCircle2, FileText, X, AlertCircle, Files, Folder } from "lucide-react"

// ─── OTP Input ────────────────────────────────────────────────────────────────

function OtpInput({ value, onChange, disabled, onComplete, length = 5 }) {
  const refs = useRef([])

  const handleChange = (i, e) => {
    const digit = e.target.value.replace(/\D/g, "").slice(-1)
    const chars = value.split("")
    chars[i] = digit
    const next = chars.join("").slice(0, length)
    onChange(next)
    if (digit && i < length - 1) refs.current[i + 1]?.focus()
    if (digit && i === length - 1) onComplete?.()
  }

  const handleKeyDown = (i, e) => {
    if (e.key === "Backspace") {
      if (value[i]) {
        const chars = value.split("")
        chars[i] = ""
        onChange(chars.join(""))
      } else if (i > 0) {
        refs.current[i - 1]?.focus()
      }
    }
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus()
    if (e.key === "ArrowRight" && i < length - 1) refs.current[i + 1]?.focus()
  }

  const handlePaste = (e) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length)
    onChange(pasted)
    const focusIdx = Math.min(pasted.length, length - 1)
    refs.current[focusIdx]?.focus()
    if (pasted.length === length) onComplete?.()
  }

  const handleFocus = (i) => {
    // If clicking an empty slot but there are filled slots before it, jump to first empty
    const firstEmpty = value.length < length ? value.length : length - 1
    if (i > firstEmpty) refs.current[firstEmpty]?.focus()
  }

  return (
    <div className="grid gap-2 w-full" style={{ gridTemplateColumns: `repeat(${length}, 1fr)` }}>
      {Array.from({ length }).map((_, i) => {
        const filled = !!value[i]
        return (
          <input
            key={i}
            ref={el => refs.current[i] = el}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={value[i] || ""}
            onChange={e => handleChange(i, e)}
            onKeyDown={e => handleKeyDown(i, e)}
            onPaste={handlePaste}
            onFocus={() => handleFocus(i)}
            disabled={disabled}
            className={cn(
              "w-full h-12 rounded-xl border text-center text-xl font-bold tabular-nums",
              "bg-secondary/30 transition-all duration-150 outline-none select-none",
              filled
                ? "border-primary/40 text-foreground bg-secondary/60"
                : "border-border/40 text-muted-foreground",
              "focus:border-primary/60 focus:bg-secondary/70 focus:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.4)]",
              disabled && "opacity-40 cursor-not-allowed"
            )}
          />
        )
      })}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AddSessionDialog({ open, onClose, onSaved, wsRef, availableIndexes }) {
  const [tab, setTab]                     = useState("string")

  // String / file
  const [sessionString, setSessionString] = useState("")
  const [fileData, setFileData]           = useState(null)
  const [fileName, setFileName]           = useState("")

  // Phone flow
  const [phone, setPhone]                 = useState("")
  const [otp, setOtp]                     = useState("")
  const [twoFa, setTwoFa]                 = useState("")
  const [phoneCodeHash, setPhoneCodeHash] = useState(null)
  const [otpSent, setOtpSent]             = useState(false)
  const [tfaRequired, setTfaRequired]     = useState(false)

  // Bulk upload
  const [batchFiles, setBatchFiles]       = useState([])   // [{name, data}]
  const [batchRunning, setBatchRunning]   = useState(false)
  const [batchProgress, setBatchProgress] = useState([])   // [{name, ok, error, index}]
  const [batchSummary, setBatchSummary]   = useState(null) // {added, failed, total}

  // Shared
  const [loading, setLoading]             = useState(false)
  const [validated, setValidated]         = useState(null)
  const [saving, setSaving]               = useState(false)
  const [err, setErr]                     = useState("")

  const nextIndex = availableIndexes?.length ? Math.max(...availableIndexes) + 1 : 1

  // ─── WS listener ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!wsRef?.current) return
    const prev = wsRef.current.onmessage
    wsRef.current.onmessage = (event) => {
      if (prev) prev(event)
      let msg; try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === "sessionResult") {
        setLoading(false)
        if (msg.valid) { setValidated(msg); setErr("") }
        else setErr(msg.error || "Session invalid")
      }
      if (msg.type === "codeRequested") {
        setLoading(false); setPhoneCodeHash(msg.phoneCodeHash); setOtpSent(true); setErr("")
      }
      if (msg.type === "tfaRequired") {
        setLoading(false); setTfaRequired(true); setErr("")
      }
      if (msg.type === "batchSessionProgress") {
        setBatchProgress(p => [...p, msg])
      }
      if (msg.type === "batchSessionComplete") {
        setBatchRunning(false)
        setBatchSummary({ added: msg.added, failed: msg.failed, total: msg.total })
        if (msg.added > 0) onSaved?.()
      }
    }
    return () => { if (wsRef.current) wsRef.current.onmessage = prev }
  }, [wsRef, open])

  const reset = () => {
    setTab("string"); setSessionString(""); setFileData(null); setFileName("")
    setPhone(""); setOtp(""); setTwoFa(""); setPhoneCodeHash(null)
    setOtpSent(false); setTfaRequired(false)
    setLoading(false); setValidated(null); setSaving(false); setErr("")
    setBatchFiles([]); setBatchRunning(false); setBatchProgress([]); setBatchSummary(null)
  }

  const sendWs = (data) => {
    if (wsRef?.current?.readyState === WebSocket.OPEN) { wsRef.current.send(JSON.stringify(data)); return true }
    setErr("Not connected to server"); return false
  }

  // ─── Actions ───────────────────────────────────────────────────────────────
  const handleStringSubmit = () => {
    const str = fileData || sessionString.trim()
    if (!str) { setErr("Paste a session string or upload a .session file"); return }
    setErr(""); setLoading(true)
    sendWs({ type: "addSession", sessionString: str, method: fileData ? "file" : "string" })
  }

  const handleSendCode = () => {
    if (!phone.trim()) { setErr("Enter your phone number"); return }
    setErr(""); setLoading(true)
    sendWs({ type: "sendCode", phone: phone.trim() })
  }

  const handleConfirmCode = () => {
    if (otp.length < 5) { setErr("Enter the 5-digit code"); return }
    setErr(""); setLoading(true)
    sendWs({ type: "confirmCode", phone: phone.trim(), code: otp, phoneCodeHash })
  }

  const handleSubmit2fa = () => {
    if (!twoFa.trim()) { setErr("Enter your cloud password"); return }
    setErr(""); setLoading(true)
    sendWs({ type: "submit2fa", password: twoFa.trim() })
  }

  const handleSave = async () => {
    setSaving(true); setErr("")
    try {
      const r = await fetch("/api/admin/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
        body: JSON.stringify({
          index: nextIndex, sessionString: validated.sessionString,
          name: validated.name, country: validated.country,
          dcId: validated.dcId, phone: validated.phone, premium: validated.premium,
        }),
      })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || "Save failed"); return }
      onSaved?.(); onClose?.(); reset()
    } catch { setErr("Network error") }
    finally { setSaving(false) }
  }

  const handleFileInput = (file) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      // chunked conversion avoids call-stack limits on bigger .session files
      const bytes = new Uint8Array(e.target.result)
      let binary = ""
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      }
      setFileData(btoa(binary)); setFileName(file.name); setSessionString("[file]")
    }
    reader.readAsArrayBuffer(file)
  }

  // ─── Bulk ────────────────────────────────────────────────────────────────
  const readFileB64 = (file) => new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      // chunked conversion avoids call-stack limits on bigger files
      const bytes = new Uint8Array(e.target.result)
      let binary = ""
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      }
      resolve({ name: file.name, data: btoa(binary) })
    }
    reader.onerror = () => resolve(null)
    reader.readAsArrayBuffer(file)
  })

  const handleBatchSelect = async (fileList) => {
    setErr(""); setBatchSummary(null); setBatchProgress([])
    const sessionFiles = Array.from(fileList || []).filter(f => f.name.toLowerCase().endsWith(".session"))
    if (!sessionFiles.length) { setErr("No .session files found in that selection"); return }
    const encoded = (await Promise.all(sessionFiles.map(readFileB64))).filter(Boolean)
    setBatchFiles(encoded)
  }

  const handleBatchRun = () => {
    if (!batchFiles.length) { setErr("Select .session files or a folder first"); return }
    setErr(""); setBatchProgress([]); setBatchSummary(null); setBatchRunning(true)
    sendWs({ type: "addSessionBatch", files: batchFiles })
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={() => { onClose?.(); reset() }}>
      <DialogContent className="max-w-sm w-[calc(100%-1.5rem)] max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Account</DialogTitle>
          <DialogDescription className="text-xs">
            Connect via session string, .session file, or phone number.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-1">

          {/* Error */}
          {err && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5">
              <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive leading-snug">{err}</p>
            </div>
          )}

          {/* ── Validated account card ── */}
          {validated ? (
            <>
              <Card className="border-success/30 bg-success/10">
                <CardContent className="px-4 py-3.5">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                    <span className="text-sm font-semibold text-success">Account verified</span>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      ["Name",    validated.name],
                      ["Phone",   validated.phone ? `+${validated.phone}` : null],
                      ["Premium", validated.premium ? "Yes" : "No"],
                      ["DC",      validated.dcId ? `DC ${validated.dcId}` : null],
                    ].filter(([, v]) => v != null).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="font-medium">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-border/30">
                    <p className="text-[11px] text-muted-foreground">
                      Will be saved as <span className="font-semibold text-foreground">Index #{nextIndex}</span>
                    </p>
                  </div>
                </CardContent>
              </Card>

              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1"
                  onClick={() => { setValidated(null); setErr(""); setOtp(""); setTwoFa(""); setTfaRequired(false); setOtpSent(false) }}>
                  Try another
                </Button>
                <Button className="flex-[2]" onClick={handleSave} disabled={saving}>
                  {saving
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
                    : <><CheckCircle2 className="h-4 w-4" /> Save Account</>}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* ── Method tabs ── */}
              <div className="flex gap-1 p-1 rounded-lg bg-secondary/50 border border-border/30">
                {[["string", "Session"], ["phone", "Phone"], ["bulk", "Bulk"]].map(([v, l]) => (
                  <button key={v} onClick={() => { setTab(v); setErr("") }}
                    className={cn(
                      "flex-1 py-1.5 rounded-md text-sm font-medium transition-all duration-150",
                      tab === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}>
                    {l}
                  </button>
                ))}
              </div>

              {/* ── Loading ── */}
              {loading ? (
                <div className="flex flex-col items-center gap-2.5 py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {!otpSent ? (tab === "phone" ? "Sending code…" : "Validating session…") : "Verifying…"}
                  </p>
                </div>

              ) : tab === "string" ? (
                /* ── String / File ── */
                <div className="space-y-3">
                  <Input
                    value={fileData ? "" : sessionString}
                    onChange={e => { setSessionString(e.target.value); setFileData(null); setFileName("") }}
                    placeholder="Paste Telethon StringSession here…"
                    className="font-mono text-xs"
                    disabled={!!fileData}
                  />

                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-px bg-border/30" />
                    <span className="text-[10px] text-muted-foreground/50 shrink-0">or upload a file</span>
                    <div className="flex-1 h-px bg-border/30" />
                  </div>

                  {fileData ? (
                    <div className="flex items-center gap-2.5 rounded-lg bg-secondary/50 border border-border px-3 py-2.5">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{fileName}</span>
                      <button onClick={() => { setFileData(null); setFileName(""); setSessionString("") }}
                        className="text-muted-foreground hover:text-foreground transition-colors">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.name.endsWith(".session")) handleFileInput(f) }}
                      onClick={() => document.getElementById("add-session-file")?.click()}
                      className="rounded-lg border border-dashed border-border/40 hover:border-border/80 hover:bg-secondary/20 transition-all duration-150 py-5 flex flex-col items-center gap-1.5 cursor-pointer"
                    >
                      <Upload className="h-4 w-4 text-muted-foreground/40" />
                      <p className="text-xs text-muted-foreground/60">Drop .session file or <span className="underline underline-offset-2">browse</span></p>
                      <input id="add-session-file" type="file" accept=".session" className="hidden"
                        onChange={e => { if (e.target.files[0]) handleFileInput(e.target.files[0]) }} />
                    </div>
                  )}

                  <Button className="w-full" onClick={handleStringSubmit} disabled={!sessionString.trim() && !fileData}>
                    Validate Session
                  </Button>
                </div>

              ) : tab === "bulk" ? (
                /* ── Bulk: multiple .session files or a whole folder ── */
                <div className="space-y-3">
                  {!batchRunning && !batchSummary && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => document.getElementById("bulk-files")?.click()}
                          className="rounded-lg border border-dashed border-border/40 hover:border-border/80 hover:bg-secondary/20 transition-all py-5 flex flex-col items-center gap-1.5"
                        >
                          <Files className="h-5 w-5 text-muted-foreground/50" />
                          <p className="text-xs text-muted-foreground/70 font-medium">Select files</p>
                          <p className="text-[10px] text-muted-foreground/40">.session ×N</p>
                        </button>
                        <button
                          onClick={() => document.getElementById("bulk-folder")?.click()}
                          className="rounded-lg border border-dashed border-border/40 hover:border-border/80 hover:bg-secondary/20 transition-all py-5 flex flex-col items-center gap-1.5"
                        >
                          <Folder className="h-5 w-5 text-muted-foreground/50" />
                          <p className="text-xs text-muted-foreground/70 font-medium">Select folder</p>
                          <p className="text-[10px] text-muted-foreground/40">all .session inside</p>
                        </button>
                      </div>
                      <input id="bulk-files" type="file" accept=".session" multiple className="hidden"
                        onChange={e => handleBatchSelect(e.target.files)} />
                      <input id="bulk-folder" type="file" className="hidden" webkitdirectory="" directory=""
                        onChange={e => handleBatchSelect(e.target.files)} />

                      {batchFiles.length > 0 && (
                        <div className="rounded-lg bg-secondary/40 border border-border/40 px-3 py-2.5 flex items-center gap-2.5">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm flex-1">{batchFiles.length} .session file{batchFiles.length !== 1 ? "s" : ""} ready</span>
                          <button onClick={() => setBatchFiles([])} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      )}

                      <Button className="w-full" onClick={handleBatchRun} disabled={!batchFiles.length}>
                        <Upload className="h-4 w-4" /> Add {batchFiles.length || ""} Account{batchFiles.length !== 1 ? "s" : ""}
                      </Button>
                    </>
                  )}

                  {(batchRunning || batchSummary) && (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {batchRunning
                            ? <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding… {batchProgress.length}/{batchFiles.length}</span>
                            : `Done — ${batchSummary.added} added, ${batchSummary.failed} failed`}
                        </span>
                      </div>
                      <div className="max-h-52 overflow-y-auto space-y-1 pr-0.5">
                        {batchProgress.map((p, i) => (
                          <div key={i} className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px] border",
                            p.ok ? "bg-success/10 border-success/30" : "bg-destructive/10 border-destructive/30"
                          )}>
                            {p.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" /> : <X className="h-3.5 w-3.5 text-destructive shrink-0" />}
                            <span className="flex-1 truncate">{p.accountName || p.name}</span>
                            {p.ok ? <span className="text-muted-foreground/60">#{p.index}</span>
                                  : <span className="text-destructive truncate max-w-[90px]" title={p.error}>{p.error}</span>}
                          </div>
                        ))}
                      </div>
                      {batchSummary && (
                        <Button variant="outline" className="w-full" onClick={() => { setBatchFiles([]); setBatchProgress([]); setBatchSummary(null) }}>
                          Add more
                        </Button>
                      )}
                    </div>
                  )}
                </div>

              ) : (
                /* ── Phone → OTP → 2FA ── */
                <div className="space-y-3">

                  {/* Phone */}
                  <div>
                    <Label>Phone number</Label>
                    <Input
                      value={phone}
                      onChange={e => setPhone(e.target.value)}
                      placeholder="+1 234 567 8900"
                      disabled={otpSent}
                      onKeyDown={e => !otpSent && e.key === "Enter" && handleSendCode()}
                    />
                  </div>

                  {/* OTP boxes */}
                  {otpSent && !tfaRequired && (
                    <div>
                      <div className="mb-3">
                        <OtpInput
                          value={otp}
                          onChange={setOtp}
                          disabled={false}
                          onComplete={handleConfirmCode}
                          length={5}
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground">Code sent to {phone}</p>
                    </div>
                  )}

                  {/* 2FA */}
                  {tfaRequired && (
                    <div>
                      <Label>Cloud password</Label>
                      <Input
                        type="password"
                        value={twoFa}
                        onChange={e => setTwoFa(e.target.value)}
                        placeholder="Two-step verification password"
                        autoFocus
                        onKeyDown={e => e.key === "Enter" && twoFa.trim() && handleSubmit2fa()}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1.5">2-step verification is enabled on this account</p>
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    {otpSent && (
                      <Button variant="outline" className="flex-1" size="sm"
                        onClick={() => { setOtpSent(false); setOtp(""); setTfaRequired(false); setTwoFa(""); setPhoneCodeHash(null); setErr("") }}>
                        Change number
                      </Button>
                    )}
                    <Button
                      className={otpSent ? "flex-[2]" : "w-full"}
                      onClick={!otpSent ? handleSendCode : tfaRequired ? handleSubmit2fa : handleConfirmCode}
                      disabled={
                        (!otpSent && !phone.trim()) ||
                        (otpSent && !tfaRequired && otp.length < 5) ||
                        (tfaRequired && !twoFa.trim())
                      }
                    >
                      {!otpSent ? "Send code" : tfaRequired ? "Confirm password" : "Verify code"}
                    </Button>
                  </div>

                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
