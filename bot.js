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
const CHECK_INTERVAL = Math.max(3, parseInt(config.CHECK_INTERVAL_SECONDS || "10", 10)) * 1000;
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
  // Extract all campaigns and check for active "Save a spot" buttons
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
      const spotsMatch = text.match(/(\d+\s*spots\s*currently\s*available|\d+\s*left)/i);

      results.push({
        url,
        title: titleMatch ? titleMatch[1].trim() : "SubsGigs Campaign",
        reward: rewardMatch ? rewardMatch[0] : "Reward",
        spots: spotsMatch ? spotsMatch[0] : (hasSaveButton ? "Spots available" : "Full"),
        hasSaveButton,
        rawText: text
      });
    }

    return results;
  });

  return campaignData;
}

async function clickSaveSpotOnCard(page, campaignUrl) {
  log(`⚡ [AUTO-RESERVE] Clicking 'Save a spot' for: ${campaignUrl}`);
  try {
    const clicked = await page.evaluate((targetUrl) => {
      const articles = Array.from(document.querySelectorAll("article"));
      for (const art of articles) {
        const link = art.querySelector('a[href*="/campaigns/"]');
        if (link && link.href === targetUrl) {
          const btn = Array.from(art.querySelectorAll("button")).find(b => /save a spot/i.test(b.innerText));
          if (btn && !btn.disabled) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    }, campaignUrl);

    if (!clicked) {
      log("Could not find active 'Save a spot' button on card.");
      return false;
    }

    log("Button clicked! Waiting for server confirmation...");
    // Next.js server action may cause soft or hard navigation; wait for network to idle
    await new Promise(r => setTimeout(r, 4500));

    // Safely re-check page text on the current active frame
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const errorMsg = await page.evaluate(() => document.querySelector('[role="alert"]')?.innerText).catch(() => null);

    const isReserved =
      /release/i.test(text) ||
      /reserved/i.test(text) ||
      /submit your work/i.test(text) ||
      /10 minutes/i.test(text) ||
      !/save a spot/i.test(text); // If Save a spot button disappeared, it's either claimed or filled

    if (!errorMsg && isReserved) {
      log("🎉 SUCCESS: Spot successfully reserved for 10 minutes!");
      return true;
    } else {
      log(`Reservation response: ${errorMsg || "Spot might be claimed or limit reached."}`);
      return false;
    }
  } catch (err) {
    log(`Notice during reservation verification: ${err.message}`);
    // Check if reserved anyway
    const body = await page.evaluate(() => document.body.innerText).catch(() => "");
    return /submit/i.test(body) || /release/i.test(body);
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

  log("Monitor initialized. Listening for campaign drops...\n");

  // Send on-start notification to WhatsApp / configured channels
  await notifyStartup(config, {
    username: USERNAME,
    intervalSeconds: CHECK_INTERVAL / 1000
  });

  while (true) {
    try {
      // Reload campaigns
      await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));

      if (page.url().includes("/login")) {
        log("Session logged out. Re-authenticating...");
        await login(page);
        continue;
      }

      const campaigns = await scanAndClaimSpots(page);
      log(`Scanned ${campaigns.length} campaign(s). Status check:`);

      for (const camp of campaigns) {
        log(`  • [${camp.title}] ${camp.spots} | ${camp.reward} | Spot Button Active: ${camp.hasSaveButton}`);

        // If spots are available and we haven't already processed this campaign
        if (camp.hasSaveButton && !claimedCampaigns.has(camp.url)) {
          log(`\n🚨 FOUND AVAILABLE SPOT ON: ${camp.title} (${camp.url})`);

          // 1. SAVE THE SPOT FIRST
          const reserved = await clickSaveSpotOnCard(page, camp.url);

          // 2. DISPATCH NOTIFICATION
          await notifyAll(config, {
            title: camp.title,
            reward: camp.reward,
            spots: camp.spots,
            campaignUrl: camp.url,
            reserved
          });

          // Mark as processed
          claimedCampaigns.add(camp.url);

          // Refresh page after claim
          await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "networkidle2" });
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch (err) {
      log(`Cycle error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
}

start().catch(err => {
  console.error("Fatal error:", err);
});
