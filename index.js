// index.js (COMMONJS - compatible Render sans "type":"module")
const express = require("express");
const crypto = require("crypto");
const { Telegraf, Markup } = require("telegraf");

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // ex: https://urbanfungi-miniapp.onrender.com
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL; // ex: https://urbanfungi-tp50.onrender.com
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "azertyuiop123";
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "");
const ADMIN_USER_ID = String(process.env.ADMIN_USER_ID || "");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!WEBAPP_URL) throw new Error("Missing WEBAPP_URL");
if (!WEBHOOK_BASE_URL) throw new Error("Missing WEBHOOK_BASE_URL");

// Helpers
function genOrderId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const rnd = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `UF-${y}${m}${da}-${rnd}`;
}
function euro(n) {
  return Number(n || 0).toFixed(2);
}
function safeUserLabel(from) {
  const u = from?.username ? `@${from.username}` : `${from?.first_name || "User"}`;
  return `${u} (id:${from?.id})`;
}
function isAdmin(ctx) {
  const uid = String(ctx.from?.id || "");
  if (ADMIN_USER_ID && uid === ADMIN_USER_ID) return true;
  const chatId = String(ctx.chat?.id || "");
  return ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID;
}

// In-memory store
const orders = new Map(); // orderId -> order
const awaitingLabel = new Map(); // userId -> orderId

// Bot
const bot = new Telegraf(BOT_TOKEN);

bot.telegram.setMyCommands([
  { command: "start", description: "Ouvrir le menu" },
  { command: "shop", description: "Ouvrir la boutique" },
  { command: "ping", description: "Test bot" },
  { command: "webhook", description: "Info webhook (admin)" },
]);

function shopKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)],
  ]);
}

bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi\n\nCliquez sur le bouton ci-dessous pour ouvrir la boutique.\n\nSi le bouton disparaît : /shop",
    shopKeyboard()
  );
});

bot.command("shop", async (ctx) => {
  await ctx.reply("🛒 Boutique :", shopKeyboard());
});

bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot OK");
});

bot.command("webhook", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Réservé admin.");
  try {
    const info = await bot.telegram.getWebhookInfo();
    await ctx.reply(
      `Webhook:\nurl: ${info.url || "-"}\n` +
        `pending_update_count: ${info.pending_update_count}\n` +
        `last_error_date: ${info.last_error_date || "-"}\n` +
        `last_error_message: ${info.last_error_message || "-"}`
    );
  } catch (e) {
    await ctx.reply("Erreur webhook info.");
  }
});

// Message handler (orders + PDF)
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;

  // 1) PDF label upload
  if (msg && msg.document) {
    const userId = String(ctx.from?.id || "");
    const orderId = awaitingLabel.get(userId);

    if (!orderId) return ctx.reply("Je n'attends pas de PDF pour le moment.");

    const order = orders.get(orderId);
    if (!order || order.status !== "PAID") {
      return ctx.reply("Je n'attends pas encore le PDF (attendez la validation du paiement).");
    }

    order.status = "LABEL_RECEIVED";
    awaitingLabel.delete(userId);

    if (ADMIN_CHAT_ID) {
      await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📦 Étiquette reçue pour ${order.id}\nClient: ${order.userLabel}\nTotal: ${euro(order.totalEur)} €`
      );
      await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
    }

    await ctx.reply("✅ PDF reçu. Merci ! On s'occupe de l'expédition.");
    return;
  }

  // 2) Mini App Order via web_app_data
  if (msg && msg.web_app_data && msg.web_app_data.data) {
    try {
      const payload = JSON.parse(msg.web_app_data.data);
      if (payload?.type !== "ORDER") {
        await ctx.reply("Données reçues mais type inconnu.");
        return;
      }

      const orderId = genOrderId();
      const userId = String(ctx.from?.id || "");
      const chatId = String(ctx.chat?.id || "");
      const userLabel = safeUserLabel(ctx.from);

      const order = {
        id: orderId,
        userId,
        chatId,
        userLabel,
        totalEur: Number(payload.totalEur || 0),
        items: Array.isArray(payload.items) ? payload.items : [],
        paymentMethod: null,
        paid: false,
        status: "NEW",
        createdAt: Date.now(),
      };

      orders.set(orderId, order);

      // Client message
      await ctx.reply(
        `✅ Commande ${orderId} reçue\nTotal: ${euro(order.totalEur)} €\n\nChoisissez votre paiement :`,
        Markup.inlineKeyboard([
          [Markup.button.callback("₿ BTC", `pay:BTC:${orderId}`)],
          [Markup.button.callback("💳 Transcash", `pay:TRANSCASH:${orderId}`)],
        ])
      );

      // Admin message
      if (ADMIN_CHAT_ID) {
        const lines = order.items
          .map((i) => `• ${i.nom} x${i.qty} (${euro(i.unitPrice)}€)`)
          .join("\n");

        await ctx.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🧾 Nouvelle commande ${orderId}\nClient: ${order.userLabel}\nTotal: ${euro(order.totalEur)} €\n\n${lines || "(items)"}\n`,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Paiement OK", `admin:paid:${orderId}`)],
            [Markup.button.callback("❌ Annuler", `admin:cancel:${orderId}`)],
            [Markup.button.callback("✅ Terminer", `admin:done:${orderId}`)],
          ])
        );
      }

      return;
    } catch (e) {
      console.error("web_app_data parse error", e);
      await ctx.reply("Erreur: données commande invalides.");
      return;
    }
  }

  return next();
});

// Callback buttons
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  const parts = data.split(":");
  const a = parts[0];
  const b = parts[1];
  const orderId = parts[2];

  // client chooses payment
  if (a === "pay") {
    const method = b;
    const order = orders.get(orderId);
    if (!order) return ctx.answerCbQuery("Commande introuvable");
    if (String(ctx.from?.id || "") !== order.userId) return ctx.answerCbQuery("Pas votre commande");

    order.paymentMethod = method;
    order.status = "PAYMENT_CHOSEN";
    await ctx.answerCbQuery("OK");

    if (method === "BTC") {
      await ctx.reply(
        `₿ Paiement Bitcoin\n\nCommande: ${order.id}\nTotal: ${euro(order.totalEur)} €\n\nEnvoyez votre TXID (ou preuve) ici après paiement.\nPuis l’admin validera.`
      );
    } else {
      await ctx.reply(
        `💳 Paiement Transcash\n\nCommande: ${order.id}\nTotal: ${euro(order.totalEur)} €\n\nEnvoyez votre code Transcash + le montant exact.\nPuis l’admin validera.`
      );
    }
    return;
  }

  // admin actions
  if (a === "admin") {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Réservé admin");

    const action = b;
    const order = orders.get(orderId);
    if (!order) return ctx.answerCbQuery("Commande introuvable");

    if (action === "paid") {
      order.paid = true;
      order.status = "PAID";
      awaitingLabel.set(order.userId, order.id);

      await ctx.answerCbQuery("Paiement validé");
      await ctx.reply(`✅ Paiement validé pour ${order.id}.`);

      await ctx.telegram.sendMessage(
        Number(order.chatId),
        `✅ Paiement validé pour ${order.id}.\n\n📄 Envoyez maintenant votre étiquette PDF ici (en document).`
      );
      return;
    }

    if (action === "cancel") {
      order.status = "CANCELLED";
      awaitingLabel.delete(order.userId);
      await ctx.answerCbQuery("Annulé");
      await ctx.reply(`❌ Commande ${order.id} annulée.`);
      await ctx.telegram.sendMessage(Number(order.chatId), `❌ Votre commande ${order.id} a été annulée.`);
      return;
    }

    if (action === "done") {
      order.status = "DONE";
      awaitingLabel.delete(order.userId);
      await ctx.answerCbQuery("Terminé");
      await ctx.reply(`✅ Commande ${order.id} terminée.`);
      await ctx.telegram.sendMessage(Number(order.chatId), `✅ Votre commande ${order.id} est terminée.`);
      return;
    }
  }

  await ctx.answerCbQuery();
});

// Express webhook server
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.send("UrbanFungi bot: OK"));

app.post(`/telegraf/${WEBHOOK_SECRET}`, (req, res) => {
  return bot.webhookCallback(`/telegraf/${WEBHOOK_SECRET}`)(req, res);
});

const PORT = Number(process.env.PORT || "10000");
app.listen(PORT, "0.0.0.0", async () => {
  const webhookUrl = `${WEBHOOK_BASE_URL}/telegraf/${WEBHOOK_SECRET}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log("Webhook set →", webhookUrl);
  } catch (e) {
    console.error("Webhook set failed:", e);
  }
  console.log("HTTP listening on", PORT);
});
