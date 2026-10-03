const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
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
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";

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

  log(`Navigating to login and submitting credentials for ${USERNAME}...`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2", timeout: 30000 });

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
    await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
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

  const userDataDir = path.join(__dirname, "chrome_session");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

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
        await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "domcontentloaded", timeout: 10000 });
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
