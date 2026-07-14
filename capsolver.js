/**
 * capsolver.js — CapSolver integration for Cloudflare Turnstile.
 *
 * puppeteer-real-browser (turnstile:true) already auto-solves the plain
 * Turnstile checkbox. This module is the FALLBACK for when Cloudflare escalates
 * to a token-based Turnstile widget that the built-in solver can't clear:
 *
 *   1. Scrape the widget's sitekey (+ action/cdata) and the page URL.
 *   2. Ask CapSolver to solve it (AntiTurnstileTaskProxyLess).
 *   3. Poll until the token is ready.
 *   4. Inject the token into the page's cf-turnstile-response field and fire
 *      the widget callback so the host form treats it as solved.
 *
 * Docs: https://docs.capsolver.com/guide/captcha/cloudflare_turnstile.html
 */

const axios = require("axios")
const { log } = require("./utils")

// Key can be overridden per-environment; falls back to the provisioned key.
const CAPSOLVER_API_KEY =
  process.env.CAPSOLVER_API_KEY ||
  "CAP-1ADBD1D3FF4072141E0CEE235BE609C8E88A72FAC7001AFA0D31BBCA6CDB37FB"

const CAPSOLVER_BASE = "https://api.capsolver.com"

// How long to wait for CapSolver to return a token before giving up.
const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 40 // ~2 minutes

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

/**
 * Pull the Turnstile parameters CapSolver needs out of the live page.
 * Handles both an embedded widget (`.cf-turnstile[data-sitekey]`) and the
 * Cloudflare challenge iframe (sitekey lives in the iframe src).
 * Returns null if no Turnstile widget is present.
 */
async function extractTurnstileParams(page) {
  return page.evaluate(() => {
    const widget = document.querySelector(".cf-turnstile, [data-sitekey]")
    if (widget && widget.getAttribute("data-sitekey")) {
      return {
        websiteKey: widget.getAttribute("data-sitekey"),
        action: widget.getAttribute("data-action") || undefined,
        cdata: widget.getAttribute("data-cdata") || undefined,
      }
    }

    // Managed-challenge interstitial: sitekey is a `0x...` segment in the
    // challenges.cloudflare.com iframe URL.
    const iframe = document.querySelector(
      'iframe[src*="challenges.cloudflare.com"]'
    )
    if (iframe) {
      const match = iframe.getAttribute("src").match(/0x[A-Za-z0-9_-]+/)
      if (match) return { websiteKey: match[0] }
    }

    return null
  })
}

/** Create a CapSolver task and return its taskId. */
async function createTask({ websiteURL, websiteKey, action, cdata }) {
  const task = {
    type: "AntiTurnstileTaskProxyLess",
    websiteURL,
    websiteKey,
  }
  if (action || cdata) {
    task.metadata = {}
    if (action) task.metadata.action = action
    if (cdata) task.metadata.cdata = cdata
  }

  const { data } = await axios.post(`${CAPSOLVER_BASE}/createTask`, {
    clientKey: CAPSOLVER_API_KEY,
    task,
  })

  if (data.errorId) {
    throw new Error(
      `CapSolver createTask failed: ${data.errorCode} ${data.errorDescription}`
    )
  }
  return data.taskId
}

/** Poll getTaskResult until the token is ready (or we time out). */
async function waitForToken(taskId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)

    const { data } = await axios.post(`${CAPSOLVER_BASE}/getTaskResult`, {
      clientKey: CAPSOLVER_API_KEY,
      taskId,
    })

    if (data.errorId) {
      throw new Error(
        `CapSolver getTaskResult failed: ${data.errorCode} ${data.errorDescription}`
      )
    }
    if (data.status === "ready") {
      return data.solution.token
    }
    log(`CapSolver task ${taskId} still processing (attempt ${attempt + 1})`)
  }
  throw new Error(`CapSolver timed out after ${MAX_POLL_ATTEMPTS} polls`)
}

/**
 * Write the solved token back into the page so the host form / Cloudflare
 * treats the challenge as passed: populate the response field(s) and invoke
 * the widget's callback if one was registered via data-callback.
 */
async function injectToken(page, token) {
  await page.evaluate((tk) => {
    document
      .querySelectorAll(
        '[name="cf-turnstile-response"], [name="g-recaptcha-response"]'
      )
      .forEach((el) => {
        el.value = tk
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      })

    // Fire the widget callback (data-callback="fnName") if present.
    const widget = document.querySelector(".cf-turnstile[data-callback]")
    if (widget) {
      const cbName = widget.getAttribute("data-callback")
      if (cbName && typeof window[cbName] === "function") {
        try {
          window[cbName](tk)
        } catch (_) {
          /* non-fatal */
        }
      }
    }
  }, token)
}

/**
 * Solve the Turnstile challenge on `page` via CapSolver.
 * @returns {Promise<string|null>} the token if solved, otherwise null
 *          (no widget found, or solving failed).
 */
async function solveTurnstile(page, options = {}) {
  const params = await extractTurnstileParams(page)
  if (!params) {
    log("CapSolver: no Turnstile widget found on page")
    return null
  }

  const websiteURL = options.websiteURL || page.url()
  log(`CapSolver: solving Turnstile for ${websiteURL} (key ${params.websiteKey})`)

  try {
    const taskId = await createTask({ ...params, websiteURL })
    log(`CapSolver: task created ${taskId}`)

    const token = await waitForToken(taskId)
    log("CapSolver: token received, injecting into page")

    await injectToken(page, token)
    return token
  } catch (err) {
    log(`CapSolver: solve failed — ${err.message}`)
    return null
  }
}

module.exports = { solveTurnstile }
