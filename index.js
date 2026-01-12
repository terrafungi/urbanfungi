require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const API_URL = (process.env.API_URL || "").replace(/\/+$/, ""); // ex: https://urbanfungi-api.onrender.com

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !API_URL) {
  console.error("❌ BOT_TOKEN, ADMIN_CHAT_ID ou API_URL manquant");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx) {
  return ctx?.from?.id === ADMIN_CHAT_ID;
}

async function callApi(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ✅ Commande boutique
bot.command("shop", async (ctx) => {
  await ctx.reply(
    "🛒 Ouvrir la boutique (Mini App) :",
    Markup.inlineKeyboard([
      Markup.button.webApp("✅ Ouvrir la boutique", "https://urbanfungi-miniapp.onrender.com"),
    ])
  );
});

// ✅ Ping
bot.command("ping", (ctx) => ctx.reply("✅ Bot UrbanFungi opérationnel"));

// ✅ Secours si boutons invisibles : /paye CMD-1234
bot.command("paye", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  const orderCode = parts[1];
  if (!orderCode) return ctx.reply("Usage: /paye CMD-1234");

  try {
    await callApi("/api/admin-status", { orderCode, status: "PAYE" });
    await ctx.reply(`✅ Paiement confirmé pour ${orderCode}`);
  } catch (e) {
    await ctx.reply(`❌ Erreur: ${e.message}`);
  }
});

bot.command("annule", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const orderCode = ctx.message.text.split(" ")[1];
  if (!orderCode) return ctx.reply("Usage: /annule CMD-1234");

  try {
    await callApi("/api/admin-status", { orderCode, status: "ANNULE" });
    await ctx.reply(`❌ Commande annulée: ${orderCode}`);
  } catch (e) {
    await ctx.reply(`❌ Erreur: ${e.message}`);
  }
});

bot.command("expedie", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const orderCode = ctx.message.text.split(" ")[1];
  if (!orderCode) return ctx.reply("Usage: /expedie CMD-1234");

  try {
    await callApi("/api/admin-status", { orderCode, status: "EXPEDIE" });
    await ctx.reply(`📦 Commande expédiée: ${orderCode}`);
  } catch (e) {
    await ctx.reply(`❌ Erreur: ${e.message}`);
  }
});

// ✅ Clic sur boutons inline (callback_data)
bot.on("callback_query", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Accès refusé.");
    return;
  }

  const data = ctx.callbackQuery.data || "";
  const [action, orderCode] = data.split(":");
  if (!action || !orderCode) {
    await ctx.answerCbQuery("Action invalide.");
    return;
  }

  try {
    if (action === "pay") {
      await callApi("/api/admin-status", { orderCode, status: "PAYE" });
      await ctx.answerCbQuery("Paiement confirmé ✅");
      await ctx.editMessageReplyMarkup(); // enlève les boutons (optionnel)
      return;
    }

    if (action === "cancel") {
      await callApi("/api/admin-status", { orderCode, status: "ANNULE" });
      await ctx.answerCbQuery("Commande annulée ❌");
      await ctx.editMessageReplyMarkup();
      return;
    }

    if (action === "ship") {
      await callApi("/api/admin-status", { orderCode, status: "EXPEDIE" });
      await ctx.answerCbQuery("Marquée expédiée 📦");
      await ctx.editMessageReplyMarkup();
      return;
    }

    await ctx.answerCbQuery("Action inconnue.");
  } catch (e) {
    await ctx.answerCbQuery("Erreur API ❌");
    await ctx.reply(`❌ Erreur: ${e.message}`);
  }
});

// ✅ Réception PDF étiquette (le client envoie un document)
bot.on("document", async (ctx) => {
  // Ici tu peux choisir : accepter que le client envoie au bot direct,
  // et le bot te forward à toi (admin).
  const doc = ctx.message.document;
  const from = ctx.from;

  const caption =
    `📦 ÉTIQUETTE REÇUE\n` +
    `De: @${from.username || "inconnu"} (id ${from.id})\n` +
    `Fichier: ${doc.file_name || "document"}`;

  // forward vers toi
  await bot.telegram.sendMessage(ADMIN_CHAT_ID, caption);
  await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id);

  await ctx.reply("✅ Étiquette envoyée au support.");
});

// Lancement
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("✅ UrbanFungi bot lancé");
  } catch (err) {
    console.error("❌ Erreur lancement :", err);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
