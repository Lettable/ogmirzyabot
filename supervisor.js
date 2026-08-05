// Process supervisor — keeps both the web server and the Telegram bot alive.
// Each child is restarted independently with exponential backoff, so a crash
// (or OOM) in one never takes down the other and never leaves the bot dead.
const { spawn } = require("child_process")

const children = {}

function start(name, command, args) {
  let backoff = 1000               // start at 1s
  const MAX_BACKOFF = 30000        // cap at 30s

  function launch() {
    const t0 = Date.now()
    const child = spawn(command, args, { stdio: "inherit", env: process.env })
    children[name] = child

    child.on("exit", (code, signal) => {
      delete children[name]
      const ranFor = Date.now() - t0
      // If it stayed up a while, reset backoff — only ramp on rapid crash loops
      if (ranFor > 60000) backoff = 1000
      console.error(`[supervisor] "${name}" exited (code=${code} signal=${signal}) after ${Math.round(ranFor/1000)}s — restarting in ${backoff}ms`)
      setTimeout(launch, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF)
    })

    child.on("error", (err) => {
      console.error(`[supervisor] "${name}" failed to spawn:`, err.message)
    })
  }

  launch()
}

// Forward termination signals so the container shuts down cleanly
function shutdown(sig) {
  console.error(`[supervisor] received ${sig} — stopping children`)
  for (const child of Object.values(children)) {
    try { child.kill(sig) } catch {}
  }
  setTimeout(() => process.exit(0), 2000)
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))

start("site", "node",    ["server.js"])
start("bot",  "python3", ["telegram.py"])
