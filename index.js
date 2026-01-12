// index.js (UrbanFungi bot) — propre, fiable, prêt Render

// dotenv en local uniquement (sur Render, env => dashboard)
try {
  require("dotenv").config();
} catch (e) {}

const { Telegraf, Markup } = require("telegraf");

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");

// URL de votre API Render (urbanfungi-api)
const API_URL = (process.env.API_URL || "").replace(/\/+$/, ""); // ex: https://urbanfungi-api.onrender.com

// URL de la mini app (Next.js)
const MINIAPP_URL = process.env.MINIAPP_URL || "https://urbanfungi-miniapp.onrender.com";

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ BOT_TOKEN ou ADMIN_CHAT_ID manquant");
  process.exit(1);
}
if (!API_URL) {
  console.warn("⚠️ API_URL manquant. Les boutons admin (PAYE/ANNULER/EXPEDIE) ne fonctionneront pas.");
}

const bot = new Telegraf(BOT_TOKEN);

// ====== ETAT SIMPLE (mémoire) ======
// userId -> orderCode (quand on attend un PDF étiquette)
const awaitingLabel = new Map();

// ====== HELPERS ======
function isAdmin(ctx) {
  const fromId = ctx.from?.id;
  return String(fromId) === String(ADMIN_CHAT_ID);
}

async function apiPost(path, payload) {
  if (!API_URL) throw new Error("API_URL manquant");
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Envoie au client la demande d'étiquette + met "awaitingLabel"
async function askShippingLabel(botCtx, clientId, orderCode) {
  awaitingLabel.set(String(clientId), String(orderCode));

  await botCtx.telegram.sendMessage(
    clientId,
    `✅ Paiement confirmé pour ${orderCode}.\n\n📎 Maintenant, envoyez votre étiquette d’envoi en PDF.\n\n` +
      `➡️ Répondez à CE message en joignant le PDF.\n` +
      `Si vous n’avez pas PDF, une photo nette fonctionne aussi.`
  );
}

// ====== COMMANDES ======
bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi — Menu\n\n" +
      "🛒 Ouvrez la boutique dans Telegram.\n" +
      "📦 Après paiement validé, vous recevrez une demande d’étiquette PDF.\n\n" +
      "Commandes:\n" +
      "• /shop — ouvrir la boutique\n" +
      "• /ping — test bot"
  );
});

bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot UrbanFungi opérationnel");
});

bot.command("shop", async (ctx) => {
  await ctx.reply(
    "🛒 Ouvrir la boutique (Mini App Telegram) :",
    Markup.inlineKeyboard([Markup.button.webApp("✅ Ouvrir la boutique", MINIAPP_URL)])
  );
});

// ====== BOUTONS ADMIN (callback_query) ======
// Doit matcher les callback_data que votre API envoie: ok:CMD-1234, cancel:..., ship:...
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    const [action, orderCode] = data.split(":");
    if (!action || !orderCode) return ctx.answerCbQuery("Données invalides");

    // sécurité : seul l'admin
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");

    // "noop" si on a édité le message déjà
    if (action === "noop") return ctx.answerCbQuery("OK");

    const status =
      action === "ok" ? "PAYE" :
      action === "cancel" ? "ANNULE" :
      action === "ship" ? "EXPEDIE" :
      null;

    if (!status) return ctx.answerCbQuery("Action inconnue");

    // 1) update statut via API
    const { res, data: json } = await apiPost("/api/admin-status", { orderCode, status });

    if (!res.ok || !json.ok) {
      console.error("admin-status error:", res.status, json);
      await ctx.answerCbQuery("Erreur API");
      return;
    }

    // 2) si PAYE => demander au client l'étiquette
    // IMPORTANT: votre API garde les commandes en mémoire (Map).
    // Pour récupérer clientId, le mieux est d'ajouter un endpoint "get-order".
    // MAIS on peut faire plus simple: votre API /api/admin-status notifie déjà le client,
    // donc ici on se contente d’afficher que c’est fait.
    // 👉 Si vous voulez que le BOT gère la demande d’étiquette (recommandé), ajoutez un endpoint.
    // Pour rester simple: on envoie un message admin “OK” et on laisse l’API notifier.
    await ctx.answerCbQuery("OK ✅");

    // Optionnel: marquer le message (visuel)
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: `✅ Statut: ${status}`, callback_data: `noop:${orderCode}` }]],
    }).catch(() => {});

    // Bonus UX: si PAYE, demander à l’admin de répondre avec /label <orderCode> <clientId>
    // (si vous n’avez pas de endpoint get-order).
    if (status === "PAYE") {
      await ctx.reply(
        `📎 Paiement confirmé pour ${orderCode}.\n` +
          `➡️ Le client doit maintenant envoyer son étiquette PDF.\n\n` +
          `Si vous voulez forcer la demande d’étiquette depuis le bot :\n` +
          `Tapez: /label ${orderCode} <clientId>\n` +
          `(clientId = l'id Telegram du client)`
      );
    }
  } catch (e) {
    console.error(e);
    try {
      await ctx.answerCbQuery("Erreur");
    } catch {}
  }
});

// ====== (OPTION) commande admin pour demander l'étiquette manuellement ======
// /label CMD-1234 123456789
bot.command("label", async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;

    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    // parts[0] = /label
    const orderCode = parts[1];
    const clientId = Number(parts[2] || "0");

    if (!orderCode || !clientId) {
      return ctx.reply("Usage: /label CMD-1234 123456789");
    }

    await askShippingLabel(ctx, clientId, orderCode);
    await ctx.reply(`✅ Demande d’étiquette envoyée au client ${clientId} pour ${orderCode}`);
  } catch (e) {
    console.error(e);
    ctx.reply("Erreur /label");
  }
});

// ====== RECEPTION PDF (DOCUMENT) ======
bot.on("document", async (ctx) => {
  try {
    const msg = ctx.message;
    const userId = String(msg.from.id);

    // On ne traite que si on attend une étiquette de cet utilisateur
    const orderCode = awaitingLabel.get(userId);
    if (!orderCode) return;

    // Vérifie si c'est bien un PDF (90% du temps)
    const fileName = msg.document?.file_name || "";
    const mime = msg.document?.mime_type || "";

    const isPdf = mime === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");

    // Transfert à l’admin
    await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, msg.chat.id, msg.message_id);

    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `📎 Étiquette reçue ${isPdf ? "(PDF)" : ""}\n` +
        `Commande: ${orderCode}\n` +
        `Client: @${msg.from.username || "inconnu"} (id ${userId})\n` +
        `Fichier: ${fileName || "(sans nom)"}`
    );

    awaitingLabel.delete(userId);
    await ctx.reply("✅ Étiquette reçue ! Merci. Notre équipe prépare l’envoi.");
  } catch (e) {
    console.error(e);
  }
});

// ====== RECEPTION PHOTO (au cas où pas PDF) ======
bot.on("photo", async (ctx) => {
  try {
    const msg = ctx.message;
    const userId = String(msg.from.id);

    const orderCode = awaitingLabel.get(userId);
    if (!orderCode) return;

    await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, msg.chat.id, msg.message_id);

    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `📷 Étiquette reçue (photo)\n` +
        `Commande: ${orderCode}\n` +
        `Client: @${msg.from.username || "inconnu"} (id ${userId})`
    );

    awaitingLabel.delete(userId);
    await ctx.reply("✅ Étiquette reçue ! Merci. Notre équipe prépare l’envoi.");
  } catch (e) {
    console.error(e);
  }
});

// ====== LANCEMENT PROPRE (Render) ======
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("✅ UrbanFungi bot lancé");
  } catch (err) {
    console.error("❌ Erreur au lancement :", err);
  }
})();

// ====== STOP ======
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
