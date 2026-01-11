// index.js (bot avec panier + paiement BTC)
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const produits = require("./products.json");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");
const BTC_ADDRESS = process.env.BTC_ADDRESS || "bc1q7ttd985n9nlky9gqe9vxwqq33u007ssvq0dnql";

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ BOT_TOKEN ou ADMIN_CHAT_ID manquant");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const paniers = new Map();

function getPanierText(panier) {
  if (!panier || panier.length === 0) return "🛒 Ton panier est vide.";
  const total = panier.reduce((sum, p) => sum + p.prix, 0);
  return (
    "🧺 Ton panier :\n" +
    panier.map(p => `- ${p.nom} — ${p.prix} €`).join("\n") +
    `\n\n💶 Total : ${total.toFixed(2)} €`
  );
}

bot.start(async (ctx) => {
  await ctx.reply("👋 Bienvenue dans la boutique UrbanFungi !\n\nTape /catalogue pour voir les produits.");
});

bot.command("catalogue", async (ctx) => {
  for (const produit of produits) {
    await ctx.reply(
      `🛍️ ${produit.nom}\n💶 ${produit.prix} €`,
      Markup.inlineKeyboard([
        Markup.button.callback("➕ Ajouter au panier", `add:${produit.nom}`),
      ])
    );
  }
});

bot.command("panier", async (ctx) => {
  const panier = paniers.get(ctx.from.id) || [];
  const texte = getPanierText(panier);
  const total = panier.reduce((sum, p) => sum + p.prix, 0);
  if (panier.length === 0) {
    await ctx.reply(texte);
  } else {
    await ctx.reply(
      texte,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ J’ai payé", "valider")],
      ])
    );
  }
});

bot.action(/^add:(.+)/, async (ctx) => {
  const nom = ctx.match[1];
  const produit = produits.find(p => p.nom === nom);
  if (!produit) return ctx.answerCbQuery("Produit introuvable");
  const panier = paniers.get(ctx.from.id) || [];
  panier.push(produit);
  paniers.set(ctx.from.id, panier);
  await ctx.answerCbQuery("Ajouté au panier ✅");
});

bot.action("valider", async (ctx) => {
  const panier = paniers.get(ctx.from.id) || [];
  if (panier.length === 0) return ctx.answerCbQuery("Panier vide");
  const total = panier.reduce((sum, p) => sum + p.prix, 0);

  const orderId = `CMD-${Math.floor(1000 + Math.random() * 9000)}`;
  const text =
    `📦 Nouvelle commande ${orderId}\n` +
    `Client: @${ctx.from.username || "inconnu"} (${ctx.from.id})\n` +
    `Produits:\n` +
    panier.map(p => `- ${p.nom} — ${p.prix} €`).join("\n") +
    `\n\n💶 Total : ${total.toFixed(2)} €\n` +
    `💰 Paiement BTC (manuel)\nAdresse : ${BTC_ADDRESS}`;

  await bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Paiement reçu", `ok:${orderId}`)],
      [Markup.button.callback("❌ Annuler", `cancel:${orderId}`)],
      [Markup.button.callback("📤 Expédié", `ship:${orderId}`)]
    ])
  );

  await ctx.reply(`✅ Commande enregistrée. Envoie ${total.toFixed(2)} € en BTC à :\n${BTC_ADDRESS}`);
  paniers.set(ctx.from.id, []);
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [action, id] = data.split(":");
  if (action === "ok") await ctx.reply(`✅ Paiement confirmé pour ${id}`);
  else if (action === "cancel") await ctx.reply(`❌ Commande ${id} annulée.`);
  else if (action === "ship") await ctx.reply(`📤 Commande ${id} expédiée.`);
  await ctx.answerCbQuery();
});

bot.launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
