const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// 1. Automatic dependency installer on first run (especially for Bot-Hosting.net / Pterodactyl)
function ensureDependencies() {
  const nodeModulesPath = path.join(__dirname, "node_modules");
  const puppeteerPath = path.join(nodeModulesPath, "puppeteer");
  const puppeteerCorePath = path.join(nodeModulesPath, "puppeteer-core");

  if (!fs.existsSync(nodeModulesPath) || (!fs.existsSync(puppeteerPath) && !fs.existsSync(puppeteerCorePath))) {
    console.log("==========================================================================");
    console.log("  [First Run Setup] Dependencies missing! Running npm install...          ");
    console.log("==========================================================================");
    try {
      execSync("npm install", { stdio: "inherit", cwd: __dirname });
      console.log("  [First Run Setup] Dependencies installed successfully!");
    } catch (err) {
      console.error("  [First Run Setup] Error during npm install:", err.message);
    }
  }
}
ensureDependencies();

// 2. Storage cleaner: Prunes cache bloat from chrome_session to stay well under 512MB disk limits
function cleanStorage() {
  try {
    const sessionDir = path.join(__dirname, "chrome_session");
    if (fs.existsSync(sessionDir)) {
      const bloatTargets = [
        path.join(sessionDir, "component_crx_cache"),
        path.join(sessionDir, "WasmTtsEngine"),
        path.join(sessionDir, "OnDeviceHeadSuggestModel"),
        path.join(sessionDir, "Default", "Cache"),
        path.join(sessionDir, "Default", "Code Cache"),
        path.join(sessionDir, "Default", "GPUCache"),
        path.join(sessionDir, "BrowserMetrics-spare.pma")
      ];
      for (const target of bloatTargets) {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      }
    }
  } catch (e) {}
}
cleanStorage();
try {
  puppeteer = require("puppeteer");
} catch {
  puppeteer = require("puppeteer-core");
}

const { notifyAll, notifyStartup } = require("./notifier");
const http = require("http");

// Load .env
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  const config = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...vals] = trimmed.split("=");
    config[key.trim()] = vals.join("=").trim();
  }
  return config;
}

const config = { ...loadEnv(), ...process.env };
const USERNAME = config.SUBSGIGS_USERNAME || "@baltomisin10";
const PASSWORD = config.SUBSGIGS_PASSWORD || "Baltom10";
const CHECK_INTERVAL = Math.max(1, parseInt(config.CHECK_INTERVAL_SECONDS || "2", 10)) * 1000;
const BASE_URL = "https://subsgigs-alpha.vercel.app";

// Automatically resolve Chrome/Chromium executable across Linux, Docker, Pterodactyl, macOS, Windows, and Puppeteer cache
async function resolveChromePath(puppeteerModule, appConfig) {
  // 1. Explicit configuration in .env or environment variable
  const configured = appConfig.PUPPETEER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || appConfig.CHROME_PATH;
  if (configured) {
    if (fs.existsSync(configured)) {
      return configured;
    }
    console.warn(`[Chrome] Configured path '${configured}' was not found on disk. Checking system alternatives...`);
  }

  // 2. Common Linux / Docker / Pterodactyl server paths
  const linuxCandidates = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/lib/chromium/chrome",
    "/usr/lib/chromium-browser/chromium-browser",
    "/snap/bin/chromium"
  ];
  for (const candidate of linuxCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 3. Common Windows paths
  if (process.platform === "win32") {
    const winCandidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : null,
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ].filter(Boolean);

    for (const candidate of winCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 4. Common macOS paths
  if (process.platform === "darwin") {
    const macCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    ];
    for (const candidate of macCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 5. Puppeteer built-in / downloaded Chrome for Testing
  try {
    if (puppeteerModule && typeof puppeteerModule.executablePath === "function") {
      const pPath = await puppeteerModule.executablePath();
      if (pPath && fs.existsSync(pPath)) {
        return pPath;
      }
    }
  } catch (e) {}

  // 6. First-Run Auto-Installer for Bot-Hosting.net / Servers:
  // If no browser binary was found anywhere, automatically download Chrome now!
  console.log("==========================================================================");
  console.log("  [First Run Setup] Chrome browser binary is not installed!               ");
  console.log("  Automatically downloading Chrome for Testing into .cache...             ");
  console.log("  Please wait 30-60 seconds (this only happens once)...                   ");
  console.log("==========================================================================");

  try {
    execSync("npx puppeteer browsers install chrome", { stdio: "inherit", cwd: __dirname });
    if (puppeteerModule && typeof puppeteerModule.executablePath === "function") {
      const pPath = await puppeteerModule.executablePath();
      if (pPath && fs.existsSync(pPath)) {
        console.log("  [First Run Setup] Chrome installed successfully at:", pPath);
        return pPath;
      }
    }
  } catch (err) {
    console.warn("  [First Run Setup] Standard Chrome install returned an error:", err.message);
    try {
      console.log("  [First Run Setup] Trying fallback: installing chrome-headless-shell...");
      execSync("npx puppeteer browsers install chrome-headless-shell", { stdio: "inherit", cwd: __dirname });
    } catch (e) {
      console.error("  [First Run Setup] Fallback install error:", e.message);
    }
  }

  // Check again after installation
  try {
    if (puppeteerModule && typeof puppeteerModule.executablePath === "function") {
      const pPath = await puppeteerModule.executablePath();
      if (pPath && fs.existsSync(pPath)) {
        return pPath;
      }
    }
  } catch (e) {}

  // Check candidate paths again in case it got installed to one of the system paths
  for (const candidate of linuxCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Optional HTTP server for Render free web service health checks
if (process.env.PORT) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SubsGigs Monitor & Auto-Reserver is active\n");
  });
  server.listen(process.env.PORT, () => {
    console.log(`[Health-Check] HTTP server listening on port ${process.env.PORT} for Render`);
  });
}

// Prevent duplicate reservation attempts or notification spam
const claimedCampaigns = new Set();

function log(msg) {
  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] ${msg}`);
}

async function login(page) {
  log("Checking SubsGigs session...");
  try {
    await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
  } catch (err) {
    log(`Notice while checking session: ${err.message}`);
  }

  let isDashboard = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : "";
    return text.includes("CREATOR DASHBOARD") || text.includes("Log out") || text.includes("Campaigns");
  }).catch(() => false);

  if (isDashboard && !page.url().includes("/login")) {
    log("Already logged in! Session active.");
    return true;
  }

  log(`Submitting credentials for ${USERNAME}...`);
  if (!page.url().includes("/login")) {
    try {
      await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (err) {
      if (!err.message.includes("ERR_ABORTED")) {
        log(`Notice while navigating to login: ${err.message}`);
      }
    }
  }

  // Ensure login form input is present
  await page.waitForSelector("input[name=username]", { timeout: 15000 }).catch(() => {});

  // Clear inputs before typing
  await page.evaluate(() => {
    const u = document.querySelector("input[name=username]");
    const p = document.querySelector("input[name=password]");
    if (u) u.value = "";
    if (p) p.value = "";
  });

  // SubsGigs expects Twitter/X handle. Ensure clean format
  await page.type("input[name=username]", USERNAME.trim());
  await page.type("input[name=password]", PASSWORD);

  // Monitor server response
  let serverStatus = null;
  let serverErrorDigest = null;
  const onResponse = async (res) => {
    if (res.request().method() === "POST" && res.url().includes("login")) {
      serverStatus = res.status();
      try {
        const body = await res.text();
        if (body.includes("digest")) {
          const match = body.match(/"digest":\s*"([^"]+)"/);
          serverErrorDigest = match ? match[1] : "server-error";
        }
      } catch (e) {}
    }
  };
  page.on("response", onResponse);

  await page.click("button[type=submit]");

  // Poll for result up to 25 seconds (do not navigate away prematurely)
  let success = false;
  let detectedError = null;

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1000));

    // Check if redirected to dashboard/campaigns
    const currentUrl = page.url();
    if (!currentUrl.includes("/login")) {
      success = true;
      break;
    }

    // Check on-page state
    const pageState = await page.evaluate(() => {
      const btn = document.querySelector("button[type=submit]");
      const body = document.body ? document.body.innerText : "";
      const isPending = btn ? btn.innerText.includes("Please wait") || btn.disabled : false;
      const errorEl = document.querySelector('[role="alert"], [class*="error"], form p.text-red-500, form .text-rose-500');
      const errorMsg = errorEl ? errorEl.innerText.trim() : null;
      return { isPending, errorMsg, body };
    }).catch(() => ({ isPending: false, errorMsg: null, body: "" }));

    if (pageState.errorMsg) {
      detectedError = pageState.errorMsg;
      break;
    }

    // Check if session cookie appeared
    const cookies = await page.cookies();
    const hasAuthCookie = cookies.some(c => c.name.includes("session") || c.name.includes("token") || c.name.includes("auth"));
    if (hasAuthCookie) {
      success = true;
      break;
    }

    // If server responded with 500 error
    if (serverStatus === 500) {
      detectedError = `SubsGigs server responded with HTTP 500 Internal Error (digest: ${serverErrorDigest || "unknown"}). The SubsGigs backend database is currently down or unreachable.`;
      break;
    }
  }

  page.off("response", onResponse);

  // If login indicated success or redirected, verify dashboard
  if (success || !page.url().includes("/login")) {
    await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    isDashboard = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return text.includes("CREATOR DASHBOARD") || text.includes("Log out") || text.includes("Campaigns");
    }).catch(() => false);

    if (isDashboard && !page.url().includes("/login")) {
      log("Login successful! Creator Dashboard reached.");
      return true;
    }
  }

  if (detectedError) {
    log(`❌ Login failed: ${detectedError}`);
  } else if (serverStatus === 500) {
    log(`❌ SubsGigs Backend Outage: Server returned HTTP 500. The database is unreachable.`);
  } else {
    log("❌ Login verification failed. Please check credentials or check if SubsGigs server is reachable.");
  }

  return false;
}

async function scanAndClaimSpots(page) {
  // Extract all campaigns and check for active "Save a spot" buttons or open capacity
  const campaignData = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll("article"));
    const results = [];

    for (const art of articles) {
      const linkEl = art.querySelector('a[href*="/campaigns/"]');
      if (!linkEl) continue;

      const url = linkEl.href;
      const text = art.innerText.replace(/\s+/g, " ").trim();

      // Check for "Save a spot" button
      const buttons = Array.from(art.querySelectorAll("button, input[type=submit]"));
      const saveBtn = buttons.find(b => /save a spot/i.test(b.innerText));
      const hasSaveButton = !!saveBtn && !saveBtn.disabled;

      // Extract details
      const titleMatch = text.match(/([A-Z0-9& ]+)\s+(?:DIRECT SUBMISSION|LIVE)/i);
      const rewardMatch = text.match(/\$[\d\.]+/);
      const spotsMatch = text.match(/(\d+)\s*spots\s*currently\s*available/i);
      const spotsLeftCount = spotsMatch ? parseInt(spotsMatch[1], 10) : (hasSaveButton ? 1 : 0);

      // A campaign is claimable if the button is active OR spotsLeft > 0
      const isClaimable = hasSaveButton || (spotsLeftCount > 0 && /direct submission/i.test(text));

      results.push({
        url,
        title: titleMatch ? titleMatch[1].trim() : "SubsGigs Campaign",
        reward: rewardMatch ? rewardMatch[0] : "Reward",
        spots: spotsMatch ? `${spotsMatch[1]} spots available` : (isClaimable ? "Spots available" : "Full"),
        hasSaveButton: isClaimable,
        spotsCount: spotsLeftCount,
        rawText: text
      });
    }

    return results;
  });

  return campaignData;
}

async function clickSaveSpotOnCard(page, campaignUrl) {
  log(`⚡ [AUTO-RESERVE] Executing lightning reservation for: ${campaignUrl}`);
  const startTime = Date.now();

  try {
    // 1. Intercept network response to confirm Server Action in real time
    let actionConfirmed = false;
    let actionError = null;

    const onResponse = async (res) => {
      try {
        if (res.request().method() === "POST" && (res.url().includes("campaigns") || res.url().includes("subsgigs"))) {
          const body = await res.text().catch(() => "");
          if (body.includes("Spot reserved") || body.includes("success") || /reserved/i.test(body)) {
            actionConfirmed = true;
          } else if (body.includes("full") || body.includes("error") || body.includes("limit") || body.includes("claimed")) {
            actionError = body.slice(0, 120);
          }
        }
      } catch (e) {}
    };
    page.on("response", onResponse);

    // 2. Trigger reservation via native form.requestSubmit() & button click on the card
    const clickResult = await page.evaluate((targetUrl) => {
      const articles = Array.from(document.querySelectorAll("article"));
      for (const art of articles) {
        const link = art.querySelector('a[href*="/campaigns/"]');
        if (link && link.href === targetUrl) {
          const form = art.querySelector("form");
          const btn = Array.from(art.querySelectorAll("button, input[type=submit]")).find(b => /save a spot/i.test(b.innerText));
          
          if (form && typeof form.requestSubmit === "function") {
            form.requestSubmit(btn || undefined);
            return { success: true, method: "form.requestSubmit" };
          }
          if (btn && !btn.disabled) {
            btn.click();
            return { success: true, method: "button.click" };
          }
        }
      }
      return { success: false, method: "not_found" };
    }, campaignUrl);

    // 3. Fallback: If not found on card, immediately navigate to campaign detail page and submit
    if (!clickResult.success) {
      log(`⚡ Button not yet mounted on feed card. Navigating to campaign detail page...`);
      await page.goto(campaignUrl, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});

      await page.evaluate(() => {
        const form = document.querySelector('form input[name="campaignId"]')?.closest("form") || document.querySelector("form");
        const btn = Array.from(document.querySelectorAll("button")).find(b => /save a spot/i.test(b.innerText));
        if (form && typeof form.requestSubmit === "function") {
          form.requestSubmit(btn || undefined);
          return true;
        }
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });
    }

    // 4. Ultra-fast verification loop (check every 150ms up to 2.5s)
    let isReserved = false;
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 150));

      if (actionConfirmed) {
        isReserved = true;
        break;
      }

      // Check on-page text indicators
      const state = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : "";
        const alert = document.querySelector('[role="alert"]')?.innerText;
        const status = document.querySelector('[role="status"]')?.innerText;
        return {
          hasReservedText: /release my spot/i.test(body) || /10 minutes/i.test(body) || /submit your work/i.test(body) || (status && /reserved/i.test(status)),
          alert
        };
      }).catch(() => ({ hasReservedText: false, alert: null }));

      if (state.hasReservedText) {
        isReserved = true;
        break;
      }
      if (state.alert) {
        actionError = state.alert;
        break;
      }
    }

    page.off("response", onResponse);
    const elapsed = Date.now() - startTime;

    if (isReserved) {
      log(`🎉 SUCCESS: Spot SECURED in ${elapsed}ms! 10-minute hold active.`);
      return true;
    } else {
      log(`Reservation attempt finished in ${elapsed}ms. Result: ${actionError || "Spot may have been claimed by another user."}`);
      return false;
    }
  } catch (err) {
    log(`Notice during reservation: ${err.message}`);
    const body = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
    return /release/i.test(body) || /submit/i.test(body);
  }
}

async function start() {
  log("=================================================");
  log("   SubsGigs Live Monitor & Auto-Reserver Bot    ");
  log("=================================================");
  log(`Account: ${USERNAME}`);
  log(`Scan Frequency: every ${CHECK_INTERVAL / 1000}s`);

  const chromePath = await resolveChromePath(puppeteer, config);
  if (!chromePath) {
    log("==========================================================================");
    log("❌ FATAL: Chrome/Chromium browser was not found on this system!");
    log("==========================================================================");
    log("To fix this on your server:");
    log("  1. If hosting on Pterodactyl / Bot-Hosting panel (server path /home/container):");
    log("     • In your web panel, open the 'Startup' or 'Settings' tab.");
    log("     • Change 'Docker Image' to: ghcr.io/parkervcp/apps:puppeteer");
    log("     • Restart your server (Chromium is pre-installed at /usr/bin/chromium-browser).");
    log("  2. If hosting on Ubuntu / Debian VPS:");
    log("     • Run: sudo apt-get update && sudo apt-get install -y chromium-browser");
    log("  3. If using Docker / Render / Railway:");
    log("     • Use the provided Dockerfile or set PUPPETEER_EXECUTABLE_PATH.");
    log("  4. Or set PUPPETEER_EXECUTABLE_PATH in your .env file to your browser path.");
    log("==========================================================================");
    process.exit(1);
  }

  log(`Browser executable: ${chromePath}`);

  const userDataDir = path.join(__dirname, "chrome_session");
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    userDataDir,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-zygote",
      "--single-process", // Essential for 256MB RAM: collapses into 1 single OS process
      "--disable-extensions",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,OptimizationGuideModelDownloading",
      "--disable-ipc-flooding-protection",
      "--disable-notifications",
      "--disable-popup-blocking",
      "--disable-print-preview",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-gpu-shader-disk-cache",
      "--disk-cache-size=10485760", // Limit disk cache to 10MB to protect 512MB storage
      "--media-cache-size=10485760",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-pings",
      "--ignore-certificate-errors",
      "--js-flags=--max-old-space-size=96" // Limit JavaScript heap to 96MB
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Block images, media, and fonts to reduce RAM by 60MB and CPU usage by 80%
  await page.setRequestInterception(true);
  page.on("request", req => {
    const resourceType = req.resourceType();
    if (["image", "media", "font"].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const ok = await login(page);
  if (!ok) {
    await browser.close();
    process.exit(1);
  }

  log("⚡ High-speed monitor active! Scanning for campaign drops...\n");

  // Send on-start notification to WhatsApp / configured channels
  await notifyStartup(config, {
    username: USERNAME,
    intervalSeconds: CHECK_INTERVAL / 1000
  });

  let cycleCount = 0;
  while (true) {
    try {
      // High-speed reload (no artificial sleep delays!)
      await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(async () => {
        await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      });

      if (page.url().includes("/login")) {
        log("Session logged out. Re-authenticating...");
        await login(page);
        continue;
      }

      const campaigns = await scanAndClaimSpots(page);

      cycleCount = (cycleCount || 0) + 1;
      if (cycleCount % 15 === 0) {
        log(`🟢 Heartbeat: Scanning active (${campaigns.length} campaigns monitored, 0 drops detected yet)`);
      }

      // Periodically purge session cache every 100 cycles to prevent disk from filling up
      if (cycleCount % 100 === 0) {
        cleanStorage();
      }

      for (const camp of campaigns) {
        // If spots are available and we haven't already processed this campaign
        if (camp.hasSaveButton && !claimedCampaigns.has(camp.url)) {
          log(`\n🚨 DETECTED AVAILABLE SPOT ON: ${camp.title} (${camp.url})`);

          // 1. AUTO-RESERVE INSTANTLY (SUB-SECOND)
          const reserved = await clickSaveSpotOnCard(page, camp.url);

          // 2. DISPATCH NOTIFICATION IMMEDIATELY IN PARALLEL
          await notifyAll(config, {
            title: camp.title,
            reward: camp.reward,
            spots: camp.spots,
            campaignUrl: camp.url,
            reserved
          });

          // Mark as processed (auto-clear from claimedCampaigns after 10 mins)
          if (reserved) {
            claimedCampaigns.add(camp.url);
            setTimeout(() => claimedCampaigns.delete(camp.url), 10 * 60 * 1000);
          }

          // Return to campaigns feed if we navigated away
          if (!page.url().endsWith("/campaigns")) {
            await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
          }
        }
      }
    } catch (err) {
      log(`Cycle notice: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
}

start().catch(err => {
  console.error("Fatal error:", err);
});
