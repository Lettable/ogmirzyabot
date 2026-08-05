import { NextResponse } from "next/server"
import { jwtVerify } from "jose"

const JWT_SECRET = process.env.JWT_SECRET || "changeme_set_in_env"

function getSecret() {
  return new TextEncoder().encode(JWT_SECRET)
}

async function verifyEdgeToken(token) {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    return payload
  } catch {
    return null
  }
}

function getToken(request) {
  // Bearer token from Authorization header
  const authHeader = request.headers.get("authorization") || ""
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7)
  // Cookie fallback (for page routes)
  return request.cookies.get("token")?.value || null
}

export async function middleware(request) {
  const { pathname } = request.nextUrl

  // ── Public — no auth ────────────────────────────────────────────────────────
  if (
    pathname === "/" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/email/inbound") ||  // Resend webhook — verified via Svix signature, not JWT
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next()
  }

  // ── API routes — require valid JWT (full DB check is in each route handler) ─
  if (pathname.startsWith("/api/")) {
    const token = getToken(request)
    if (!token) {
      return NextResponse.json({ error: "No token provided" }, { status: 402 })
    }
    const decoded = await verifyEdgeToken(token)
    if (!decoded) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 402 })
    }
    return NextResponse.next()
  }

  // ── Page routes — redirect to login if no valid token cookie ────────────────
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/admin")) {
    const token = request.cookies.get("token")?.value
    if (!token) {
      return NextResponse.redirect(new URL("/", request.url))
    }
    const decoded = await verifyEdgeToken(token)
    if (!decoded) {
      return NextResponse.redirect(new URL("/", request.url))
    }
    return NextResponse.next()
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/api/:path*", "/dashboard/:path*", "/admin/:path*"],
}
