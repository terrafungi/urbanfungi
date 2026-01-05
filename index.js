import { Telegraf } from "telegraf";
import http from "http";

const bot = new Telegraf(process.env.BOT_TOKEN);

const WEBAPP_URL = process.env.WEBAPP_URL; // pas utilisé ici mais ok
const BANNER_URL = process.env.BANNER_URL;
const WHATSAPP_URL = process.env.WHATSAPP_URL || "https://example.com";

bot.start(async (ctx) => {
  const caption =
    "🍄 UrbanFungi — Menu\n\n" +
    "Ouvrez le catalogue directement dans Telegram 🍄\n\n" +
     "MOTS DE PASSE POUR LE SITE : Urban / \n" +
    "📦 Livraison rapide\n" +
    "💬 Support disponible";

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "🌐 Site officiel", url: "https://68d7d0bf71f65.site123.me/" }
      ],
      [
        {
          text: "🏷️ Tuto fabrication étiquette",
          url: "https://68d7d0bf71f65.site123.me/#section-68d7fb68e94b7"
        }
      ],
      [
        { text: "🥔 Potatoes", url: "https://dympt.org/joinchat/sAKC0NuynA1oWfPLQhnw4Q" },
        { text: "🔐 Signal", url: "https://signal.me/" }
      ],
      [
        { text: "📢 Telegram", url: "https://t.me/+u90WfR2JcaQ3Y2Zk" }
      ],
      [
        // IMPORTANT: url doit être une vraie URL
        { text: "💬 Contact Telegram", url: "https://t.me/urbfungi" }
      ]
    ]
  };

  // Si pas de bannière valide, on envoie du texte simple
  if (!BANNER_URL || !BANNER_URL.startsWith("http")) {
    await ctx.reply(caption, { reply_markup });
    return;
  }

  await ctx.replyWithPhoto(
    { url: BANNER_URL },
    { caption, reply_markup }
  );
});

// --- mini serveur HTTP (Render) ---
const PORT = process.env.PORT || 10000;
const WEBHOOK_PATH = "/telegram-webhook";

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

  // Render fournit souvent RENDER_EXTERNAL_URL
  const base = process.env.RENDER_EXTERNAL_URL || "";
  if (!base) {
    console.log("No RENDER_EXTERNAL_URL found ❌");
    return;
  }

  const webhookUrl = `${base}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl);
  console.log("Webhook set ✅", webhookUrl);
});
