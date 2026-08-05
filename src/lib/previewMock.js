// Preview-only mock data so the UI can be exercised in a DB-less / bot-less
// preview environment. This activates ONLY in development AND when no database
// is configured. In any real deployment NODE_ENV is "production" (and a
// MONGODB_URI is set), so this is guaranteed to stay off in production.

export const PREVIEW_MOCK =
  process.env.NODE_ENV !== "production" && !process.env.MONGODB_URI

const NAMES = [
  "Daniel Cooper", "Sophia Bennett", "Marcus Reed", "Olivia Hayes",
  "Liam Foster", "Emma Sullivan", "Noah Brooks", "Ava Mitchell",
  "Ethan Parker", "Mia Coleman", "Lucas Grant", "Isla Morgan",
]

const PHOTOS = ["/mock-avatars/a1.png", "/mock-avatars/a2.png", "/mock-avatars/a3.png"]
const COUNTRIES = ["US", "GB", "DE", "FR", "CA", "AU"]

export function mockSessions() {
  return NAMES.map((name, i) => ({
    _id: `mock-${i}`,
    index: i,
    name,
    username: name.toLowerCase().replace(/\s+/g, "_"),
    phone: `1 202 555 0${100 + i}`,
    country: COUNTRIES[i % COUNTRIES.length],
    dcId: (i % 5) + 1,
    premium: i % 3 === 0,
    emojiStatus: i % 4 === 0,
    hasPhoto: i % 3 !== 2,
    // every 3rd account has no photo -> shows initials fallback
    photoUrl: i % 3 === 2 ? null : PHOTOS[i % PHOTOS.length],
    isValid: true,
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  }))
}

export function mockEmails() {
  const now = Date.now()
  return [
    {
      id: "m1", threadId: "t1", direction: "outbound",
      from: "report@abusenotifications.org", to: ["abuse@telegram.org"],
      subject: "Abuse Report — Channel @cryptoscam2024",
      text: "We are reporting the channel @cryptoscam2024 for coordinated financial fraud targeting users with fake investment schemes.",
      html: "<p>We are reporting the channel <b>@cryptoscam2024</b> for coordinated financial fraud.</p>",
      createdAt: new Date(now - 3 * 3600000).toISOString(),
    },
    {
      id: "m2", threadId: "t1", direction: "inbound",
      from: "abuse@telegram.org", to: ["report@abusenotifications.org"],
      subject: "Re: Abuse Report — Channel @cryptoscam2024",
      text: "Thank you for your report. We have received it and our moderation team is reviewing the channel. Reference: TG-48213.",
      html: "<p>Thank you for your report. Reference: <b>TG-48213</b>.</p>",
      createdAt: new Date(now - 2 * 3600000).toISOString(),
    },
    {
      id: "m3", threadId: "t2", direction: "outbound",
      from: "report@abusenotifications.org", to: ["legal@example.com"],
      subject: "Takedown Request — Leaked Database Group",
      text: "Please find attached evidence of a group distributing leaked personal data in violation of platform policy.",
      html: "<p>Please find attached evidence of a group distributing leaked personal data.</p>",
      createdAt: new Date(now - 26 * 3600000).toISOString(),
    },
  ]
}
