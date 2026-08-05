import { MongoClient } from "mongodb"

let client
let clientPromise

function getClientPromise() {
  if (clientPromise) return clientPromise
  const uri = process.env.MONGODB_URI
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
  return clientPromise
}

export default { then: (...args) => getClientPromise().then(...args) }

export async function getDb() {
  const c = await getClientPromise()
  return c.db(process.env.MONGODB_DB || "ogmirza")
}
