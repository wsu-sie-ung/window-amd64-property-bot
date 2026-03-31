const fs = require("fs")
const path = require("path")
const axios = require("axios")

//log every bot action
// const log = (...args) => console.log(new Date().toISOString(), ...args) //time stamp

const logFilePath = path.join(process.cwd(), 'app.log');

const log = (...args) => {
  const message = [
    new Date().toISOString(),
    ...args
  ].join(' ') + '\n';

  fs.appendFileSync(logFilePath, message, 'utf8');
};

const runStep = async (name, fn) => {
  log("STEP START:", name) //step has begun
  try {
    const r = await fn()
    log("STEP OK:", name) //step has completed successfully
    return r
  } catch (err) {
    log("STEP ERROR:", name) //step has begun
    console.error(new Date().toISOString(), "STEP ERROR:", name, err) //step has failed
    throw err
  }
}

const getArgValue = (name) => {
  const prefix = `--${name}=`
  const hit = process.argv.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const sanitizeId = (value) => String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_")

//reduce logging noise
const REQUEST_IGNORES = [
  /google-analytics/i,
  /analytics\.google\.com/i,
  /fundingchoicesmessages\.google\.com/i,
  /googletagmanager/i,
  /googlesyndication/i,
  /clarity\.ms/i,
  /bat\.bing\.com/i,
  /static\.ads-twitter\.com/i,
  /analytics\.twitter\.com/i,
  /t\.co\/1\/i\/adsct/i,
  /vc\.hotjar\.io/i,
  /hotjar\.com/i,
  /analytics\.tiktok\.com/i,
  /use\.fontawesome\.com/i
]

//pauses script for random amount of time
const randomDelay = (min = 100, max = 500) => {
  const ms = Math.random() * (max - min) + min
  log(`Waiting for ${Math.round(ms)}ms`)
  return new Promise(res => setTimeout(res, ms))
}

//random mouse movement
async function randomMouseMove(page, options = {}) {
  const {
    moves = Math.floor(Math.random() * 3) + 2, // 2–4 moves
    minDelay = 100,
    maxDelay = 400 //wait range between each move
  } = options

  log(`Executing random mouse move: ${moves} moves`)

  const viewport = page.viewport() //read current viewport

  if (!viewport) return //if no viewport, exit function

  //loop for number of loops requested
  for (let i = 0; i < moves; i++) {
    const x = Math.floor(Math.random() * viewport.width) //pick random horizontal position
    const y = Math.floor(Math.random() * viewport.height) //pick random vertical position

    //moves the mouse to (x,y) with random number of intermediate steps
    await page.mouse.move(x, y, {
      steps: Math.floor(Math.random() * 15) + 5
    })
    //wait a random delay before next movement
    await new Promise(res =>
      setTimeout(res, Math.random() * (maxDelay - minDelay) + minDelay)
    )
  }
}

//detecting captcha and pause 12 - 24 hours if triggered
async function checkAndPauseIfCaptcha(page, autoPause = true) {
  const captchaDetected =
    await page.$('#captcha') ||
    await page.$('.g-recaptcha') ||
    await page.$('.h-captcha') ||
    await page.$('iframe[src*="captcha"]')

  if (captchaDetected) {
    log("CAPTCHA DETECTED")

    if (autoPause) {
      const minDelay = 12 * 60 * 60 * 1000  // 12 hours
      const maxDelay = 24 * 60 * 60 * 1000  // 24 hours
      const delay = Math.random() * (maxDelay - minDelay) + minDelay

      log("Pausing hours:", (delay / 1000 / 60 / 60).toFixed(2))
      await new Promise(res => setTimeout(res, delay))

      await runStep("Reload after CAPTCHA pause", async () => page.reload({ waitUntil: ["domcontentloaded", "networkidle2"] }))
    } else {
      log("Skipping pause (autoPause=false)")
    }
    return true
  } else {
    log("No CAPTCHA detected")
    return false
  }
}

//agents
function loadAgents(agentFile) {
  let raw
  try {
    raw = fs.readFileSync(agentFile, "utf-8")
  } catch (err) {
    throw new Error(`Failed to read agents file: ${agentFile}\n${err && err.message ? err.message : String(err)}`)
  }

  if (!raw || !raw.trim()) {
    throw new Error(
      `Agents file is empty: ${agentFile}\n` +
      `Expected JSON like {"agents":[{"id":"agent_1","email":"...","password":"...","active":true}]}`
    )
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Agents file is not valid JSON: ${agentFile}\n` +
      `${err && err.message ? err.message : String(err)}`
    )
  }

  const agents = Array.isArray(data?.agents) ? data.agents : []
  if (!agents.length) {
    throw new Error(
      `No agents found in: ${agentFile}\n` +
      `Expected top-level key "agents" as an array.`
    )
  }

  const activeAgents = agents.filter(a => a && a.active)
  if (!activeAgents.length) throw new Error(`No active agents in: ${agentFile}`)
  return activeAgents
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const isLoginPage = async (page) => {
  const url = page.url()
  if (/accounts\.propertyguru\.com\.my\/account\/login/i.test(url)) return true
  const hasLoginField = await page.$('input[name="username"]').then(Boolean).catch(() => false)
  return hasLoginField
}

function normalize(str) {
  return str.toLowerCase().replace(/\s+/g, '')
}

// Press property category button
const selectPropertyCategory = async (page, unitInfo) => {
  const propertyCategory = unitInfo?.property_type?.property_category

  if (!propertyCategory) throw new Error("Property category not found in unitInfo")

  const CATEGORY_SELECTOR_MAP = {
    1: '[da-id="residential-card"]',
    2: '[da-id="commercial-card"]',
  }

  const selector = CATEGORY_SELECTOR_MAP[propertyCategory.id]
  if (!selector) throw new Error(`Unsupported property category ID: ${propertyCategory.id}`)

  await runStep("Wait for property category tiles", async () => {
    await page.waitForSelector(".hui-selection-tile", { visible: true, timeout: 15000 })
  })

  const isSelected = await page.$eval(selector, el => el.classList.contains("selected"))

  if (!isSelected) {
    await runStep(`Select ${propertyCategory.name}`, async () => {
      await page.click(selector)
      log(`Property category clicked: ${propertyCategory.name}`)
    })
  } else {
    log(`Property category already selected: ${propertyCategory.name}`)
  }
}

// Press transaction type button (Sale or Rent)
const selectTransactionType = async (page, unitInfo) => {
  const transactionTypeId = unitInfo?.type
  if (!transactionTypeId) throw new Error("unitInfo.type missing")

  // Map IDs to da-id selectors
  const TYPE_SELECTOR_MAP = {
    1: '[da-id="sale-card"]',
    2: '[da-id="rent-card"]',
  }

  // Map IDs to human-readable names
  const TYPE_NAME_MAP = {
    1: 'Sale',
    2: 'Rent',
  }

  const selector = TYPE_SELECTOR_MAP[transactionTypeId]
  const typeName = TYPE_NAME_MAP[transactionTypeId]

  if (!selector) throw new Error(`Unsupported transaction type ID: ${transactionTypeId}`)

  // Wait for the button container to appear
  await runStep("Wait for transaction type tiles", async () => {
    await page.waitForSelector(".hui-selection-tile", { visible: true, timeout: 15000 })
  })

  // Check if already selected
  const isSelected = await page.$eval(selector, el => el.classList.contains("selected"))

  if (!isSelected) {
    await runStep(`Select transaction type: ${typeName}`, async () => {
      await page.evaluate(sel => {
        document.querySelector(sel).scrollIntoView({ behavior: "smooth", block: "center" })
      }, selector)
      await page.click(selector)
      log(`Transaction type button clicked: ${typeName}`)
    })
  } else {
    log(`Transaction type already selected: ${typeName}`)
  }
}

// Bedroom increment function
async function setBedrooms(page, unitInfo) {
  const bedroomRow = unitInfo.rooms?.find(r => r.room_type === 'bedroom');
  const quantity = bedroomRow?.quantity ?? 0;

  // Minimum 1 click even if no bedroom row exists
  const totalClicks = Math.max(1, quantity + 1); // first click: "Select" -> 0

  const selector = 'button[da-id="bedrooms-increment"]';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  for (let i = 0; i < totalClicks; i++) {
    await page.click(selector);
    console.log(`Clicked + for bedroom ${i + 1} / ${totalClicks}`);
    await new Promise((res) => setTimeout(res, 250)); // human-like delay
  }
}

// Bathroom increment function
async function setBathrooms(page, unitInfo) {
  const bathroomRow = unitInfo.rooms?.find(r => r.room_type === 'bathroom');
  const quantity = bathroomRow?.quantity ?? 0;

  // Minimum 1 click even if no bathroom row exists
  const totalClicks = Math.max(1, quantity + 1);

  const selector = 'button[da-id="bathrooms-increment"]';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  for (let i = 0; i < totalClicks; i++) {
    await page.click(selector);
    console.log(`Clicked + for bathroom ${i + 1} / ${totalClicks}`);
    await new Promise((res) => setTimeout(res, 250)); // human-like delay
  }
}

// Wrap usage in async function
async function fillRooms(page, unitInfo) {
  await setBedrooms(page, unitInfo);
  await setBathrooms(page, unitInfo);
}

//set number of tenants
async function setNumberOfTenants(page, tenants = 0) {
  // Ensure we have a number
  const quantity = typeof tenants === "number" ? tenants : 0;

  // Total clicks: quantity + 1 (always one extra click)
  const totalClicks = Math.max(1, quantity + 1);

  // Selector for the decrement button
  const selector = 'button[da-id="maximum-tenants-decrement"]';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  for (let i = 0; i < totalClicks; i++) {
    await page.click(selector);
    console.log(`Clicked tenant decrement ${i + 1} / ${totalClicks}`);
    await new Promise((res) => setTimeout(res, 250)); // human-like delay
  }
}

async function selectUnitType(page, unitTypeFromDB) { //intermediate, corner lot, etc...
  // 1. Find the correct dropdown container by da-id
  const dropdownContainerSelector = 'div.hui-select[da-id="property-unit-type-input-dropdown"]'
  await page.waitForSelector(dropdownContainerSelector, { visible: true, timeout: 5000 })

  // 2. Find the toggle button *inside* that container
  const dropdownToggle = await page.$(`${dropdownContainerSelector} .hui-select__toggle`)
  if (!dropdownToggle) throw new Error('Unit type dropdown toggle not found!')

  // 3. Click the toggle to open the menu
  await dropdownToggle.click()

  // 4. Wait for the menu to appear (ul with class "show" inside the container)
  const menuItemSelector = `${dropdownContainerSelector} ul.hui-select__menu.show a.dropdown-item p`
  await page.waitForSelector(menuItemSelector, { visible: true, timeout: 5000 })

  // 5. Get all menu items
  const menuItems = await page.$$(menuItemSelector)
  if (!menuItems || menuItems.length === 0) throw new Error('No dropdown items found!')

  // 6. Try to click the closest match
  let clicked = false
  for (const item of menuItems) {
    const text = await item.evaluate(el => el.textContent.trim())
    console.log("Dropdown item found:", text)  // debug log
    if (text.toLowerCase().includes(unitTypeFromDB.toLowerCase().trim())) {
      await item.click()
      clicked = true
      break
    }
  }

  // 7. Fallback: click "Prefer not to say" if no match
  if (!clicked) {
    for (const item of menuItems) {
      const text = await item.evaluate(el => el.textContent.trim())
      if (text === 'Prefer not to say') {
        await item.click()
        clicked = true
        break
      }
    }
  }

  if (!clicked) console.warn('No suitable unit type found; dropdown remains unchanged.')
}

//select direction 
async function selectDirection(page, unitInfo) {
  if (!unitInfo.direction) {
    console.warn("No direction found in unitInfo");
    return;
  }

  const dropdownContainerSelector = 'div.hui-select[da-id="direction-input-dropdown"]';
  await page.waitForSelector(dropdownContainerSelector, { visible: true, timeout: 5000 });

  // Open the dropdown
  const dropdownToggle = await page.$(`${dropdownContainerSelector} .hui-select__toggle`);
  if (!dropdownToggle) {
    console.warn("Direction dropdown toggle not found");
    return;
  }
  await dropdownToggle.click();

  // Wait for menu items
  const menuItemSelector = `${dropdownContainerSelector} ul.hui-select__menu.show a.dropdown-item p`;
  await page.waitForSelector(menuItemSelector, { visible: true, timeout: 5000 });

  const menuItems = await page.$$(menuItemSelector);
  // Normalize target: remove hyphens, spaces, to lowercase
  const targetDirection = unitInfo.direction.trim().toLowerCase().replace(/[- ]/g, '');

  let clicked = false;
  for (const item of menuItems) {
    const rawText = await item.evaluate(el => el.textContent.trim());
    // Normalize option text: remove hyphens, spaces, to lowercase
    const normalizedOption = rawText.toLowerCase().replace(/[- ]/g, '');

    if (normalizedOption === targetDirection) {
      await item.click();
      clicked = true;
      console.log(`Direction set to: ${rawText} (matched from '${unitInfo.direction}')`);
      break;
    }
  }

  if (!clicked) {
    console.warn(`Direction '${unitInfo.direction}' not found in dropdown options.`);
  }
}

//select room type, rent a room specific 
async function selectRoomType(page, roomType) {
  if (!roomType) {
    console.warn("No room type found in unitInfo");
    return;
  }

  const dropdownContainerSelector =
    'div.hui-select[da-id="room-type-input-dropdown"]';

  await page.waitForSelector(dropdownContainerSelector, {
    visible: true,
    timeout: 5000
  });

  // Open the dropdown
  const dropdownToggle = await page.$(
    `${dropdownContainerSelector} .hui-select__toggle`
  );

  if (!dropdownToggle) {
    console.warn("Room type dropdown toggle not found");
    return;
  }

  await dropdownToggle.click();
  await delay(300);

  // Select option by visible text
  const optionClicked = await page.evaluate(roomType => {
    const options = Array.from(
      document.querySelectorAll(
        '[da-id="room-type-input-dropdown"] .dropdown-item'
      )
    );

    const normalized = roomType.toLowerCase();

    const match = options.find(opt =>
      opt.innerText.toLowerCase().includes(normalized)
    );

    if (!match) return false;

    match.scrollIntoView({ block: "center" });
    match.click();
    return true;
  }, roomType);

  if (!optionClicked) {
    console.warn(`Room type option not found: ${roomType}`);
    return;
  }

  console.log(`Room type selected: ${roomType}`);
}

//input room size rent a room specific
async function inputRoomSize(page, unitInfo) {
  if (!unitInfo.room_size) {
    console.warn("No room size provided, skipping input");
    return;
  }

  const inputSelector = 'div[da-id="room-size-input"] input#roomSize';
  await page.waitForSelector(inputSelector, { visible: true, timeout: 5000 });

  // Convert remove decimal part
  const sqftInt = Math.floor(Number(unitInfo.room_size));

  await page.type(inputSelector, String(sqftInt), { delay: 100 });
  console.log(`[ROOM] Room size entered: ${sqftInt} sqft`);
}

//set builtup sqft
async function setBuiltUpSize(page, unitInfo) {
  if (!unitInfo.sqft) {
    console.warn("No built-up size (sqft) found in unitInfo");
    return;
  }

  const selector = 'input#floorSize';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  // Convert remove decimal part
  const sqftInt = Math.floor(Number(unitInfo.sqft));


  // Type the value from unitInfo.sqft
  await page.type(selector, String(sqftInt), { delay: 100 });

  console.log(`Set built-up size to: ${sqftInt}`);
}

// parking button
async function setParking(page, unitInfo) {
  const rawParking = unitInfo.parking_spot;

  if (rawParking === undefined || rawParking === null || rawParking === '') {
    console.warn("No parking info found in unitInfo");
    return;
  }

  const parkingVal = parseInt(rawParking, 10);
  if (isNaN(parkingVal) || parkingVal < 0) {
    console.warn(`Invalid parking value: ${rawParking}`);
    return;
  }

  const btnSelector = 'button[da-id="parking-increment"]';

  try {
    await page.waitForSelector(btnSelector, { visible: true, timeout: 5000 });
  } catch {
    console.warn("Parking increment button not found within timeout");
    return;
  }

  // UI flow: Select -> 0 -> 1 -> 2 ...
  // To reach "parkingVal", need to click (parkingVal + 1) times
  const clicks = parkingVal + 1;
  console.log(`Setting parking spots to ${parkingVal}, clicking ${clicks} times`);

  for (let i = 0; i < clicks; i++) {
    await page.click(btnSelector);
    await delay(300);
  }
}

//furnishing status
async function setFurnishingStatus(page, unitInfo) {
  if (!unitInfo.furnish_status) {
    console.warn("No furnish_status found in unitInfo");
    return;
  }

  const FURNISH_MAP = {
    fully: 'furnishing-FULL',
    partially: 'furnishing-PART',
    unfurnished: 'furnishing-UNFUR',
  }

  const normalized = unitInfo.furnish_status.trim().toLowerCase()
  const daId = FURNISH_MAP[normalized]

  if (!daId) {
    console.warn('Unknown furnish_status:', unitInfo.furnish_status)
    return
  }

  const selector = `label[da-id="${daId}"]`
  await page.waitForSelector(selector, { visible: true, timeout: 5000 })

  const label = await page.$(selector)
  if (!label) {
    console.warn('Label not found for da-id:', daId)
    return
  }

  await label.click()
  console.log(`Furnishing status set to: ${normalized}`)
}

//allowed gender rent a room specific
async function setAllowedGender(page, gender) {
  if (!gender) {
    console.warn("No allowed gender in unitInfo, skipping");
    return;
  }

  const dropdownSelector = 'div.hui-select[da-id="allowed-tenant-gender-input-dropdown"]';
  await page.waitForSelector(dropdownSelector, { visible: true, timeout: 5000 });

  // Open the dropdown
  const toggle = await page.$(`${dropdownSelector} .hui-select__toggle`);
  if (!toggle) {
    console.warn("Allowed gender dropdown toggle not found");
    return;
  }
  await toggle.click();
  await delay(300); // small human-like pause

  // Click the option that matches the gender
  const options = await page.$$(`${dropdownSelector} ul.dropdown-menu a.dropdown-item p`);
  let clicked = false;
  for (const option of options) {
    const text = await (await option.getProperty("innerText")).jsonValue();
    if (text.trim().toLowerCase() === gender.trim().toLowerCase()) {
      await option.click();
      console.log(`Selected allowed gender: ${text}`);
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    console.warn(`Allowed gender option "${gender}" not found, skipping`);
  }
}

// enter rental price 
async function setRentalPrice(page, unitInfo) {
  if (!unitInfo.asking_price) {
    console.warn("No asking_price found in unitInfo");
    return;
  }

  const selector = 'input#sellingPrice';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  // Convert 2500.00 → 2500
  const priceInt = Math.floor(Number(unitInfo.asking_price));

  // Clear existing value (important for controlled inputs)
  await page.evaluate(sel => {
    const input = document.querySelector(sel);
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);

  // Type integer rental price
  await page.type(selector, String(priceInt), { delay: 120 });

  console.log(`Set rental price to: ${priceInt}`);
}

//input headline
async function setHeadline(page, unitInfo) {
  // Find headline description
  const headlineRow = unitInfo.descriptions?.find(
    d => d.type === 'headline'
  );

  if (!headlineRow?.description) {
    console.warn('No headline description found');
    return;
  }

  const selector = 'textarea#headline';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  // Clear existing text (important)
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  // Type headline (trim to 70 chars just in case)
  const text = headlineRow.description.trim().slice(0, 70);
  await page.type(selector, text, { delay: 30 });

  console.log(`Headline set: ${text}`);
}

//input description
async function setPropertyDescription(page, unitInfo) {
  const descRow = unitInfo.descriptions?.find(
    d => d.type === 'subsale_description'
  );

  if (!descRow?.description) {
    console.warn('No subsale_description found');
    return;
  }

  const selector = 'textarea#description';
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });

  await page.type(selector, descRow.description, { delay: 25 });

  console.log('Property description filled');
}

// Handle "New Feature" modal (auto-tagging etc)
async function handleNewFeatureModal(page) {
  await runStep("Handle New Feature Modal", async () => {
    try {
      // Wait for modal using multiple potential selectors
      // We check for visibility by ensuring offsetWidth > 0 or class 'show' is present
      await page.waitForFunction(() => {
        const el = document.querySelector('[da-id="new-feature-modal"]') ||
          document.querySelector('.new-feature-modal.modal.show');
        return el && (el.offsetWidth > 0 || el.offsetHeight > 0 || window.getComputedStyle(el).display !== 'none');
      }, { timeout: 8000 });

      log('New feature modal detected');

      // Give it a split second to render buttons
      await delay(1000);

      await page.evaluate(() => {
        const continueBtn = document.querySelector('[da-id="new-feature-modal-continue-button"]');
        const closeBtn = document.querySelector('[da-id="modal-close-button"]');

        if (continueBtn) {
          continueBtn.click();
          console.log('Clicked "Got it" button');
        } else if (closeBtn) {
          closeBtn.click();
          console.log('Clicked close button');
        } else {
          // Fallback: try to click any primary button in the modal
          const modal = document.querySelector('[da-id="new-feature-modal"]') || document.querySelector('.new-feature-modal');
          const btn = modal?.querySelector('.btn-primary');
          if (btn) {
            btn.click();
            console.log('Clicked primary button (fallback)');
          }
        }
      });

      // Wait for modal to disappear
      await page.waitForFunction(() => {
        const el = document.querySelector('[da-id="new-feature-modal"]') ||
          document.querySelector('.new-feature-modal.modal.show');
        return !el || el.offsetParent === null;
      }, { timeout: 3000 }).catch(() => { });

    } catch (e) {
      log('No new feature modal appeared (or timed out waiting for it)');
    }
  });
}

// Upload images from subsale_contents
async function uploadImages(page, unitInfo) {
  await runStep("Upload images", async () => {
    const contents = unitInfo.contents || unitInfo.subsale_contents; // Fallback for safety
    if (!contents) {
      console.log("No contents/subsale_contents found");
      return;
    }

    // Extract URLs
    let imageUrls = [];
    if (Array.isArray(contents)) {
      // Prefer type='property_image' if present, else just take urls
      const propImages = contents.filter(c => c.type === 'property_image' && c.cloud_url);
      if (propImages.length > 0) {
        imageUrls = propImages.map(c => c.cloud_url);
      } else {
        // Fallback for simple array of objects or strings
        imageUrls = contents.map(c => typeof c === 'string' ? c : c.url || c.cloud_url).filter(url => url);
      }
    } else if (typeof contents === 'string') {
      imageUrls.push(contents);
    }

    console.log("Image URLs:", imageUrls);

    if (imageUrls.length === 0) {
      console.log("No image URLs found to upload");
      return;
    }

    const tmpDir = path.join(__dirname, "tmp_uploads");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const filesToUpload = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const ext = path.extname(url).split('?')[0] || '.jpg';
      const filePath = path.join(tmpDir, `upload_${Date.now()}_${i}${ext}`);

      try {
        console.log(`Downloading image: ${url}`);
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream'
        });

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(filePath);
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        filesToUpload.push(filePath);
      } catch (err) {
        console.error(`Failed to download image ${url}:`, err.message);
      }
    }

    if (filesToUpload.length > 0) {
      try {
        const uploadBtnSelector = 'button[da-id="upload-images-card"]';
        await page.waitForSelector(uploadBtnSelector, { visible: true, timeout: 10000 });

        console.log("Clicking upload button and waiting for file chooser...");
        const [fileChooser] = await Promise.all([
          page.waitForFileChooser(),
          page.click(uploadBtnSelector),
        ]);

        await fileChooser.accept(filesToUpload);
        console.log(`Uploaded ${filesToUpload.length} images`);

        // Wait for upload to likely complete
        await delay(5000);
      } catch (e) {
        console.error("Error during file upload:", e);
      }
    }

    // Cleanup local files
    for (const file of filesToUpload) {
      try { fs.unlinkSync(file); } catch (e) { }
    }
    try { fs.rmdirSync(tmpDir); } catch (e) { }
  });
}

// Helper to click next button
const clickNextButton = async (page) => {
  await runStep("Click Next button", async () => {
    const nextSelector = 'button[da-id="footer-next-button"]';
    await page.waitForSelector(nextSelector, { visible: true, timeout: 10000 });
    await page.click(nextSelector);
    log("Clicked Next button");
  });
}

const uncheckIProp = async (page) => {
  const ippCheckboxSelector = 'label[da-id="ipp-posting-plan-card"] input[type="checkbox"]';
  await page.waitForSelector(ippCheckboxSelector, { visible: true });
  const isChecked = await page.$eval(ippCheckboxSelector, el => el.checked);
  if (isChecked) {
    await page.click(ippCheckboxSelector);
    console.log("Unchecked iProperty posting plan");
  } else {
    console.log("iProperty posting plan already unchecked");
  }
}

const clickPostNow = async (page) => {
  const postNowSelector = 'button[da-id="footer-post-now-button"]';
  await page.waitForSelector(postNowSelector, { visible: true, timeout: 10000 });
  await page.evaluate(selector => {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
    }
  }, postNowSelector);
  console.log('"Post now" button clicked via evaluate');
}


module.exports = {
  log,
  runStep,
  getArgValue,
  sanitizeId,
  REQUEST_IGNORES,
  randomDelay,
  randomMouseMove,
  checkAndPauseIfCaptcha,
  loadAgents,
  delay,
  isLoginPage,
  normalize,
  selectPropertyCategory,
  selectTransactionType,
  setBedrooms,
  setBathrooms,
  fillRooms,
  selectUnitType,
  selectDirection,
  setBuiltUpSize,
  setParking,
  setFurnishingStatus,
  setRentalPrice,
  setHeadline,
  setPropertyDescription,
  handleNewFeatureModal,
  uploadImages,
  clickNextButton,
  uncheckIProp,
  clickPostNow,
  performLogin,
  clickCreateListing,
  selectRentingOption,
  selectImmediateDate,
  typePropertyName,
  selectFirstPropertyFromDropdown,
  selectTitleType,
  selectRoomType,
  inputRoomSize,
  setNumberOfTenants,
  setAllowedGender
}

// Login function
async function performLogin(page, options, requestedAgentId) {
  log("Login required for agent:", requestedAgentId)
  await runStep("Human mouse pre-login", async () => randomMouseMove(page, { moves: 1 }))
  const emailSelector = 'input[name="username"]'
  const passwordSelector = 'input[name="password"]'

  const loginEmail = options.email || process.env.PG_EMAIL
  const loginPassword = options.password || process.env.PG_PASSWORD

  log("agentName: ", loginEmail)
  log("password: ", loginPassword)

  if (!loginEmail || !loginPassword) throw new Error("Missing PropertyGuru login email/password")



  await runStep("Type email", async () => page.type(emailSelector, loginEmail, { delay: 120 }))
  await runStep("Type password", async () => page.type(passwordSelector, loginPassword, { delay: 200 }))

  await runStep("Submit login", async () => {
    const loginBtn = await page.$('button[type="submit"], input[type="submit"]')
    if (!loginBtn) throw new Error("Login button not found")
    await Promise.all([
      page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle2"] }),
      loginBtn.click()
    ])
    log("login button clicked?", "yes")
  })

  await runStep("Wait for Auth Redirect", async () => {
    try {
      await page.waitForFunction(
        () => window.location.href.includes("agentnet.propertyguru.com.my"),
        { timeout: 60000, polling: 1000 }
      )
    } catch (_) {
      await page.goto("https://agentnet.propertyguru.com.my/v2/dash", { waitUntil: ["domcontentloaded", "networkidle2"] })
    }
  })
}

// Click Create Listing
async function clickCreateListing(page) {
  const targetSelector = "#dashboard > div.jss10.jss3 > div > div:nth-child(2) > div.jss34 > div > span > a"
  const button = await runStep("Wait for target button", async () => page.waitForSelector(targetSelector, { timeout: 30000 }))
  log(`x log 10 : found create listing button`);
  await runStep("Click Create Listing button", async () => {
    log(`x log 10-1 : try to click create listing button`);
    try {
      return Promise.all([
        // page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle2"] }),
        page.waitForFunction(() =>
          window.location.href.includes("create-listing"),
          { timeout: 30000 }
        ),
        button.click()
      ])
    } catch (err) {
      log(`x log 10-2 : click Creating Listing Error ${err}`);
      return false;
    }
  }

  )
}

// Select Renting Option
async function selectRentingOption(page, unitInfo) {
  await runStep("Select renting option", async () => {
    const rentingOpt = unitInfo.renting_opt
    const RENTING_SELECTOR_MAP = {
      0: '[da-id="room-only-card"]',   // Room Only
      1: '[da-id="entire-unit-card"]', // Entire Unit
    }

    const selector = RENTING_SELECTOR_MAP[rentingOpt]
    if (!selector) throw new Error(`Unsupported renting option: ${rentingOpt}`)

    await page.waitForSelector(selector, { visible: true, timeout: 10000 })

    const isSelected = await page.$eval(selector, el => el.classList.contains("selected"))

    if (!isSelected) {
      await page.evaluate(sel => {
        const el = document.querySelector(sel)
        el.scrollIntoView({ behavior: "smooth", block: "center" })
      }, selector)

      await page.click(selector)
      log(`Clicked renting option: ${rentingOpt === 0 ? "Room Only" : "Entire Unit"}`)
    } else {
      log(`Renting option already selected: ${rentingOpt === 0 ? "Room Only" : "Entire Unit"}`)
    }
  })
}

// Select Immediate Date
async function selectImmediateDate(page) {
  await runStep("Select datetime", async () => {
    const selector = '[da-id="immediately-card"]';

    await page.waitForSelector(selector, { visible: true, timeout: 10000 });

    const isSelected = await page.$eval(selector, el => el.classList.contains("selected"));

    if (!isSelected) {
      await page.evaluate(sel => {
        const el = document.querySelector(sel);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, selector);

      await page.click(selector);
      log("Clicked Immediately button");
    } else {
      log("Immediately button already selected");
    }
  })
}

// Type Property Name
async function typePropertyName(page, unitInfo) {
  await runStep("Type property name", async () => {
    if (!unitInfo?.name) throw new Error("unitInfo.name missing")

    const inputSelector = 'input.location-search__input'

    // Wait for the input to appear
    await page.waitForSelector(inputSelector, { visible: true, timeout: 10000 })

    // Type the property name
    await page.type(inputSelector, unitInfo.name, { delay: 100 })

    log(`Typed property name: ${unitInfo.name}`)
  })
}

// Select First Property From Dropdown
async function selectFirstPropertyFromDropdown(page) {
  await runStep("Select first property from dropdown", async () => {
    const dropdownItemSelector = 'div.location-search__menu-item-description'

    // Wait for dropdown items
    await page.waitForSelector(dropdownItemSelector, {
      visible: true,
      timeout: 10000
    })

    // Click the first item
    await page.evaluate(sel => {
      const firstItem = document.querySelector(sel)
      if (!firstItem) throw new Error("No dropdown items found")
      firstItem.scrollIntoView({ behavior: "smooth", block: "center" })
      firstItem.click()
    }, dropdownItemSelector)

    log("Selected first property from dropdown")
  })
}

// Select Title Type
async function selectTitleType(page, unitInfo) {
  if (!unitInfo || !unitInfo.title) {
    console.warn("No title provided in unitInfo, skipping Title Type selection");
    return; // Early return
  }

  const TITLE_MAP = {
    individual: 'titleType-I',
    strata: 'titleType-S',
    master: 'titleType-M',
  }

  const normalizedTitle = unitInfo.title.toLowerCase();
  const daId = TITLE_MAP[normalizedTitle];

  if (!daId) {
    console.warn(`No mapping found for title: ${unitInfo.title}, skipping`);
    return; // Early return
  }

  const label = await page.$(`label[da-id="${daId}"]`);
  if (!label) {
    console.warn(`Label not found for da-id: ${daId}, skipping`);
    return; // Early return
  }

  await label.click();
  console.log(`Clicked Title Type label for da-id: ${daId}`);
}

