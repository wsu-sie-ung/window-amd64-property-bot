/**
 * warmup.js — pre-earn Cloudflare's `cf_clearance` cookie for each bot profile.
 *
 * WHY: iprop.js runs each agent in its own profile folder (profiles/<agentId>).
 * A fresh/cold profile has no `cf_clearance` cookie, so Cloudflare challenges it.
 * This script opens the *real* Edge (NOT Puppeteer) on that same folder, loads the
 * listings page so Cloudflare's automatic check clears, then closes Edge gracefully
 * so the cookie flushes to disk. The bot then reuses that warmed profile and rides
 * the cookie past the challenge.
 *
 * USAGE:
 *   node warmup.js                 # warm every profile found in ./profiles
 *   node warmup.js --agent=<id>    # warm just profiles/<id> (created if missing)
 *   node warmup.js --seconds=30    # override dwell time (default 25s)
 *
 * HONEST LIMITS:
 *   - A visible Edge window flashes per profile — a real browser is the whole point.
 *   - If Cloudflare escalates to an interactive (click/puzzle) challenge, an
 *     unattended run cannot pass it; a human has to do that visit.
 *   - `cf_clearance` EXPIRES, so this must be re-run periodically (e.g. on a schedule).
 */

const fs = require("fs")
const path = require("path")
const { spawn, execFileSync } = require("child_process")

// Standalone helpers (mirrors utils.js) so this maintenance script depends on
// nothing but Node built-ins — it must run even without the bot's npm packages.
const logFilePath = path.join(process.cwd(), "app.log")
const log = (...args) => {
  const message = [new Date().toISOString(), ...args].join(" ") + "\n"
  fs.appendFileSync(logFilePath, message, "utf8")
}
const getArgValue = (name) => {
  const prefix = `--${name}=`
  const hit = process.argv.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const LISTINGS_URL = "https://www.iproperty.com.my/pro/listings"
const DEFAULT_DWELL_MS = 25000

const PROJECT_ROOT = __dirname
const PROFILES_DIR = path.join(PROJECT_ROOT, "profiles")

// Resolve the real Edge executable (Windows first; mirror iprop.js fallbacks).
function resolveEdgePath() {
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
    const hit = candidates.find(p => fs.existsSync(p))
    if (!hit) throw new Error(`msedge.exe not found. Looked in:\n${candidates.join("\n")}`)
    return hit
  }
  if (process.platform === "darwin") {
    return "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  }
  return "/usr/bin/microsoft-edge"
}

// Decide which profile folders to warm.
function resolveProfiles() {
  const agentArg = getArgValue("agent")
  if (agentArg) {
    const dir = path.join(PROFILES_DIR, agentArg)
    fs.mkdirSync(dir, { recursive: true }) // allow warming a brand-new agent
    return [{ id: agentArg, dir }]
  }

  if (!fs.existsSync(PROFILES_DIR)) return []

  return fs
    .readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ id: e.name, dir: path.join(PROFILES_DIR, e.name) }))
}

// Close the browser by PID.
//   force=false (graceful): `taskkill /PID <pid>` with NO /T — posts WM_CLOSE to the
//     browser process's own windows only. Chromium then shuts down cleanly and
//     FLUSHES cookies to disk. (Adding /T fails: renderer children can't accept
//     WM_CLOSE, which blocks the parent too. A plain /F force-kill skips the flush
//     and loses a just-set cookie unless it has passed the ~30s commit timer.)
//   force=true (fallback): `taskkill /PID <pid> /T /F` — kill the whole tree so the
//     profile lock is guaranteed to release.
function closeProcessTree(pid, force) {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid)]
      execFileSync("taskkill", args, { stdio: "ignore" })
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM")
    }
  } catch (err) {
    // taskkill/kill throws if the process is already gone — that's fine.
  }
}

// Is a browser already using this profile folder? A Chromium profile is locked to
// one process at a time, so warming a live profile would just fail. On Windows the
// lock is a mutex (no lock file), so we check whether any msedge.exe was launched
// with this exact --user-data-dir — that also catches the Puppeteer-driven bot.
function isProfileInUse(profileDir) {
  const abs = path.resolve(profileDir)

  if (process.platform === "win32") {
    try {
      const psCmd =
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' } " +
        "| ForEach-Object { $_.CommandLine }"
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psCmd],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      )
      const needle = abs.toLowerCase()
      return out.toLowerCase().split(/\r?\n/).some(line => line.includes(needle))
    } catch (err) {
      // If we can't enumerate processes, don't block the warm-up — just proceed.
      log(`WARMUP WARN: could not check lock for ${abs}: ${err.message || err}`)
      return false
    }
  }

  // POSIX: Chromium leaves a SingletonLock symlink in the user-data-dir while running.
  try {
    fs.lstatSync(path.join(abs, "SingletonLock"))
    return true
  } catch {
    return false
  }
}

// Warm one profile: open real Edge, dwell, close gracefully so cookies flush.
// Returns "skipped" | "warmed".
async function warmProfile(edgePath, profile, dwellMs) {
  if (isProfileInUse(profile.dir)) {
    log(`WARMUP SKIP: ${profile.id} — Edge already open on this profile (bot or manual). Not touching it.`)
    console.log(`Skipped ${profile.id}: profile in use.`)
    return "skipped"
  }

  log(`WARMUP START: ${profile.id} (${profile.dir})`)

  const args = [
    `--user-data-dir=${profile.dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    LISTINGS_URL,
  ]

  const child = spawn(edgePath, args, { stdio: "ignore" })
  let closed = false
  child.on("exit", () => { closed = true })
  child.on("error", err => log(`WARMUP WARN: spawn error for ${profile.id}: ${err.message || err}`))

  const pid = child.pid
  log(`WARMUP: Edge launched pid=${pid}, dwelling ${Math.round(dwellMs / 1000)}s`)
  await delay(dwellMs)

  if (closed) {
    log(`WARMUP WARN: Edge for ${profile.id} exited before dwell finished ` +
        `(possibly handed off to a running Edge on the same profile). Cookie may not be saved.`)
    return "warmed"
  }

  // Graceful close (no /T, no /F) so Chromium shuts down cleanly and flushes cookies.
  closeProcessTree(pid, false)
  log(`WARMUP: graceful close requested for ${profile.id}`)

  // Wait for a clean exit — Chromium usually exits in ~1s.
  for (let i = 0; i < 16 && !closed; i++) await delay(500) // up to ~8s

  // Fallback: if it ignored the close, force the whole tree so the lock releases.
  if (!closed) {
    closeProcessTree(pid, true)
    log(`WARMUP: forced close for ${profile.id} (ignored graceful request)`)
    await delay(1500)
  }

  log(`WARMUP OK: ${profile.id}`)
  return "warmed"
}

async function main() {
  const edgePath = resolveEdgePath()

  const secondsArg = Number(getArgValue("seconds"))
  const dwellMs = Number.isFinite(secondsArg) && secondsArg > 0 ? secondsArg * 1000 : DEFAULT_DWELL_MS

  const profiles = resolveProfiles()

  if (!profiles.length) {
    log("WARMUP: no profiles to warm.")
    console.log(
      `No profiles found in ${PROFILES_DIR}.\n` +
      `Run the bot once for an agent to create its profile, or warm a specific one:\n` +
      `  node warmup.js --agent=<agentId>`
    )
    return
  }

  log(`WARMUP: ${profiles.length} profile(s), dwell ${dwellMs / 1000}s, edge=${edgePath}`)
  console.log(`Warming ${profiles.length} profile(s): ${profiles.map(p => p.id).join(", ")}`)

  let warmed = 0
  let skipped = 0
  let failed = 0
  for (const profile of profiles) {
    try {
      const status = await warmProfile(edgePath, profile, dwellMs)
      if (status === "skipped") skipped++
      else warmed++
    } catch (err) {
      failed++
      log(`WARMUP ERROR: ${profile.id} -> ${err.message || err}`)
      console.error(`Failed to warm ${profile.id}:`, err.message || err)
    }
  }

  const summary = `Warm-up complete. warmed=${warmed}, skipped=${skipped}, failed=${failed}.`
  console.log(summary)
  log(`WARMUP: all done — ${summary}`)
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { warmProfile, resolveProfiles, resolveEdgePath, closeProcessTree, isProfileInUse }
