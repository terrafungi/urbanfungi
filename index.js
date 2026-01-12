require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ BOT_TOKEN ou ADMIN_CHAT_ID manquant");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// 🔹 START
bot.command("shop", async (ctx) => {
  await ctx.reply(
    "🛒 Ouvrir la boutique (mode Mini App) :",
    Markup.inlineKeyboard([
      Markup.button.webApp(
        "✅ Ouvrir la boutique",
        "https://urbanfungi-miniapp.onrender.com"
      )
    ])
  );
});

// 🔹 COMMANDE TEST (pour vérifier que le bot répond)
bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot UrbanFungi opérationnel");
});

// 🔹 LANCEMENT PROPRE
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("✅ UrbanFungi bot lancé");
  } catch (err) {
    console.error("❌ Erreur au lancement :", err);
  }
})();

// 🔹 STOP
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
