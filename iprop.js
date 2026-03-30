const fs = require("fs")
const path = require("path")
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin()); 

const {
  log,
  runStep,
  getArgValue,
  sanitizeId,
  REQUEST_IGNORES,
  randomDelay,
  randomMouseMove,
  checkAndPauseIfCaptcha
} = require("./utils")

const isLoginPage = async (page) => {
  const url = page.url()
  if (/accounts\.iproperty\.com\.my\/login/i.test(url)) return true
  const hasLoginField = await page.$("#login-userid").then(Boolean)
  return hasLoginField
}

//automation
const runBot = async (options = {}) => {
  let botChallengeDetected = false
  const platformIdRaw = options.platform || getArgValue("platform") || process.env.PLATFORM_ID || "iproperty"
  const platformId = sanitizeId(platformIdRaw) || "iproperty"

  const requestedAgentId =
    options.agentId ||
    getArgValue("agent") ||
    process.env.AGENT_ID ||
    "default_agent"

  log("Selected agent:", requestedAgentId)

  // each agent has a unique profile directory
  const projectRoot = __dirname
  const profileSegment = options.browserProfilePath || path.join("profiles", requestedAgentId)
  const userDataDir = path.join(projectRoot, profileSegment)
  fs.mkdirSync(userDataDir, { recursive: true })

  log("Platform:", platformId)
  log("Launching browser with agent profile:", userDataDir)


  const launchArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled"
  ]

  // Add sandbox flags if running on Linux (production)
  let executablePath
  // Default to headless: false for local dev (macOS), true for production (Linux)
  // Can be overridden via HEADLESS env var
  const isHeadless = process.env.HEADLESS ? process.env.HEADLESS === "true" : process.platform === "linux"

  if (process.platform === "linux") {
    launchArgs.push("--no-sandbox", "--disable-setuid-sandbox")
    // executablePath = "/usr/bin/google-chrome"
    executablePath = "/usr/bin/chromium-browser"
    
  } else if (process.platform === "darwin") {
    executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  }

  let browser
  try {
    browser = await puppeteer.launch({
      headless: isHeadless,
      slowMo: 50,
      userDataDir,
      executablePath,
      args: launchArgs
    })

    const page = await browser.newPage()
    // Non-fatal: Log errors from the website's own scripts (don't stop bot)
    page.on("pageerror", err => console.warn(new Date().toISOString(), "PAGE JS ERROR (NON-FATAL)", err))
    
    // Fatal: Page crashed. The next puppeteer action will automatically throw an error.
    page.on("error", err => console.error(new Date().toISOString(), "PAGE CRASHED", err))
    page.on("requestfailed", async req => {
      const url = req.url()
      const failure = req.failure() && req.failure().errorText
      if (REQUEST_IGNORES.some(re => re.test(url))) return
      if (!failure) return
      if (failure.includes("ERR_ABORTED")) return
      if (/cdn-cgi\/challenge-platform/i.test(url)) {
        botChallengeDetected = true
        console.error(new Date().toISOString(), "BOT CHALLENGE DETECTED", url, failure)
        try { await page.close() } catch (e) {} 
        return
      }
      throw new Error(`REQUEST FAILED: ${url} ${failure}`)
    })
    log("New page created")

    await runStep("Navigate to /pro/listings", async () => {
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          await page.goto("https://www.iproperty.com.my/pro/listings", { waitUntil: ["domcontentloaded", "networkidle2"] });
          return; // Success
        } catch (err) {
          if (i === maxRetries - 1) throw err; // Throw on last retry
          log(`Navigation failed (attempt ${i + 1}/${maxRetries}): ${err.message}. Retrying in 2s...`);
          await new Promise(res => setTimeout(res, 2000));
        }
      }
    })
    
    const captchaDetected = await runStep("Check CAPTCHA", async () => checkAndPauseIfCaptcha(page, false))
    if (captchaDetected) throw new Error("CAPTCHA detected")

    const needsLogin = await page.$("#login-userid").then(Boolean)

    if (needsLogin) {
      log("Login required for agent:", requestedAgentId)
      
      const loginEmail = options.email || process.env.IPROP_EMAIL
      const loginPassword = options.password || process.env.IPROP_PASSWORD

      if (!loginEmail || !loginPassword) {
        throw new Error("Missing iProperty login email/password")
      }

      await runStep("Human mouse pre-login", async () => randomMouseMove(page, { moves: 1 }))
      await runStep("Type email", async () => page.type("#login-userid", loginEmail, { delay: 120 }))
      await runStep("Type password", async () => page.type("#login-password", loginPassword, { delay: 200 }))
      await runStep("Submit login", async () =>
        Promise.all([
          page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle2"] }).catch(() => {}),
          page.click("#btn_login")
        ])
      )

      await runStep("Navigate to /pro/listings post-login", async () =>
        page.goto("https://www.iproperty.com.my/pro/listings", { waitUntil: ["domcontentloaded", "networkidle2"] })
      )
      
      const captchaDetected2 = await runStep("Check CAPTCHA post-login", async () => checkAndPauseIfCaptcha(page, false))
      if (captchaDetected2) throw new Error("CAPTCHA detected")

      await runStep("Verify login succeeded", async () => {
        const stillLogin = await isLoginPage(page)
        if (!stillLogin) return
        throw new Error(`Invalid email/password (${loginEmail})`)
      })
    } else {
      log("Session reused — already logged in")
    }

    await runStep("Human mouse on listing page", async () => randomMouseMove(page, { moves: 2 }))
    await runStep("Random delay", async () => randomDelay(300, 600))

    const button = await runStep("Wait add property button", async () => {
      try {
        return await page.waitForSelector('button[data-test="btn-add-property"]', { timeout: 15000 })
      } catch (err) {
        throw new Error(`Add property button not found (url=${page.url()})`)
      }
    })

    await runStep("Click create listing + wait navigation", async () =>
      Promise.all([
        page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle2"] }),
        button.click()
      ])
    )
    
    return { success: true, captchaDetected: false }

  } catch (err) {
    console.error(new Date().toISOString(), "RUN FAILED", err && err.message ? err.message : err)
    process.exitCode = 1
    const isCaptcha = (err && err.message && err.message.includes("CAPTCHA detected")) || botChallengeDetected
    return { success: false, captchaDetected: isCaptcha, error: err.message || String(err) }
  } finally {
    try { if (browser) await browser.close() } catch (_) {}
  }
}

if (require.main === module) {
  runBot().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { runBot }
