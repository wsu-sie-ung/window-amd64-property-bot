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
  // 1) Embedded widget in the light DOM with an explicit sitekey. `deepQuery`
  //    also pierces open shadow roots, so this catches widgets whose host page
  //    renders the .cf-turnstile div inside a shadow tree.
  const domParams = await page.evaluate(() => {
    const deepQuery = (root, selector) => {
      const hit = root.querySelector(selector)
      if (hit) return hit
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const nested = deepQuery(el.shadowRoot, selector)
          if (nested) return nested
        }
      }
      return null
    }

    const widget = deepQuery(document, "[data-sitekey]")
    if (widget && widget.getAttribute("data-sitekey")) {
      return {
        websiteKey: widget.getAttribute("data-sitekey"),
        action: widget.getAttribute("data-action") || undefined,
        cdata: widget.getAttribute("data-cdata") || undefined,
      }
    }
    return null
  })
  if (domParams) return domParams

  // 2) Managed-challenge / shadow-hosted widget: the sitekey is a `0x...`
  //    segment in the challenges.cloudflare.com frame URL. document.querySelector
  //    can't pierce shadow roots or cross-origin frames, but Puppeteer's frame
  //    tree tracks EVERY frame via CDP — so read the sitekey straight from the
  //    frame URL instead of the DOM. This is why extraction was returning null.
  for (const frame of page.frames()) {
    const url = frame.url()
    if (/challenges\.cloudflare\.com/i.test(url) && /turnstile/i.test(url)) {
      const match = url.match(/0x[A-Za-z0-9_-]+/)
      if (match) return { websiteKey: match[0] }
    }
  }

  return null
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

  // Log the exact task payload (clientKey intentionally omitted) so a
  // malformed request / HTTP 400 is diagnosable straight from app.log.
  log("CapSolver createTask → POST " + CAPSOLVER_BASE + "/createTask")
  log("CapSolver createTask payload: " + JSON.stringify(task))

  let data
  try {
    const res = await axios.post(`${CAPSOLVER_BASE}/createTask`, {
      clientKey: CAPSOLVER_API_KEY,
      task,
    })
    data = res.data
    log("CapSolver createTask response: " + JSON.stringify(data))
  } catch (err) {
    // axios throws on non-2xx (e.g. HTTP 400). CapSolver puts the real reason
    // in the response body — surface status + body, not a bare axios message.
    const status = err.response && err.response.status
    const body = err.response && err.response.data
    log(
      `CapSolver createTask HTTP ERROR: status=${status} body=${JSON.stringify(body)}`
    )
    throw new Error(
      `CapSolver createTask HTTP ${status}: ${
        body ? JSON.stringify(body) : err.message
      }`
    )
  }

  if (data.errorId) {
    throw new Error(
      `CapSolver createTask failed: errorId=${data.errorId} ${data.errorCode} ${data.errorDescription}`
    )
  }
  if (!data.taskId) {
    throw new Error(
      "CapSolver createTask returned no taskId: " + JSON.stringify(data)
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
  // Diagnostic: dump the frame tree so we can confirm on the real box whether
  // the challenges.cloudflare.com frame URL (with the 0x... sitekey) is visible
  // to page.frames() at solve time. If it shows as about:blank the iframe hasn't
  // navigated yet (increase the settle delay); if it's the cf-chl-widget managed
  // interstitial, a proxyless token may not be accepted.
  log(
    "CapSolver: frames at solve time:\n  " +
      page
        .frames()
        .map((f) => f.url() || "(empty)")
        .join("\n  ")
  )

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
