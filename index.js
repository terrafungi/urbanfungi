import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

// Variables obligatoires
const WEBAPP_URL = process.env.WEBAPP_URL;
const BANNER_URL = process.env.BANNER_URL;

// Sécurité : fallback si WhatsApp non défini
const WHATSAPP_URL = process.env.WHATSAPP_URL || "https://example.com";

bot.start(async (ctx) => {
  await ctx.replyWithPhoto(
    { url: BANNER_URL },
    {
      caption:
        "🍄 UrbanFungi — Menu\n\n" +
        "Ouvrez le catalogue directement dans Telegram 🍄\n\n" +
        "– Kits de culture 🧪\n" +
        "– Champignons gourmets 🍄\n" +
        "– Accessoires 🌱\n\n" +
        "📦 Livraison rapide\n" +
        "💬 Support disponible",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📱 Mini-App", web_app: { url: WEBAPP_URL } }
          ],
          [
            { text: "🍄 Catalogue", web_app: { url: WEBAPP_URL } }
          ],
          [
            { text: "💬 Contact", url: WHATSAPP_URL }
          ]
        ]
      }
    }
  );
});

bot.launch();
console.log("Bot lancé ✅");
