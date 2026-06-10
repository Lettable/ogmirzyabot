"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState("")

  const handleLogin = async (e) => {
    e.preventDefault()
    setError("")
    const fd = new FormData(e.target)
    setLoading(true)
    try {
      const res  = await fetch("/api/auth/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: fd.get("username"), password: fd.get("password") }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Invalid credentials"); return }
      localStorage.setItem("token",        data.token)
      localStorage.setItem("username",     data.username)
      localStorage.setItem("isAdmin",      data.isAdmin      ? "1" : "0")
      localStorage.setItem("isAuthorized", data.isAuthorized ? "1" : "0")
      document.cookie = `token=${data.token}; path=/; max-age=604800; SameSite=Strict`
      window.location.href = "/dashboard"
    } catch { setError("Network error") }
    finally  { setLoading(false) }
  }

  return (
    <div className="h-full flex items-center justify-center bg-background">
      <div className="w-full max-w-[340px] px-6">

        {/* Brand */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Mirza</h1>
          <p className="text-sm text-muted-foreground mt-1">t.me/mirzyave</p>
        </div>

        {/* Form */}
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input id="username" name="username" placeholder="Enter username"
              autoComplete="username" autoFocus required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" placeholder="Enter password"
              autoComplete="current-password" required />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign In
          </Button>
        </form>

      </div>
    </div>
  )
}
