// index.js
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.catch((err, ctx) => {
  console.error("❌ BOT ERROR:", err);
});


const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const WEBAPP_URL = process.env.WEBAPP_URL || "https://example.com";
const BTC_ADDRESS = process.env.BTC_ADDRESS || "bc1...";

bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi — Boutique\n\nCliquez pour ouvrir la mini-boutique :",
    Markup.inlineKeyboard([
      Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL),
    ])
  );
});

// Commande pour vérifier l’ID
bot.command("id", async (ctx) => {
  await ctx.reply(`✅ Ton chat_id = ${ctx.chat.id}`);
});

// Test : simule une commande envoyée à l’admin
bot.command("testorder", async (ctx) => {
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

  await bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
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
      `Statut: EN ATTENTE`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Paiement reçu", `paid:${fakeOrder.id}`)],
      [Markup.button.callback("❌ Annuler", `cancel:${fakeOrder.id}`)],
      [Markup.button.callback("📦 Marquer expédiée", `shipped:${fakeOrder.id}`)],
    ])
  );

  await ctx.reply("✅ Commande test envoyée à l’admin (MP).");
});

// Boutons admin
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
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

bot.launch();
console.log("✅ Bot UrbanFungi lancé !");
