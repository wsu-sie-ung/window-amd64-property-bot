const fs = require("fs")
const path = require("path")
const { connect } = require("puppeteer-real-browser");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserPrefsPlugin = require("puppeteer-extra-plugin-user-preferences");
const utils = require("./utils");

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


  // const launchArgs = [
  //   "--no-first-run",
  //   "--no-default-browser-check",
  //   "--disable-blink-features=AutomationControlled"
  // ]

   let launchArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=PasswordLeakDetection,PasswordManager,PasswordImport,PasswordExport,PasswordGeneration,SafeBrowsing,SafeBrowsingDailySpywarePatternExtended,SafeBrowsingEnhancedProtection",
    "--disable-client-side-phishing-detection",
    "--disable-save-password-bubble",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-infobars"
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
  else {
    // launchArgs.push("--disable-web-security", "--disable-sync", "--disable-client-side-phishing-detection", "--start-maximized");
    launchArgs.push("--disable-sync", "--start-maximized");

    // executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  }

  utils.log(`use arguments: ${launchArgs}`);
  utils.log(`use execution path : ${executablePath}`);

  let browser
  try {
    // puppeteer-real-browser runs a CDP-patched runtime (fixes the Runtime.enable
    // leak Cloudflare detects) and can auto-solve the Turnstile checkbox. It returns
    // the prepared page directly — do NOT call browser.newPage().
    const connection = await connect({
      headless: isHeadless,
      turnstile: true,
      args: launchArgs,
      customConfig: {
        chromePath: executablePath,
        userDataDir,
      },
      connectOption: { defaultViewport: null },
      plugins: [StealthPlugin()],
    })
    browser = connection.browser
    const page = connection.page
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
        try { 
          // await page.close() 
        } catch (e) { }
        return
      }
      throw new Error(`REQUEST FAILED: ${url} ${failure}`)
    })
    log("New page created")

    const HOME_URL = "https://www.iproperty.com.my/"
    const LISTINGS_URL = "https://www.iproperty.com.my/pro/listings?lang=en-GB"

    const gotoWithRetry = async (url, label) => {
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"] });
          return; // Success
        } catch (err) {
          if (i === maxRetries - 1) throw err; // Throw on last retry
          log(`${label} failed (attempt ${i + 1}/${maxRetries}): ${err.message}. Retrying in 2s...`);
          await new Promise(res => setTimeout(res, 2000));
        }
      }
    }

    await runStep("Navigate to home page", async () => gotoWithRetry(HOME_URL, "Home navigation"))

    // Reach the PRO listings by clicking through the account menu on the home page
    // instead of hitting the /pro/listings deep link directly — this looks like real
    // navigation and lowers Cloudflare suspicion. Falls back to the direct URL if the
    // account menu isn't available (e.g. the profile isn't logged in yet).
    await runStep("Open account menu → iProperty PRO", async () => {
      const accountWrapper = ".account-wrapper"
      const proLink = '#accountPopup a[title="iProperty PRO"]'

      try {
        await randomMouseMove(page, { moves: 2 })
        await randomDelay(300, 700)

        await page.waitForSelector(accountWrapper, { visible: true, timeout: 15000 })
        await page.click(accountWrapper)
        await randomDelay(400, 900) // let the popup animate in before clicking

        await page.waitForSelector("#accountPopup", { visible: true, timeout: 10000 })
        await page.waitForSelector(proLink, { visible: true, timeout: 10000 })

        await Promise.all([
          page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle2"] }),
          page.click(proLink),
        ])
        log("Reached PRO area via account menu")
      } catch (err) {
        // Not logged in (popup shows login, no PRO link) or the layout changed —
        // fall back to the direct listings URL so the login flow can still proceed.
        log(`Account-menu path unavailable (${err.message}); falling back to direct listings URL`)
        await gotoWithRetry(LISTINGS_URL, "Listings navigation (fallback)")
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
          page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle2"] }).catch(() => { }),
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
        return await page.waitForSelector('[da-id="page-header-create-listing-button"]', { timeout: 15000 })
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

    // ---- Fill the create-listing form (v2: /pro/v2/add-listing) ----
    // iProperty's form shares PropertyGuru's design system (same da-id / hui-*
    // elements), so this mirrors the propguru.js sequence, driven by unitInfo.
    // Every selector lives in utils.js. NOTE: these selectors were validated on
    // the PropertyGuru/older form — if a step fails on v2, its runStep label
    // pinpoints the exact selector to update.
    if (!options.unitInfo) throw new Error("unitInfo missing from options payload")
    const unitInfo = options.unitInfo

    // --- Step 1: category / transaction type / availability ---
    await runStep("Select property category", async () => utils.selectPropertyCategory(page, unitInfo))
    await randomDelay(500, 1000)

    await runStep("Select transaction type", async () => utils.selectTransactionType(page, unitInfo))
    await randomMouseMove(page)

    if (unitInfo.type === 2) {
      await runStep("Select renting option", async () => utils.selectRentingOption(page, unitInfo))
    }

    await runStep("Select immediate date", async () => utils.selectImmediateDate(page))
    await runStep("Next → step 2", async () => utils.clickNextButton(page))
    await randomDelay(500, 1000)

    // --- Step 2: property name / location / unit type ---
    await runStep("Type property name", async () => utils.typePropertyName(page, unitInfo))
    await randomMouseMove(page)
    await runStep("Select first property from dropdown", async () => utils.selectFirstPropertyFromDropdown(page))
    await randomDelay(500, 1000)

    await runStep("Select unit type", async () => utils.selectUnitType(page, unitInfo.unit_type))

    const isRentRoom = unitInfo.type === 2 && unitInfo.renting_opt === 0

    if (isRentRoom) {
      // --- Rent-a-room flow ---
      await runStep("Next → room details", async () => utils.clickNextButton(page))
      await randomDelay(500, 1000)

      await runStep("Select room type", async () => utils.selectRoomType(page, unitInfo.room_type))
      await runStep("Input room size", async () => utils.inputRoomSize(page, unitInfo.room_size))
      await randomMouseMove(page)
      await runStep("Set bathrooms", async () => utils.setBathrooms(page, unitInfo))
      await runStep("Set parking", async () => utils.setParking(page, unitInfo))
      await runStep("Set furnishing status", async () => utils.setFurnishingStatus(page, unitInfo))
      await runStep("Set number of tenants", async () => utils.setNumberOfTenants(page, unitInfo.tenants))
      await runStep("Set allowed gender", async () => utils.setAllowedGender(page, unitInfo.gender))
    } else {
      // --- Entire-unit flow ---
      await runStep("Select title type", async () => utils.selectTitleType(page, unitInfo))
      await runStep("Select direction", async () => utils.selectDirection(page, unitInfo))
      await runStep("Next → unit details", async () => utils.clickNextButton(page))
      await randomDelay(500, 1000)

      await runStep("Fill rooms (bed/bath)", async () => utils.fillRooms(page, unitInfo))
      await randomMouseMove(page)
      await runStep("Set built-up size", async () => utils.setBuiltUpSize(page, unitInfo))
      await runStep("Set land area", async () => utils.setLandArea(page, unitInfo))
      await runStep("Set parking", async () => utils.setParking(page, unitInfo))
      await runStep("Set furnishing status", async () => utils.setFurnishingStatus(page, unitInfo))
    }

    // --- Price ---
    await runStep("Next → price", async () => utils.clickNextButton(page))
    await randomDelay(500, 1000)
    await runStep("Set asking/rental price", async () => utils.setRentalPrice(page, unitInfo))
    await randomMouseMove(page)

    // --- Headline / description ---
    await runStep("Next → description", async () => utils.clickNextButton(page))
    await randomDelay(500, 1000)
    await runStep("Set headline", async () => utils.setHeadline(page, unitInfo))
    await randomDelay(500, 1000)
    await runStep("Set property description", async () => utils.setPropertyDescription(page, unitInfo))
    await randomMouseMove(page)

    // --- Photos ---
    await runStep("Next → photos", async () => utils.clickNextButton(page))
    await utils.handleNewFeatureModal(page)
    await runStep("Upload images", async () => utils.uploadImages(page, unitInfo))
    await randomMouseMove(page)
    await utils.delay(10000)

    // --- Posting plan ---
    await runStep("Next → posting plan", async () => utils.clickNextButton(page))
    await utils.closeDuplicatedImageAlert(page)
    await utils.handleNewFeatureModal(page)

    await runStep("Reset posting plans", async () => {
      await utils.uncheckIProp(page)
      await utils.uncheckPropertyGuru(page)
    })
    if (options.post_to_propertyguru) {
      await runStep("Check PropertyGuru plan", async () => utils.checkPropertyGuru(page))
    }
    if (options.post_to_iproperty) {
      await runStep("Check iProperty plan", async () => utils.checkIProp(page))
    }
    await utils.closeDuplicatedImageAlert(page)

    // --- Preview + post ---
    await runStep("Next → preview", async () => utils.clickNextButton(page))
    await utils.handlePreviewLoadingErrorModal(page)

    // DRY_RUN=true fills the whole form but skips the real submission (no credits spent).
    if (process.env.DRY_RUN === "true") {
      log("DRY RUN: form filled; skipping Post Now + Confirm (no listing posted, no credits spent)")
      return { success: true, captchaDetected: false, dryRun: true }
    }

    await runStep("Click Post Now", async () => utils.clickPostNow(page))

    // Confirm posting modal — WARNING: this performs a real post (spends credits).
    await runStep("Confirm posting", async () => {
      const confirmModalSelector = ".modal-dialog.modal-sm.modal-dialog-centered"
      await page.waitForSelector(confirmModalSelector, { visible: true, timeout: 5000 })
      const confirmBtnSelector = `${confirmModalSelector} button.btn-primary`
      await page.waitForSelector(confirmBtnSelector, { visible: true, timeout: 5000 })
      await page.evaluate(selector => {
        const btn = document.querySelector(selector)
        if (btn) { btn.scrollIntoView({ block: "center" }); btn.click() }
      }, confirmBtnSelector)
      log('"Confirm" button clicked')
    })

    log("All steps complete. Listing submitted.")
    return { success: true, captchaDetected: false }

  } catch (err) {
    console.error(new Date().toISOString(), "RUN FAILED", err && err.message ? err.message : err)
    process.exitCode = 1
    const isCaptcha = (err && err.message && err.message.includes("CAPTCHA detected")) || botChallengeDetected
    return { success: false, captchaDetected: isCaptcha, error: err.message || String(err) }
  } finally {
    try { if (browser) await browser.close() } catch (_) { }
  }
}

if (require.main === module) {
  runBot().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { runBot }
