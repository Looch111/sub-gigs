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
  await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "networkidle2" });
  await new Promise(r => setTimeout(r, 1500));

  let isDashboard = await page.evaluate(() => document.body.innerText.includes("CREATOR DASHBOARD"));
  if (isDashboard) {
    log("Already logged in! Session active.");
    return true;
  }

  log(`Navigating to login and submitting credentials for ${USERNAME}...`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });
  
  // Clear inputs before typing
  await page.evaluate(() => {
    const u = document.querySelector("input[name=username]");
    const p = document.querySelector("input[name=password]");
    if (u) u.value = "";
    if (p) p.value = "";
  });

  await page.type("input[name=username]", USERNAME);
  await page.type("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");

  // Allow server action to complete
  await new Promise(r => setTimeout(r, 4500));

  await page.goto(`${BASE_URL}/campaigns`, { waitUntil: "networkidle2" });
  await new Promise(r => setTimeout(r, 1500));

  isDashboard = await page.evaluate(() => document.body.innerText.includes("CREATOR DASHBOARD"));
  if (isDashboard) {
    log("Login successful! Creator Dashboard reached.");
    return true;
  }

  log("Login verification failed. Please check your credentials in .env");
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
