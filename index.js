/**
 * UrbanFungi Bot + API (Render / Node)
 * - Telegraf bot
 * - Express API: POST /api/create-order
 * - Sends payment instructions (BTC / Transcash)
 * - Receives Transcash codes + PDF labels from users and forwards to admin
 *
 * ✅ CommonJS (require) => pas d'erreur ESM
 */

const express = require("express");
const cors = require("cors");
const { Telegraf, Markup } = require("telegraf");

// =========================
// ENV
// =========================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant dans les variables d'environnement.");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// URL de la mini-app (webapp) affichée dans Telegram
const WEBAPP_URL = process.env.WEBAPP_URL || "https://urbfgi.fun/";

// Admin (ton chat Telegram ID) pour recevoir les commandes/codes/pdf
// (ex: 123456789)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// Paiement
const BTC_ADDRESS = process.env.BTC_ADDRESS || "TON_ADRESSE_BITCOIN_ICI";
const TRANSCASH_INSTRUCTIONS =
  process.env.TRANSCASH_INSTRUCTIONS ||
  "Envoyez votre code Transcash ici (ex: 1234-5678-9012-3456).";

// Support / liens
const WHATSAPP_URL = process.env.WHATSAPP_URL || "";

// =========================
// Bot
// =========================
const bot = new Telegraf(BOT_TOKEN);

// Mémoire simple (suffisant)
const ordersByCode = new Map();          // orderCode -> order payload
const lastOrderByUser = new Map();       // userId -> last orderCode
const pendingByUser = new Map();         // userId -> { type: "transcash"|"label"|"btc", orderCode }

// =========================
// Helpers
// =========================
function money(n) {
  return Number(n || 0).toFixed(2);
}

function nowCode() {
  // code court lisible
  const d = new Date();
  const y = String(d.getFullYear()).slice(2);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `UF-${y}${m}${day}-${hh}${mm}-${rnd}`;
}

function summarizeItems(items) {
  const safe = Array.isArray(items) ? items : [];
  if (!safe.length) return "—";
  return safe
    .map((it) => {
      const qty = Number(it.qty || 0);
      const price = Number(it.prix || 0);
      const opts =
        it.options && typeof it.options === "object"
          ? Object.entries(it.options)
              .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(",") : v}`)
              .join(" | ")
          : "";
      return `• ${it.nom || it.id} x${qty} — ${money(price)}€${opts ? ` (${opts})` : ""}`;
    })
    .join("\n");
}

function shopButtonsInline() {
  return Markup.inlineKeyboard([
    [Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)],
    WHATSAPP_URL ? [Markup.button.url("💬 Support WhatsApp", WHATSAPP_URL)] : [],
  ].filter(row => row.length));
}

function shopButtonsKeyboard() {
  return Markup.keyboard([[Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)]])
    .resize()
    .persistent();
}

function paymentButtons(orderCode) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("₿ Payer en Bitcoin", `PAY_BTC:${orderCode}`)],
    [Markup.button.callback("💳 Payer en Transcash", `PAY_TC:${orderCode}`)],
    [Markup.button.callback("📎 Envoyer l'étiquette PDF", `LABEL:${orderCode}`)],
  ]);
}

async function notifyAdmin(text, extraMarkup) {
  if (!ADMIN_CHAT_ID) return;
  try {
    if (extraMarkup) await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, extraMarkup);
    else await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);
  } catch (e) {
    console.error("Admin notify error:", e?.message || e);
  }
}

async function sendUserMessage(userId, text, extraMarkup) {
  try {
    if (extraMarkup) await bot.telegram.sendMessage(userId, text, extraMarkup);
    else await bot.telegram.sendMessage(userId, text);
    return true;
  } catch (e) {
    console.error("sendUserMessage error:", e?.message || e);
    return false;
  }
}

// =========================
// Commands
// =========================
bot.start(async (ctx) => {
  const msg =
    "🍄 *UrbanFungi*\n\n" +
    "Cliquez sur *🛒 Ouvrir la boutique*, faites votre panier, puis *✅ Commander*.\n\n" +
    (WHATSAPP_URL ? "💬 Support: bouton WhatsApp ci-dessous.\n" : "");

  // 1) Inline bouton
  await ctx.replyWithMarkdownV2(msg.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1"), shopButtonsInline());
  // 2) Clavier (encore plus simple sur mobile)
  await ctx.reply("Bouton rapide :", shopButtonsKeyboard());
});

bot.command("shop", async (ctx) => {
  await ctx.reply("🛒 Ouvrir la boutique :", shopButtonsKeyboard());
  await ctx.reply("Ou via bouton ci-dessous :", shopButtonsInline());
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "📌 Aide\n\n" +
      "• /shop : afficher le bouton boutique\n" +
      "• Après commande : choisissez Bitcoin / Transcash\n" +
      "• Ensuite envoyez l’étiquette PDF ici\n"
  );
});

// =========================
// Callback buttons
// =========================
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  const userId = ctx.from?.id;

  await ctx.answerCbQuery("Instructions Bitcoin envoyées ✅");

  pendingByUser.set(userId, { type: "btc", orderCode });

  const txt =
    `✅ *Commande ${orderCode}*\n\n` +
    `₿ *Paiement Bitcoin*\n` +
    `Adresse : \`${BTC_ADDRESS}\`\n\n` +
    `Après le paiement, envoyez ici :\n` +
    `• le *TXID* (hash) ou une preuve\n\n` +
    `Ensuite : cliquez sur *📎 Envoyer l'étiquette PDF* ou envoyez directement le PDF.`;

  await ctx.replyWithMarkdown(txt, Markup.inlineKeyboard([
    [Markup.button.callback("📎 Envoyer l'étiquette PDF", `LABEL:${orderCode}`)],
  ]));
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  const userId = ctx.from?.id;

  await ctx.answerCbQuery("Instructions Transcash envoyées ✅");

  pendingByUser.set(userId, { type: "transcash", orderCode });

  const txt =
    `✅ *Commande ${orderCode}*\n\n` +
    `💳 *Paiement Transcash*\n` +
    `${TRANSCASH_INSTRUCTIONS}\n\n` +
    `➡️ Envoyez votre *code Transcash* ici (message texte).\n\n` +
    `Ensuite : envoyez votre *étiquette PDF* ici.`;

  await ctx.replyWithMarkdown(txt, Markup.inlineKeyboard([
    [Markup.button.callback("📎 Envoyer l'étiquette PDF", `LABEL:${orderCode}`)],
  ]));
});

bot.action(/^LABEL:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  const userId = ctx.from?.id;

  await ctx.answerCbQuery("Envoyez le PDF dans le chat 📎");

  pendingByUser.set(userId, { type: "label", orderCode });

  await ctx.reply(
    `📎 Envoyez maintenant votre *étiquette PDF* ici.\n` +
      `Astuce : vous pouvez mettre en légende : LABEL ${orderCode}`,
    { parse_mode: "Markdown" }
  );
});

// =========================
// Receive messages (codes / pdf)
// =========================
bot.on("text", async (ctx) => {
  const userId = ctx.from?.id;
  const text = (ctx.message?.text || "").trim();

  // ignore commands
  if (text.startsWith("/")) return;

  const pending = pendingByUser.get(userId);

  // si pas pending, on essaie de relier au dernier order
  const lastCode = lastOrderByUser.get(userId);

  // Transcash code
  if (pending?.type === "transcash") {
    const orderCode = pending.orderCode || lastCode;
    await notifyAdmin(
      `💳 *Transcash reçu*\nCommande: *${orderCode}*\nUser: ${ctx.from?.username ? "@" + ctx.from.username : userId}\nCode: \`${text}\``,
      { parse_mode: "Markdown" }
    );
    await ctx.reply("✅ Code Transcash reçu. Merci !\n📎 Envoyez maintenant votre étiquette PDF ici.");
    pendingByUser.set(userId, { type: "label", orderCode });
    return;
  }

  // BTC TXID / preuve
  if (pending?.type === "btc") {
    const orderCode = pending.orderCode || lastCode;
    await notifyAdmin(
      `₿ *Preuve BTC reçue*\nCommande: *${orderCode}*\nUser: ${ctx.from?.username ? "@" + ctx.from.username : userId}\nMessage: \`${text}\``,
      { parse_mode: "Markdown" }
    );
    await ctx.reply("✅ Preuve reçue. Merci !\n📎 Envoyez maintenant votre étiquette PDF ici.");
    pendingByUser.set(userId, { type: "label", orderCode });
    return;
  }

  // si user tape un code au hasard, on forward à l'admin quand même (utile)
  if (lastCode) {
    await notifyAdmin(
      `📩 Message client (commande ${lastCode})\nUser: ${ctx.from?.username ? "@" + ctx.from.username : userId}\nTexte: ${text}`
    );
  }
});

bot.on("document", async (ctx) => {
  const userId = ctx.from?.id;
  const doc = ctx.message?.document;

  const mime = doc?.mime_type || "";
  const fileName = doc?.file_name || "";

  // On accepte PDF surtout
  const isPdf = mime.includes("pdf") || fileName.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    await ctx.reply("⚠️ Merci d'envoyer un fichier PDF (étiquette).");
    return;
  }

  // Déduire orderCode
  const caption = (ctx.message?.caption || "").trim();
  let orderCode = null;

  // caption "LABEL UF-...."
  const m = caption.match(/LABEL\s+([A-Z0-9\-]+)/i);
  if (m) orderCode = m[1];

  if (!orderCode) {
    const pending = pendingByUser.get(userId);
    orderCode = pending?.orderCode || lastOrderByUser.get(userId) || "INCONNU";
  }

  await ctx.reply(`✅ PDF reçu pour la commande ${orderCode}. Merci !`);

  // Forward au admin
  if (ADMIN_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📎 *Étiquette PDF reçue*\nCommande: *${orderCode}*\nUser: ${ctx.from?.username ? "@" + ctx.from.username : userId}`,
        { parse_mode: "Markdown" }
      );
      await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id);
    } catch (e) {
      console.error("forward pdf error:", e?.message || e);
    }
  }

  pendingByUser.delete(userId);
});

// =========================
// Express API
// =========================
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type"] }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /api/create-order
 * Body attendu (depuis ta miniapp):
 * {
 *   user: { id, username },
 *   items: [{id, nom, prix, qty, options}],
 *   totalEur: 12.34
 * }
 *
 * Réponse:
 * { ok: true, orderCode }
 *
 * ✅ IMPORTANT: on envoie un message Telegram au client ici
 */
app.post("/api/create-order", async (req, res) => {
  try {
    const body = req.body || {};
    const user = body.user || {};
    const userId = Number(user.id);

    if (!userId) {
      return res.status(400).json({ ok: false, error: "Missing user.id" });
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const totalEur = Number(body.totalEur || 0);

    const orderCode = nowCode();

    // Save in memory
    const order = {
      orderCode,
      user: { id: userId, username: user.username || "" },
      items,
      totalEur,
      createdAt: new Date().toISOString(),
      status: "PENDING_PAYMENT",
    };

    ordersByCode.set(orderCode, order);
    lastOrderByUser.set(userId, orderCode);

    // Notify admin
    await notifyAdmin(
      `🧾 *Nouvelle commande*\n` +
        `Code: *${orderCode}*\n` +
        `Client: ${order.user.username ? "@" + order.user.username : userId}\n` +
        `Total: *${money(totalEur)}€*\n\n` +
        `${summarizeItems(items)}`,
      { parse_mode: "Markdown" }
    );

    // Message client (IMPORTANT => c'est ça qui manquait chez toi)
    const sent = await sendUserMessage(
      userId,
      `✅ *Commande reçue !*\n\n` +
        `📦 Code: *${orderCode}*\n` +
        `💰 Total: *${money(totalEur)} €*\n\n` +
        `👉 Choisissez votre moyen de paiement, puis envoyez l’étiquette PDF.`,
      { parse_mode: "Markdown", ...paymentButtons(orderCode) }
    );

    // Si le bot ne peut pas écrire au user (user n'a pas /start), on l'indique
    if (!sent) {
      await notifyAdmin(
        `⚠️ Impossible d'envoyer les instructions au client.\n` +
          `Il doit d'abord ouvrir le bot et faire /start.\n` +
          `UserID: ${userId}`
      );
    }

    return res.json({ ok: true, orderCode });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// =========================
// Start server + bot
// =========================
app.listen(PORT, () => {
  console.log(`✅ API listening on :${PORT}`);
});

// Long polling
bot.launch()
  .then(() => console.log("✅ Bot launched (polling)"))
  .catch((e) => console.error("Bot launch error:", e));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
