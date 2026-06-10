import { SignJWT, jwtVerify } from "jose"
import { getDb } from "./mongodb"

const JWT_SECRET = process.env.JWT_SECRET || "changeme_set_in_env"
const TOKEN_EXPIRY_DAYS = 7

function getSecret() {
  return new TextEncoder().encode(JWT_SECRET)
}

export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_EXPIRY_DAYS}d`)
    .sign(getSecret())
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    return payload
  } catch {
    return null
  }
}

// Edge-safe sync decode (no verification — only used in middleware for fast expiry check)
export function decodeTokenUnsafe(token) {
  try {
    const [, payloadB64] = token.split(".")
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json)
  } catch {
    return null
  }
}

export async function validateRequest(request) {
  const authHeader = request.headers.get("authorization") || ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null

  if (!token) return { valid: false, status: 402, error: "No token provided" }

  const decoded = await verifyToken(token)
  if (!decoded) return { valid: false, status: 402, error: "Invalid or expired token" }

  const db = await getDb()
  const tokenDoc = await db.collection("tokens").findOne({ token })

  if (!tokenDoc) return { valid: false, status: 402, error: "Token not found" }
  if (tokenDoc.isTerminated) return { valid: false, status: 402, error: "Token terminated" }
  if (new Date(tokenDoc.expiresAt) < new Date()) return { valid: false, status: 402, error: "Token expired" }

  return { valid: true, user: decoded }
}

export async function terminateUserTokens(username) {
  const db = await getDb()
  await db.collection("tokens").updateMany({ username }, { $set: { isTerminated: true } })
}

export async function storeToken(username, isAdmin, token) {
  const db = await getDb()
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + TOKEN_EXPIRY_DAYS)
  await db.collection("tokens").insertOne({
    username,
    isAdmin,
    token,
    createdAt: new Date(),
    expiresAt,
    isTerminated: false,
  })
}
