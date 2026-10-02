/**
 * Notification Service
 * Supports: Telegram Bot, Discord Webhook, ntfy.sh (Mobile Push)
 */

async function sendTelegramAlert(botToken, chatId, message) {
  if (!botToken || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown"
      })
    });
    return res.ok;
  } catch (err) {
    console.error("[Notifier] Telegram error:", err.message);
    return false;
  }
}

async function sendDiscordAlert(webhookUrl, message) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: message
      })
    });
    return res.ok;
  } catch (err) {
    console.error("[Notifier] Discord error:", err.message);
    return false;
  }
}

function formatWhatsAppNumber(phone) {
  let cleaned = phone.trim().replace(/^whatsapp:/i, "").replace(/[\s\-\(\)]/g, "");
  // If Nigerian local format starting with 0 (11 digits: e.g. 09114166246, 08026571485), convert to +234
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    cleaned = "+234" + cleaned.slice(1);
  } else if (!cleaned.startsWith("+")) {
    cleaned = "+" + cleaned;
  }
  return `whatsapp:${cleaned}`;
}

async function sendWhatsAppAlert(accountSid, authToken, from, toList, message) {
  if (!accountSid || !authToken || !toList) return false;

  const numbers = (Array.isArray(toList) ? toList : toList.split(","))
    .map(n => n.trim())
    .filter(Boolean);

  if (numbers.length === 0) return false;

  const fromNum = from ? (from.startsWith("whatsapp:") ? from : `whatsapp:${from}`) : "whatsapp:+14155238886";
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const sendSingle = async (rawTo) => {
    const toNum = formatWhatsAppNumber(rawTo);
    try {
      const params = new URLSearchParams();
      params.append("From", fromNum);
      params.append("To", toNum);
      params.append("Body", message);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });

      const data = await res.json();
      if (!res.ok) {
        console.error(`[Notifier] Twilio WhatsApp error for ${toNum}:`, data.message || res.statusText);
        return false;
      }
      console.log(`[Notifier] WhatsApp alert sent successfully to ${toNum}`);
      return true;
    } catch (err) {
      console.error(`[Notifier] Twilio WhatsApp error for ${toNum}:`, err.message);
      return false;
    }
  };

  const results = await Promise.allSettled(numbers.map(sendSingle));
  return results.some(r => r.status === "fulfilled" && r.value === true);
}

async function sendNtfyAlert(topic, title, message, clickUrl) {
  if (!topic) return false;
  try {
    // Strip non-ASCII characters from headers to avoid ByteString fetch errors in Node
    const cleanTitle = title.replace(/[^\x00-\x7F]/g, "").trim() || "SubsGigs Campaign Alert";
    const headers = {
      "Title": cleanTitle,
      "Priority": "urgent",
      "Tags": "tada,alarm_clock"
    };
    if (clickUrl) {
      headers["Click"] = clickUrl;
    }
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers,
      body: message
    });
    return res.ok;
  } catch (err) {
    console.error("[Notifier] ntfy error:", err.message);
    return false;
  }
}

async function notifyAll(config, { title, reward, spots, campaignUrl, reserved }) {
  const statusHeader = reserved
    ? "🚨 [SPOT RESERVED SUCCESSFULLY!]"
    : "⚠️ [CAMPAIGN OPEN - MANUAL ACTION NEEDED]";

  const text = `${statusHeader} *${title}*\n\n` +
    `• *Reward:* ${reward || "N/A"}\n` +
    `• *Reservation Status:* ${reserved ? "✅ Spot Secured! (10-minute timer active)" : "❌ Could not auto-reserve (Spots might have filled)"}\n` +
    `• *Spots Available:* ${spots || "Open"}\n` +
    `• *Direct Link:* ${campaignUrl}\n\n` +
    `⚡ *NEXT STEP:* Click the link above right now to submit your proof/wallet before your reservation expires!`;

  console.log("\n=======================================================");
  console.log(text);
  console.log("=======================================================\n");

  const results = {};
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    results.telegram = await sendTelegramAlert(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, text);
    console.log("[Notifier] Telegram notification sent:", results.telegram ? "SUCCESS" : "FAILED");
  }
  if (config.DISCORD_WEBHOOK_URL) {
    results.discord = await sendDiscordAlert(config.DISCORD_WEBHOOK_URL, text);
    console.log("[Notifier] Discord notification sent:", results.discord ? "SUCCESS" : "FAILED");
  }
  if (config.NTFY_TOPIC) {
    results.ntfy = await sendNtfyAlert(config.NTFY_TOPIC, `${reserved ? "Spot Reserved" : "Campaign Alert"}: ${title}`, text, campaignUrl);
    console.log(`[Notifier] ntfy.sh notification sent to topic '${config.NTFY_TOPIC}':`, results.ntfy ? "SUCCESS" : "FAILED");
  }
  if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_WHATSAPP_TO) {
    results.whatsapp = await sendWhatsAppAlert(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      config.TWILIO_WHATSAPP_FROM,
      config.TWILIO_WHATSAPP_TO,
      text
    );
    console.log("[Notifier] Twilio WhatsApp notification sent:", results.whatsapp ? "SUCCESS" : "FAILED");
  }

  // Audible bell in terminal
  process.stdout.write("\x07");

  return results;
}

async function notifyStartup(config, { username, intervalSeconds }) {
  const time = new Date().toLocaleTimeString();
  const text = `🟢 *SubsGigs Bot is ONLINE*\n\n` +
    `• *Status:* Actively monitoring\n` +
    `• *Account:* ${username}\n` +
    `• *Scan Interval:* Every ${intervalSeconds}s\n` +
    `• *Started at:* ${time}\n\n` +
    `You will receive an instant alert here the second a spot is reserved!`;

  console.log("\n[Notifier] Dispatching on-start message...");

  const results = {};
  if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_WHATSAPP_TO) {
    results.whatsapp = await sendWhatsAppAlert(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      config.TWILIO_WHATSAPP_FROM,
      config.TWILIO_WHATSAPP_TO,
      text
    );
  }
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    results.telegram = await sendTelegramAlert(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, text);
  }
  if (config.DISCORD_WEBHOOK_URL) {
    results.discord = await sendDiscordAlert(config.DISCORD_WEBHOOK_URL, text);
  }
  if (config.NTFY_TOPIC) {
    results.ntfy = await sendNtfyAlert(config.NTFY_TOPIC, "SubsGigs Bot Online", text);
  }

  return results;
}

module.exports = {
  notifyAll,
  notifyStartup,
  sendTelegramAlert,
  sendDiscordAlert,
  sendNtfyAlert,
  sendWhatsAppAlert
};
