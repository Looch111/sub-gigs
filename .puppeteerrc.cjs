const { join } = require("path");

/**
 * Configure Puppeteer to store its downloaded browser inside the bot directory
 * so it works reliably in containerized hosts like Bot-Hosting.net, Pterodactyl, etc.
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
