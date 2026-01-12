// urbanfungi-bot/index.js
require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const API_URL = (process.env.API_URL || "").replace(/\/+$/, "");
const MINIAPP_URL = process.env.MINIAPP_URL || "https://urbanfungi-miniapp.onrender.com";

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !API_URL) {
  console.error("❌ ENV manquantes : BOT_TOKEN / ADMIN_CHAT_ID / API_URL");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Stocke quel user doit envoyer une étiquette pour quelle commande
// (⚠️ mémoire volatile, mais suffisant pour MVP)
const awaitingLabel = new Map(); // userId -> orderCode

function isAdmin(ctx) {
  return Number(ctx.from?.id) === Number(ADMIN_CHAT_ID);
}

async function apiPost(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- Commandes
bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot UrbanFungi opérationnel");
});

bot.command("shop", async (ctx) => {
  await ctx.reply(
    "🛒 Ouvrir la boutique (mode Mini App) :",
    Markup.inlineKeyboard([Markup.button.webApp("✅ Ouvrir la boutique", MINIAPP_URL)])
  );
});

// ---- Gestion des boutons admin (callback_query)
bot.on("callback_query", async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery("⛔ Réservé admin", { show_alert: true });
    }

    const data = ctx.callbackQuery?.data || "";
    // Format : pay:CMD-1234:8285368651
    const [action, orderCode, userIdStr] = data.split(":");
    const userId = Number(userIdStr || 0);

    if (!orderCode) {
      return ctx.answerCbQuery("Erreur: orderCode manquant", { show_alert: true });
    }

    if (action === "pay") {
      const r = await apiPost("/api/admin-status", { orderCode, status: "PAYE" });
      if (!r.ok || !r.data?.ok) {
        console.error("admin-status PAYE failed:", r.status, r.data);
        await ctx.answerCbQuery("❌ Erreur API", { show_alert: true });
        return;
      }

      // On met le client en attente d'étiquette
      if (userId) awaitingLabel.set(userId, orderCode);

      await ctx.answerCbQuery("✅ Paiement confirmé");
      await ctx.reply(`✅ Paiement confirmé pour ${orderCode}. (client notifié)`);

      return;
    }

    if (action === "cancel") {
      const r = await apiPost("/api/admin-status", { orderCode, status: "ANNULE" });
      if (!r.ok || !r.data?.ok) {
        console.error("admin-status ANNULE failed:", r.status, r.data);
        await ctx.answerCbQuery("❌ Erreur API", { show_alert: true });
        return;
      }
      if (userId) awaitingLabel.delete(userId);

      await ctx.answerCbQuery("✅ Annulé");
      await ctx.reply(`❌ Commande annulée : ${orderCode}. (client notifié)`);
      return;
    }

    if (action === "ship") {
      const r = await apiPost("/api/admin-status", { orderCode, status: "EXPEDIE" });
      if (!r.ok || !r.data?.ok) {
        console.error("admin-status EXPEDIE failed:", r.status, r.data);
        await ctx.answerCbQuery("❌ Erreur API", { show_alert: true });
        return;
      }

      if (userId) awaitingLabel.delete(userId);

      await ctx.answerCbQuery("✅ Expédié");
      await ctx.reply(`📦 Marqué expédié : ${orderCode}. (client notifié)`);
      return;
    }

    await ctx.answerCbQuery("Action inconnue", { show_alert: true });
  } catch (err) {
    console.error("callback_query error:", err);
    try {
      await ctx.answerCbQuery("❌ Erreur bot", { show_alert: true });
    } catch {}
  }
});

// ---- Réception d’étiquette (PDF) côté client
bot.on("document", async (ctx) => {
  try {
    const userId = Number(ctx.from?.id || 0);
    const doc = ctx.message?.document;

    if (!doc) return;

    const isPdf =
      doc.mime_type === "application/pdf" ||
      (doc.file_name || "").toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return ctx.reply("📎 Merci d’envoyer un PDF (étiquette d’envoi).");
    }

    const orderCode = awaitingLabel.get(userId);

    if (!orderCode) {
      // Pas en attente → on demande le code commande
      return ctx.reply(
        "📎 J’ai bien reçu le PDF.\n\n⚠️ Indiquez votre code commande (ex: CMD-1234) en message juste après, ou renvoyez le PDF avec le code dans le nom."
      );
    }

    // Forward au support/admin
    const username = ctx.from?.username ? `@${ctx.from.username}` : "(sans username)";
    const caption =
      `📦 <b>ÉTIQUETTE D’ENVOI REÇUE</b>\n` +
      `Commande: <b>${orderCode}</b>\n` +
      `Client: ${username} (id ${userId})\n` +
      `Fichier: <code>${doc.file_name || "etiquette.pdf"}</code>`;

    await bot.telegram.sendDocument(ADMIN_CHAT_ID, doc.file_id, {
      caption,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Étiquette OK", callback_data: `labelok:${orderCode}:${userId}` }]],
      },
    });

    awaitingLabel.delete(userId);

    await ctx.reply("✅ Étiquette reçue. Merci ! Nous traitons votre commande.");
  } catch (err) {
    console.error("document handler error:", err);
    await ctx.reply("❌ Erreur lors de l’envoi. Réessayez.");
  }
});

// ---- Bouton "Étiquette OK" (optionnel, juste un accusé)
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith("labelok:")) return;

  try {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery("⛔ Réservé admin", { show_alert: true });
    }
    const [, orderCode, userIdStr] = data.split(":");
    const userId = Number(userIdStr || 0);

    await ctx.answerCbQuery("✅ Noté");

    if (userId) {
      await bot.telegram.sendMessage(
        userId,
        `✅ Étiquette reçue pour <b>${orderCode}</b>.\n📦 Merci, on prépare l’expédition.`,
        { parse_mode: "HTML" }
      );
    }
  } catch (e) {
    console.error("labelok callback error:", e);
  }
});

// ---- Lancement
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("✅ UrbanFungi bot lancé");
  } catch (err) {
    console.error("❌ Erreur lancement bot :", err);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
