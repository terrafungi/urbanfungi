import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

const WEBAPP_URL = process.env.WEBAPP_URL;
const BANNER_URL = process.env.BANNER_URL;
const WHATSAPP_URL = process.env.WHATSAPP_URL;

bot.start(async (ctx) => {
  await ctx.replyWithPhoto(
    { url: BANNER_URL },
    {
      caption:
        "🍄 UrbanFungi — Menu\n\n" +
        "Ouvrez le catalogue directement dans Telegram 🍄\n\n" +
        "– Ketamine 🧪\n" +
        "– Champignons 🍄\n" +
        "– DMT 🔥\n\n" +
        "📦 Livraison rapide\n" +
        "💬 Support disponible",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📱 Mini-App", web_app: { url: WEBAPP_URL } }],
          [
            { text: "🍄 Catalogue", web_app: { url: WEBAPP_URL } },
            { text: "💬 WhatsApp", url: WHATSAPP_URL }
          ]
        ]
      }
    }
  );
});

bot.launch();
