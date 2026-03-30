const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const utils = require("./utils");

puppeteer.use(StealthPlugin());

const runBot = async (options = {}) => {
  let botChallengeDetected = false;

  const requestedAgentId =
    options.agentId ||
    utils.getArgValue("agent") ||
    process.env.AGENT_ID ||
    "default_agent";

  utils.log("Selected agent:", requestedAgentId);

  const projectRoot = __dirname;
  const profileSegment = path.join(
    "profiles",
    options.browserProfilePath || requestedAgentId
  );
  const userDataDir = path.join(projectRoot, profileSegment);
  fs.mkdirSync(userDataDir, { recursive: true });
  utils.log("Using userDataDir:", userDataDir);

  let launchArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=PasswordLeakDetection,PasswordManager,PasswordImport,PasswordExport,PasswordGeneration,SafeBrowsing,SafeBrowsingDailySpywarePatternExtended,SafeBrowsingEnhancedProtection",
    "--disable-client-side-phishing-detection",
    "--disable-save-password-bubble",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-infobars",
    "--disable-component-update",
  ];

  let executablePath;
  const isHeadless =
    process.env.HEADLESS ? process.env.HEADLESS === "true" : process.platform === "linux";
  if (process.platform === "linux") {
    launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
    executablePath = process.env.CHROME_PATH || "/usr/bin/chromium-browser";
  } else if (process.platform === "darwin") {
    executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else {
    launchArgs.push("--disable-web-security");
    executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    // executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  }

  utils.log(`use arguments: ${launchArgs}`);
  utils.log(`use execution path : ${executablePath}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: isHeadless,
      slowMo: 50,
      userDataDir,
      executablePath,
      args: launchArgs,
    });

    const pages = await browser.pages();
    const page = pages.length ? pages[0] : await browser.newPage();

    // Error handling
    page.on("pageerror", (err) => console.warn(new Date().toISOString(), "PAGE JS ERROR", err));
    page.on("error", (err) => console.error(new Date().toISOString(), "PAGE CRASHED", err));
    page.on("requestfailed", async (req) => {
      const url = req.url();
      const failure = req.failure() && req.failure().errorText;
      if (utils.REQUEST_IGNORES.some((re) => re.test(url))) return;
      if (!failure) return;
      if (failure.includes("ERR_ABORTED")) return;
      if (/cdn-cgi\/challenge-platform/i.test(url)) {
        botChallengeDetected = true;
        console.error(new Date().toISOString(), "BOT CHALLENGE DETECTED", url, failure);
        try {
          await page.close();
        } catch (_) {}
        return;
      }
      throw new Error(`REQUEST FAILED: ${url} ${failure}`);
    });

    // Navigate dashboard
    utils.log("New page created");
    await utils.runStep("Navigate to dashboard", async () => {
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          await page.goto("https://agentnet.propertyguru.com.my/v2/dash", {
            waitUntil: ["domcontentloaded", "networkidle2"],
          });
          return;
        } catch (err) {
          if (i === maxRetries - 1) throw err;
          utils.log(`Navigation failed (attempt ${i + 1}/${maxRetries}): ${err.message}. Retrying in 2s...`);
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    });

    const captchaDetected = await utils.runStep("Check CAPTCHA", async () =>
      utils.checkAndPauseIfCaptcha(page, false)
    );
    if (captchaDetected) throw new Error("CAPTCHA detected");

    // Login
    const needsLogin = await utils.isLoginPage(page);
    if (needsLogin) {
      utils.log("Need Login — will do login");
      await utils.performLogin(page, options, requestedAgentId);
    }
    else utils.log("Session reused — already logged in");

    await utils.runStep("Human mouse on listing page", async () =>
      utils.randomMouseMove(page, { moves: 2 })
    );
    await utils.runStep("Random delay", async () => utils.randomDelay(300, 600));

    // CREATE LISTING
    await utils.clickCreateListing(page);

    if (!options.unitInfo) throw new Error("unitInfo missing from options payload");

    await utils.runStep("Select property category", async () =>
      utils.selectPropertyCategory(page, options.unitInfo)
    );
    await utils.randomDelay(500, 1000);

    await utils.runStep("Select transaction type", async () =>
      utils.selectTransactionType(page, options.unitInfo)
    );
    await utils.randomMouseMove(page);

    if (options.unitInfo.type === 2) {
      await utils.selectRentingOption(page, options.unitInfo);
    }

    await utils.selectImmediateDate(page);
    await utils.clickNextButton(page);
    await utils.randomDelay(800, 1500);

    await utils.typePropertyName(page, options.unitInfo);
    await utils.randomMouseMove(page);
    await utils.selectFirstPropertyFromDropdown(page);
    await utils.randomDelay(500, 1000);

    await utils.selectUnitType(page, options.unitInfo.unit_type);

    // Determine flow
    const isRentRoom =
      options.unitInfo.type === 2 && options.unitInfo.renting_opt === 0;

    if (isRentRoom) {
      // RENT-A-ROOM FLOW
      await utils.clickNextButton(page);
      await utils.randomDelay(500, 1000);

      await utils.selectRoomType(page, options.unitInfo.room_type);
      await utils.inputRoomSize(page, options.unitInfo.room_size);
      await utils.randomMouseMove(page);
      await utils.setBathrooms(page, options.unitInfo);
      await utils.setParking(page, options.unitInfo);
      await utils.setFurnishingStatus(page, options.unitInfo);
      await utils.setNumberOfTenants(page, options.unitInfo.tenants);
      await utils.setAllowedGender(page, options.unitInfo.gender); 
    } else {
      // RENT ENTIRE UNIT FLOW
      await utils.selectTitleType(page, options.unitInfo);
      await utils.selectDirection(page, options.unitInfo);
      await utils.clickNextButton(page);
      await utils.randomDelay(1000, 2000);

      await utils.fillRooms(page, options.unitInfo);
      await utils.randomMouseMove(page);
      await utils.setBuiltUpSize(page, options.unitInfo);
      await utils.setParking(page, options.unitInfo);
      await utils.setFurnishingStatus(page, options.unitInfo);
    }

    // COMMON STEPS
    await utils.clickNextButton(page);
    await utils.randomDelay(1000, 2000);

    await utils.setRentalPrice(page, options.unitInfo);
    await utils.randomMouseMove(page);

    await utils.clickNextButton(page);
    await utils.randomDelay(1000, 2000);

    await utils.setHeadline(page, options.unitInfo);
    await utils.randomDelay(500, 1000);

    await utils.setPropertyDescription(page, options.unitInfo);
    await utils.randomMouseMove(page);

    await utils.clickNextButton(page);
    await utils.handleNewFeatureModal(page);

    await utils.uploadImages(page, options.unitInfo);
    await utils.randomMouseMove(page);
    await utils.delay(10000);

    await utils.clickNextButton(page);
    await utils.handleNewFeatureModal(page);

    await utils.uncheckIProp(page);
    await utils.clickNextButton(page);

    await utils.clickPostNow(page);

    const confirmModalSelector = ".modal-dialog.modal-sm.modal-dialog-centered";
    await page.waitForSelector(confirmModalSelector, { visible: true, timeout: 10000 });
    console.log("Confirm posting modal appeared");

    // const confirmBtnSelector = `${confirmModalSelector} button.btn-primary`;

    // await page.waitForSelector(confirmBtnSelector, { visible: true, timeout: 5000 });
    // await page.evaluate(selector => {
    //   const btn = document.querySelector(selector);
    //   if (btn) {
    //     btn.scrollIntoView({ block: 'center' });
    //     btn.click();
    //   }
    // }, confirmBtnSelector);

    // console.log('"Confirm" button clicked');

    
   

    utils.log("All buttons clicked. Task complete.");
    return { success: true, captchaDetected: false };
  } catch (err) {
    console.error(
      new Date().toISOString(),
      "RUN FAILED",
      err && err.message ? err.message : err
    );
    const isCaptcha = err.message && err.message.includes("CAPTCHA detected");
    return { success: false, captchaDetected: isCaptcha, error: err.message || String(err) };
  } finally {
    try {
      if (browser) {
        await new Promise((res) => setTimeout(res, 1500));
        // await browser.close();
      }
    } catch (_) {}
  }
};

if (require.main === module) {
  runBot().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runBot };
