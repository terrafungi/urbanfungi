import { Telegraf } from "telegraf";
import http from "http";

const bot = new Telegraf(process.env.BOT_TOKEN);

const WEBAPP_URL = process.env.WEBAPP_URL;
const BANNER_URL = process.env.BANNER_URL;
const WHATSAPP_URL = process.env.WHATSAPP_URL || "https://example.com";

bot.start(async (ctx) => {
  await ctx.replyWithPhoto(
    { url: BANNER_URL },
    {
      caption:
        "🍄 UrbanFungi — Menu\n\n" +
        "Ouvrez le catalogue directement dans Telegram 🍄\n\n" +
        "– Champignons , DMT , Ketamine , Rachacha , LSD , 2cb 🍄 \n\n" +
        "📦 Livraison rapide\n" +
        "💬 Support disponible",
reply_markup: {
  inline_keyboard: [
    [
      { text: "🌐 Site officiel", url: "https://68d7d0bf71f65.site123.me/" }
    ],
    [
      { text: "🏷️ Tuto fabrication étiquette", url: "https://68d7d0bf71f65.site123.me/#section-68d7fb68e94b7" }
    ],
    [
      { text: "🥔 Potatoes", url: "https://dympt.org/joinchat/sAKC0NuynA1oWfPLQhnw4Q" },
      { text: "🔐 Signal", url: "https://signal.me/" }
    ],
    [
      { text: "📢 Telegram", url: "https://t.me/+u90WfR2JcaQ3Y2Zk" }
    ],
    [
      { text: "💬 Contact Telegram", url: "@urbfungi" }
    ]
  ]
}

  );
});

// --- WEBHOOK + serveur pour Render ---
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram-webhook";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`
  : null;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", async () => {
      try {
        await bot.handleUpdate(JSON.parse(data));
      } catch (e) {
        console.error("handleUpdate error:", e);
      }
      res.writeHead(200);
      res.end("OK");
    });
  } else {
    res.writeHead(200);
    res.end("UrbanFungi bot is running ✅");
  }
});

server.listen(PORT, async () => {
  console.log(`HTTP server listening on ${PORT}`);
  if (WEBHOOK_URL) {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Webhook set ✅", WEBHOOK_URL);
  } else {
    console.log("No RENDER_EXTERNAL_URL found ❌");
  }
});
