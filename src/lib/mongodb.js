import { MongoClient } from "mongodb"

const uri = process.env.MONGODB_URI
let client
let clientPromise

if (!uri) throw new Error("MONGODB_URI not set in environment")

if (process.env.NODE_ENV === "development") {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri)
    global._mongoClientPromise = client.connect()
  }
  clientPromise = global._mongoClientPromise
} else {
  client = new MongoClient(uri)
  clientPromise = client.connect()
}

export default clientPromise

export async function getDb() {
  const c = await clientPromise
  return c.db(process.env.MONGODB_DB || "ogmirza")
}
