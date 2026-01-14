// index.js (CommonJS) — compatible Render/Node sans "type":"module"
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env var");

const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "azertyuiop123";
const MINIAPP_URL = process.env.MINIAPP_URL || "https://urbanfungi-miniapp.onrender.com";

const BTC_ADDRESS = process.env.BTC_ADDRESS || "Votre adresse BTC ici";
const TRANSCASH_TEXT =
  process.env.TRANSCASH_TEXT || "Envoyez votre code Transcash + le montant exact.";

const PORT = process.env.PORT || 10000;

// Render fournit souvent RENDER_EXTERNAL_URL (ex: https://urbanfungi-tp50.onrender.com)
const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";

const bot = new Telegraf(BOT_TOKEN);

// Petite “DB” en mémoire (simple et efficace)
const orders = new Map(); // orderId -> { userId, chatId, total, items, status, createdAt }

function newOrderId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `UF-${y}${m}${day}-${hh}${mm}-${rand}`;
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function shopKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.webApp("🛒 Ouvrir la boutique", MINIAPP_URL),
  ]);
}

bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi\n\nCliquez sur le bouton ci-dessous pour ouvrir la boutique.\nSi le bouton disparaît : /shop",
    shopKeyboard()
  );
});

bot.command("shop", async (ctx) => {
  await ctx.reply("🛒 Ouvrir la boutique :", shopKeyboard());
});

bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot OK");
});

bot.command("webhook", async (ctx) => {
  const info = await bot.telegram.getWebhookInfo();
  await ctx.reply(`Webhook:\n${JSON.stringify(info, null, 2)}`);
});

/**
 * ✅ IMPORTANT: réception des données Mini App
 * Telegram envoie un message avec ctx.message.web_app_data.data
 */
bot.on("message", async (ctx, next) => {
  try {
    const wad = ctx.message?.web_app_data;
    if (!wad?.data) return next();

    console.log("WEBAPP DATA from", ctx.from?.id, wad.data);

    let payload;
    try {
      payload = JSON.parse(wad.data);
    } catch (e) {
      await ctx.reply("❌ Données Mini App invalides.");
      return;
    }

    if (payload?.type !== "ORDER" || !Array.isArray(payload?.items)) {
      await ctx.reply("❌ Format commande invalide.");
      return;
    }

    const orderId = newOrderId();

    const order = {
      orderId,
      userId: String(ctx.from.id),
      chatId: String(ctx.chat.id),
      total: Number(payload.totalEur || 0),
      items: payload.items,
      status: "PENDING_PAYMENT",
      createdAt: Date.now(),
    };

    orders.set(orderId, order);

    // Message client
    await ctx.reply(
      `✅ Commande ${orderId} reçue\nTotal: ${money(order.total)} €\n\nChoisissez votre moyen de paiement :`,
      Markup.inlineKeyboard([
        [Markup.button.callback("₿ BTC", `pay_btc:${orderId}`)],
        [Markup.button.callback("💳 Transcash", `pay_tc:${orderId}`)],
      ])
    );

    // Message admin
    if (ADMIN_CHAT_ID) {
      const lines = order.items
        .map((it) => `• ${it.qty}× ${it.nom} (${money(it.unitPrice)}€)`)
        .join("\n");

      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🧾 Nouvelle commande ${orderId}\nClient: @${ctx.from.username || "sans_username"} (${ctx.from.id})\nTotal: ${money(
          order.total
        )} €\n\n${lines}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Paiement OK", `admin_ok:${orderId}`)],
          [Markup.button.callback("❌ Annuler", `admin_cancel:${orderId}`)],
        ])
      );
    }

    return;
  } catch (e) {
    console.error("web_app_data error", e);
    await ctx.reply("❌ Erreur traitement commande.");
  }
});

/**
 * Paiement: infos client
 */
bot.action(/pay_btc:(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  await ctx.answerCbQuery();
  await ctx.reply(`Adresse BTC:\n${BTC_ADDRESS}\n\nEnvoyez le montant exact: ${money(order.total)} €`);
});

bot.action(/pay_tc:(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  await ctx.answerCbQuery();
  await ctx.reply(`${TRANSCASH_TEXT}\n\nCommande: ${orderId}\nMontant: ${money(order.total)} €`);
});

/**
 * Admin valide / annule
 */
bot.action(/admin_ok:(.+)/, async (ctx) => {
  if (ADMIN_CHAT_ID && String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) {
    return ctx.answerCbQuery("Réservé admin");
  }

  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  order.status = "PAID";
  orders.set(orderId, order);

  await ctx.answerCbQuery("Paiement validé");

  // notif admin
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [[{ text: "✅ Paiement validé", callback_data: "noop" }]],
  });

  // notif client
  await bot.telegram.sendMessage(
    order.chatId,
    `✅ Paiement validé pour ${orderId}.\n\n📄 Envoyez maintenant votre étiquette PDF ici (en document).`
  );
});

bot.action(/admin_cancel:(.+)/, async (ctx) => {
  if (ADMIN_CHAT_ID && String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) {
    return ctx.answerCbQuery("Réservé admin");
  }

  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  order.status = "CANCELLED";
  orders.set(orderId, order);

  await ctx.answerCbQuery("Annulée");
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [[{ text: "❌ Annulée", callback_data: "noop" }]],
  });

  await bot.telegram.sendMessage(order.chatId, `❌ Commande ${orderId} annulée.`);
});

/**
 * Réception PDF étiquette (document)
 * On accepte si l'utilisateur a au moins une commande PAYÉE
 */
bot.on("document", async (ctx) => {
  const userId = String(ctx.from.id);

  // trouve dernière commande payée de ce user
  const paid = Array.from(orders.values())
    .filter((o) => o.userId === userId && o.status === "PAID")
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!paid) {
    await ctx.reply("❌ Je n'attends pas encore le PDF (attendez la validation du paiement).");
    return;
  }

  // envoi admin
  if (ADMIN_CHAT_ID) {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `📦 Étiquette reçue pour ${paid.orderId} (client ${ctx.from.id}). Je transfère le PDF…`
    );
    await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id);
  }

  // confirm client
  paid.status = "LABEL_RECEIVED";
  orders.set(paid.orderId, paid);

  await ctx.reply("✅ PDF reçu ! Votre commande est en préparation. Merci 🙏");
});

// Express webhook
const app = express();
app.get("/health", (req, res) => res.json({ ok: true }));

app.post(
  `/telegraf/${WEBHOOK_SECRET}`,
  bot.webhookCallback(`/telegraf/${WEBHOOK_SECRET}`)
);

app.listen(PORT, async () => {
  console.log("HTTP listening on", PORT);

  if (!PUBLIC_URL) {
    console.log("⚠️ PUBLIC_URL missing (RENDER_EXTERNAL_URL). Webhook not set automatically.");
    return;
  }

  const url = `${PUBLIC_URL}/telegraf/${WEBHOOK_SECRET}`;
  await bot.telegram.setWebhook(url);
  console.log("Webhook set →", url);
});
