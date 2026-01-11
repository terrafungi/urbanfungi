// index.js (CommonJS)
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");
const WEBAPP_URL = process.env.WEBAPP_URL || "https://example.com";
const BTC_ADDRESS = process.env.BTC_ADDRESS || "bc1...";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant (Render > Environment)");
  process.exit(1);
}
if (!ADMIN_CHAT_ID) {
  console.error("❌ ADMIN_CHAT_ID manquant ou invalide (Render > Environment)");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Log erreurs Telegraf
bot.catch((err) => console.error("❌ BOT ERROR:", err));

// /start
bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi — Boutique\n\nCliquez pour ouvrir la mini-boutique :",
    Markup.inlineKeyboard([
      Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL),
    ])
  );
});

// /id pour vérifier
bot.command("id", async (ctx) => {
  await ctx.reply(`✅ Ton chat_id = ${ctx.chat.id}`);
});

// Fonction: envoyer une commande test à l'admin
async function sendTestOrder(ctx) {
  const fakeOrder = {
    id: "order_test_1",
    orderCode: "CMD-2048",
    telegramUserId: ctx.from.id,
    telegramUsername: ctx.from.username,
    items: [
      { name: "Produit Démo", variantLabel: "500 g", qty: 1, unitPriceEur: 29.9 },
    ],
    totalEur: 29.9,
  };

  const text =
    `🧾 NOUVELLE COMMANDE ${fakeOrder.orderCode}\n` +
    `Client: @${fakeOrder.telegramUsername || "inconnu"} (id ${fakeOrder.telegramUserId})\n\n` +
    `Produits:\n` +
    fakeOrder.items
      .map(
        (i) =>
          `- ${i.name} (${i.variantLabel}) x${i.qty} — ${i.unitPriceEur.toFixed(2)} €`
      )
      .join("\n") +
    `\n\nTotal: ${fakeOrder.totalEur.toFixed(2)} €\n` +
    `Paiement: BTC (manuel)\n` +
    `Adresse BTC: ${BTC_ADDRESS}\n` +
    `Statut: EN ATTENTE`;

  // Envoi MP admin + boutons
  await bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Paiement reçu", `paid:${fakeOrder.id}`)],
      [Markup.button.callback("❌ Annuler", `cancel:${fakeOrder.id}`)],
      [Markup.button.callback("📦 Marquer expédiée", `shipped:${fakeOrder.id}`)],
    ])
  );
}

// /testorder
bot.command("testorder", async (ctx) => {
  console.log("🧪 /testorder reçu de", ctx.from?.id, ctx.from?.username);
  try {
    await sendTestOrder(ctx);
    await ctx.reply("✅ Commande test envoyée à l’admin (MP).");
  } catch (err) {
    console.error("❌ sendTestOrder failed:", err);
    await ctx.reply("❌ Erreur: impossible d’envoyer la commande test (voir logs Render).");
  }
});

// Boutons admin
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  const [action, orderId] = data.split(":");

  if (action === "paid") {
    await ctx.answerCbQuery("Paiement confirmé ✅");
    await ctx.reply(`✅ Paiement reçu pour ${orderId}`);
  } else if (action === "cancel") {
    await ctx.answerCbQuery("Commande annulée ❌");
    await ctx.reply(`❌ Commande annulée : ${orderId}`);
  } else if (action === "shipped") {
    await ctx.answerCbQuery("Commande expédiée 📦");
    await ctx.reply(`📦 Commande expédiée : ${orderId}`);
  } else {
    await ctx.answerCbQuery("Action inconnue");
  }
});

// Lancement propre (supprime un webhook éventuel)
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log("✅ Bot UrbanFungi lancé (polling actif) !");
  } catch (err) {
    console.error("❌ Échec lancement bot:", err);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
