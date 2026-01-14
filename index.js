const express = require("express");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !WEBHOOK_BASE_URL) {
  console.error("❌ Variables d’environnement manquantes");
  process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);

// ---------- ROUTES DE BASE ----------
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- WEBHOOK ----------
const WEBHOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  console.log("📥 POST webhook reçu");
  bot.handleUpdate(req.body, res);
});

// ---------- BOT ----------
bot.start((ctx) => {
  ctx.reply(
    "🍄 UrbanFungi\n\nCliquez ci-dessous pour ouvrir la boutique.",
    {
      reply_markup: {
        keyboard: [[{ text: "🛒 Ouvrir la boutique", web_app: { url: process.env.WEBAPP_URL } }]],
        resize_keyboard: true,
      },
    }
  );
});

// 🔥 C’EST ÇA QUI MANQUAIT / BLOQUAIT
bot.on("message", async (ctx) => {
  const wad = ctx.message?.web_app_data;
  if (!wad?.data) return;

  console.log("✅ COMMANDE REÇUE :", wad.data);

  let payload;
  try {
    payload = JSON.parse(wad.data);
  } catch (e) {
    return ctx.reply("❌ Données invalides.");
  }

  await ctx.reply(
    `✅ Commande reçue\n\n💰 Total : ${payload.totalEur} €`
  );
});

// ---------- LANCEMENT ----------
app.listen(PORT, async () => {
  console.log(`🚀 HTTP listening on ${PORT}`);

  const webhookUrl = `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl);

  console.log("🔗 Webhook set →", webhookUrl);
});
