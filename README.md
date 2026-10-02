# SubsGigs Campaign Monitor & Auto-Reserver Bot 🚀

This automated bot continuously monitors [SubsGigs](https://subsgigs-alpha.vercel.app), automatically secures a spot for you the second a new campaign or open spot drops, and immediately sends an alert to your phone.

---

## ⚡ How It Works

1. **Auto-Login & Session Persistence:** Logs into SubsGigs using your credentials and stores your session securely in `chrome_session/`.
2. **Real-time Monitoring:** Continuously scans the live campaign feed for new campaigns or newly available spots.
3. **Instant Auto-Reserve:** When an open spot is detected, the bot **immediately clicks "Save a spot"** before alerting you. This holds your spot for 10 minutes!
4. **Push Notification:** Sends a push notification with the campaign title, reward amount, reservation status, and direct link so you can submit your proofs before the 10-minute timer runs out.

---

## 📲 How to Receive Notifications

You can receive alerts through **any** of the following options (or all of them at once!):

### Option 1: WhatsApp via Twilio (Instant WhatsApp Alert)
1. Sign up or log into [Twilio Console](https://console.twilio.com).
2. Copy your **Account SID** and **Auth Token** from the dashboard.
3. In Twilio, navigate to **Messaging** ➔ **Try it out** ➔ **Send a WhatsApp message** (Twilio Sandbox).
4. Follow the prompt to connect your personal WhatsApp: send the sandbox join keyword (e.g. `join <unique-code>`) to `+1 415 523 8886` from your phone.
5. In your `.env` file, configure:
   ```env
   TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   TWILIO_AUTH_TOKEN=your_auth_token_here
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   TWILIO_WHATSAPP_TO=+234XXXXXXXXXX   # (your phone number with international country code)
   ```

---

### Option 2: Mobile Push via ntfy.sh (Zero-setup alternative)
1. Download the free **ntfy** app on your phone ([iOS App Store](https://apps.apple.com/app/ntfy/id1625396347) / [Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Open the app and tap **Subscribe to topic**.
3. Type a unique topic name, for example: `subsgigs_alert_balto_spot`.
4. In your `.env` file, set:
   ```env
   NTFY_TOPIC=subsgigs_alert_balto_spot
   ```
5. Done! You will receive high-priority alerts with sound on your phone.

---

### Option 2: Telegram Bot (Instant Push to Phone & PC)
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`, choose a name and username for your bot.
3. Copy the **HTTP API Token** (e.g. `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Search for `@userinfobot` on Telegram and send `/start` to get your **Id** (e.g. `987654321`).
5. In `.env`, set:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   TELEGRAM_CHAT_ID=987654321
   ```

---

### Option 3: Discord Webhook
1. In your Discord server, go to **Channel Settings** ➔ **Integrations** ➔ **Webhooks** ➔ **New Webhook**.
2. Click **Copy Webhook URL**.
3. In `.env`, set:
   ```env
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

---

## ⚙️ Configuration (`.env`)

Edit `/home/kadiri-emmanuel/notification/.env`:

```env
# SubsGigs Account Credentials
SUBSGIGS_USERNAME=@baltomisin10
SUBSGIGS_PASSWORD=Baltom10

# Scan Interval in seconds (default: 10)
CHECK_INTERVAL_SECONDS=10

# Notification Credentials (choose any)
NTFY_TOPIC=subsgigs_alert_balto_spot
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
```

---

## 🚀 How to Run the Bot

To start the bot in the terminal:
```bash
node bot.js
```

### Running 24/7 in the Background
To keep it running continuously in the background even if you close the terminal:
```bash
nohup node bot.js > bot.log 2>&1 &
```

To check on the logs in real time:
```bash
tail -f bot.log
```

To stop the background bot:
```bash
pkill -f "node bot.js"
```
# sub-gigs
