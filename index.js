// index.js — UrbanFungi Bot (Mini-App PRO + commandes BTC manuelles)
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

// ✅ ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const BTC_ADDRESS =
  process.env.BTC_ADDRESS || "bc1q7ttd985n9nlky9gqe9vxwqq33u007ssvq0dnql";

// (optionnel) ancien catalogue texte
let produits = [];
try {
  // si tu gardes products.json dans le repo
  produits = require("./products.json");
} catch (e) {
  // pas grave si tu n'utilises plus le catalogue texte
  produits = [];
}

// ✅ CHECKS
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant (Render > Environment)");
  process.exit(1);
}
if (!ADMIN_CHAT_ID) {
  console.error("❌ ADMIN_CHAT_ID manquant (Render > Environment)");
  process.exit(1);
}
if (!WEBAPP_URL) {
  console.warn("⚠️ WEBAPP_URL manquant : /start n'affichera pas le bouton boutique.");
}

const bot = new Telegraf(BOT_TOKEN);

// Panier mémoire (optionnel / legacy)
const paniers = new Map();

// Helpers
function isAdmin(ctx) {
  return Number(ctx.from?.id) === Number(ADMIN_CHAT_ID);
}

function shopKeyboard() {
  if (!WEBAPP_URL) {
    return Markup.inlineKeyboard([
      [Markup.button.url("🌐 Ouvrir la boutique", "https://example.com")],
    ]);
  }
  return Markup.inlineKeyboard([
    [Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)],
  ]);
}

function adminOrderButtons(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Paiement reçu", `ok:${orderId}`)],
    [Markup.button.callback("❌ Annuler", `cancel:${orderId}`)],
    [Markup.button.callback("📤 Expédié", `ship:${orderId}`)],
  ]);
}

function getPanierText(panier) {
  if (!panier || panier.length === 0) return "🛒 Votre panier est vide.";
  const total = panier.reduce((sum, p) => sum + Number(p.prix || 0), 0);
  return (
    "🧺 Votre panier :\n" +
    panier.map((p) => `- ${p.nom} — ${p.prix} €`).join("\n") +
    `\n\n💶 Total : ${total.toFixed(2)} €`
  );
}

// Logs / erreurs
bot.use(async (ctx, next) => {
  try {
    // log minimal utile
    if (ctx.message?.text) {
      console.log("MSG", ctx.from?.id, ctx.from?.username, ctx.message.text);
    }
    await next();
  } catch (err) {
    console.error("❌ Middleware error:", err);
  }
});

bot.catch((err) => console.error("❌ BOT ERROR:", err));

/**
 * ✅ START = PRO
 * On pousse vers la mini-app, sans commandes “spam”.
 */
bot.start(async (ctx) => {
  await ctx.reply(
    "👋 Bienvenue dans la boutique UrbanFungi 🍄\n\nClique ci-dessous pour ouvrir la boutique :",
    Markup.keyboard([
      Markup.button.webApp(
        "🛒 Ouvrir la boutique",
        "https://urbanfungi-miniapp.onrender.com"
      )
    ])
      .resize()
      .oneTime()
  );
});


  // optionnel : aide rapide
  await ctx.reply(
    "ℹ️ Astuce :\n" +
      "• /catalogue : redirection boutique\n" +
      "• /panier : redirection boutique\n",
  );
});

/**
 * ✅ Redirection propre
 */
bot.command("catalogue", async (ctx) => {
  await ctx.reply(
    "🛒 La boutique PRO est ici :",
    shopKeyboard()
  );
});

bot.command("panier", async (ctx) => {
  await ctx.reply(
    "🧺 Le panier PRO est dans la boutique :",
    shopKeyboard()
  );
});

/**
 * (Optionnel) Ancien mode catalogue texte — désactivé par défaut
 * Si tu veux le réactiver : tu peux créer /catalogue_legacy
 */
bot.command("catalogue_legacy", async (ctx) => {
  if (!produits.length) {
    return ctx.reply("❌ products.json introuvable ou vide.");
  }

  await ctx.reply("📦 Catalogue (ancien mode). Tape /panier_legacy pour voir le panier.");
  for (const produit of produits) {
    await ctx.reply(
      `🛍️ ${produit.nom}\n💶 ${produit.prix} €`,
      Markup.inlineKeyboard([
        Markup.button.callback("➕ Ajouter au panier", `add:${produit.nom}`),
      ])
    );
  }
});

bot.command("panier_legacy", async (ctx) => {
  const panier = paniers.get(ctx.from.id) || [];
  const texte = getPanierText(panier);
  if (panier.length === 0) return ctx.reply(texte);

  const total = panier.reduce((sum, p) => sum + Number(p.prix || 0), 0);
  await ctx.reply(
    texte + `\n\n💰 BTC : ${BTC_ADDRESS}`,
    Markup.inlineKeyboard([[Markup.button.callback("✅ J’ai payé", "valider")]])
  );
});

bot.action(/^add:(.+)/, async (ctx) => {
  const nom = ctx.match[1];
  const produit = produits.find((p) => p.nom === nom);
  if (!produit) return ctx.answerCbQuery("Produit introuvable");

  const panier = paniers.get(ctx.from.id) || [];
  panier.push(produit);
  paniers.set(ctx.from.id, panier);

  await ctx.answerCbQuery("Ajouté ✅");
});

bot.action("valider", async (ctx) => {
  const panier = paniers.get(ctx.from.id) || [];
  if (!panier.length) return ctx.answerCbQuery("Panier vide");

  const total = panier.reduce((sum, p) => sum + Number(p.prix || 0), 0);
  const orderId = `CMD-${Math.floor(1000 + Math.random() * 9000)}`;

  const text =
    `🧾 NOUVELLE COMMANDE ${orderId}\n` +
    `Client: @${ctx.from.username || "inconnu"} (${ctx.from.id})\n\n` +
    `Produits:\n` +
    panier.map((p) => `- ${p.nom} — ${p.prix} €`).join("\n") +
    `\n\n💶 Total : ${total.toFixed(2)} €\n` +
    `💰 Paiement BTC (manuel)\nAdresse : ${BTC_ADDRESS}\n` +
    `Statut : EN ATTENTE`;

  await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, adminOrderButtons(orderId));

  await ctx.reply(
    `✅ Commande enregistrée.\n\n` +
      `💶 Total : ${total.toFixed(2)} €\n` +
      `💰 Adresse BTC :\n${BTC_ADDRESS}\n\n` +
      `Ensuite, clique “J’ai payé”.`
  );

  paniers.set(ctx.from.id, []);
  await ctx.answerCbQuery();
});

/**
 * ✅ Actions admin uniquement (ok/cancel/ship)
 * Important : on ne traite pas les autres callback_query ici.
 */
bot.action(/^(ok|cancel|ship):(.+)/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Accès refusé", { show_alert: true });
    return;
  }

  const data = ctx.callbackQuery?.data || "";
  const [action, orderId] = data.split(":");

  if (action === "ok") {
    await ctx.reply(`✅ Paiement confirmé pour ${orderId}`);
    await ctx.answerCbQuery("OK");
  } else if (action === "cancel") {
    await ctx.reply(`❌ Commande annulée : ${orderId}`);
    await ctx.answerCbQuery("Annulée");
  } else if (action === "ship") {
    await ctx.reply(`📦 Commande expédiée : ${orderId}`);
    await ctx.answerCbQuery("Expédiée");
  } else {
    await ctx.answerCbQuery("Action inconnue");
  }
});

/**
 * ✅ Lancement propre
 */
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
