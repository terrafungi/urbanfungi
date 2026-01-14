/**
 * UrbanFungi Bot — Telegraf + Webhook + Express (Render)
 * - MiniApp -> ORDER via WebApp sendData()
 * - Paiement BTC / Transcash
 * - Admin valide -> demande PDF
 * - PDF reçu -> forward admin
 *
 * MODIF :
 * - Suppression du bouton inline "Ouvrir la boutique" sous le message
 * - On garde uniquement le bouton du bas (reply keyboard)
 * - Ajout d'un texte explicatif clair dans le message
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN manquant");

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
if (!WEBAPP_URL) throw new Error("❌ WEBAPP_URL manquant (URL miniapp)");

const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0"); // où tu reçois les notifs (toi ou groupe)
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || "0"); // TON user id perso

const BTC_ADDRESS = (process.env.BTC_ADDRESS || "").trim();
const TRANSCASH_TEXT =
  (process.env.TRANSCASH_TEXT || "").trim() ||
  "Envoyez votre code Transcash + le montant exact.";

const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || "").trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();
if (!WEBHOOK_BASE_URL) throw new Error('❌ WEBHOOK_BASE_URL manquant (ex: "https://urbanfungi-tp50.onrender.com")');
if (!WEBHOOK_SECRET) throw new Error('❌ WEBHOOK_SECRET manquant (ex: "azertyuiop123")');

const PORT = Number(process.env.PORT || "10000");
const HOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const HOOK_URL = `${WEBHOOK_BASE_URL.replace(/\/+$/, "")}${HOOK_PATH}`;

// ================== BOT ==================
const bot = new Telegraf(BOT_TOKEN);

// ===== Logs (TRÈS UTILE) =====
bot.use(async (ctx, next) => {
  try {
    const u = ctx.from?.id;
    const t = ctx.updateType;
    const msg = ctx.message?.text;
    const hasWebAppData = !!ctx.message?.web_app_data?.data;
    const hasDoc = !!ctx.message?.document;
    console.log(
      `TG UPDATE: type=${t} from=${u} text=${msg ? JSON.stringify(msg) : "-"} webApp=${hasWebAppData} doc=${hasDoc}`
    );
  } catch {}
  return next();
});

// ================== STORE (fichier simple) ==================
const STORE_FILE = process.env.ORDERS_STORE || path.join(process.cwd(), "orders.json");

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return { orders: {} };
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return { orders: {} };
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function newOrderCode() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `UF-${y}${m}${day}-${rnd}`;
}
function euro(n) {
  return Number(n || 0).toFixed(2);
}

// ================== Admin check ==================
function isAdmin(ctx) {
  // si ADMIN_USER_ID est défini => seuls tes clics admin sont acceptés
  if (ADMIN_USER_ID) return ctx.from?.id === ADMIN_USER_ID;
  // fallback si tu n'as pas mis ADMIN_USER_ID (pas recommandé)
  return true;
}

// ================== Keyboards ==================
// ✅ On garde uniquement le bouton du bas (Reply Keyboard)
function userKeyboard() {
  return Markup.keyboard([
    [{ text: "🛒 Ouvrir la boutique", web_app: { url: WEBAPP_URL } }],
  ])
    .resize()
    .persistent();
}

function payKeyboard(orderCode) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("₿ Payer en BTC", `PAY_BTC:${orderCode}`),
      Markup.button.callback("💳 Transcash", `PAY_TC:${orderCode}`),
    ],
    [Markup.button.callback("📄 Envoyer étiquette PDF", `SEND_PDF:${orderCode}`)],
  ]);
}
function adminKeyboard(orderCode) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Paiement OK", `ADM_PAID:${orderCode}`),
      Markup.button.callback("❌ Annuler", `ADM_CANCEL:${orderCode}`),
    ],
    [Markup.button.callback("✅ Terminer", `ADM_DONE:${orderCode}`)],
  ]);
}

function formatOrder(order) {
  const lines = [];
  lines.push(`🧾 *Commande ${order.orderCode}*`);
  lines.push(`👤 Client: ${order.username ? "@" + order.username : order.userId}`);
  lines.push(`💶 Total: *${euro(order.totalEur)} €*`);
  lines.push(`💳 Paiement: *${order.paymentMethod || "?"}*`);
  lines.push("");
  lines.push("📦 Articles :");
  for (const it of order.items || []) {
    const opts =
      it.options && typeof it.options === "object" && Object.keys(it.options).length
        ? ` (${Object.entries(it.options)
            .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(",") : String(v)}`)
            .join(" | ")})`
        : "";
    lines.push(`- x${Number(it.qty || 1)} ${it.nom || it.id}${opts}`);
  }
  lines.push("");
  lines.push(`📌 Statut: *${order.status}*`);
  return lines.join("\n");
}

// ================== Commands ==================
bot.command("id", async (ctx) => {
  await ctx.reply(`user_id=${ctx.from.id}\nchat_id=${ctx.chat.id}`);
});

bot.command("ping", async (ctx) => {
  console.log("PING from", ctx.from.id);
  await ctx.reply("✅ Bot OK");
});

bot.start(async (ctx) => {
  console.log("START from", ctx.from.id);

  // ✅ Plus de bouton sous le message : on met un texte explicatif + le clavier du bas
  await ctx.reply(
    "🍄 UrbanFungi — Boutique\n\n" +
      "➡️ Pour ouvrir le catalogue, utilisez le bouton **🛒 Ouvrir la boutique** en bas de l’écran.\n\n" +
      "✅ Important : c’est ce bouton qui permet au bot de recevoir la commande automatiquement.\n\n" +
      "ℹ️ Si vous ne voyez pas le bouton, tapez : /shop",
    { ...userKeyboard(), parse_mode: "Markdown" }
  );
});

bot.command("shop", async (ctx) => {
  await ctx.reply(
    "🛒 Boutique UrbanFungi\n\n" +
      "➡️ Cliquez sur le bouton **🛒 Ouvrir la boutique** en bas.\n\n" +
      "✅ C’est la méthode la plus fiable pour que la commande remonte au bot.",
    { ...userKeyboard(), parse_mode: "Markdown" }
  );
});

// ================== Incoming messages ==================
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;

  // 1) Commande envoyée par miniapp via sendData()
  if (msg?.web_app_data?.data) {
    let payload;
    try {
      payload = JSON.parse(msg.web_app_data.data);
    } catch {
      await ctx.reply("❌ Données commande illisibles.");
      return;
    }

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const totalEur = Number(payload?.totalEur || 0);
    if (!items.length) {
      await ctx.reply("❌ Commande vide.");
      return;
    }

    const store = loadStore();
    const orderCode = newOrderCode();

    const order = {
      orderCode,
      userId: ctx.from.id,
      username: ctx.from.username || "",
      items: items.map((it) => ({
        id: it.id,
        nom: it.nom || it.id || "Produit",
        qty: Number(it.qty || 1),
        options: it.options || {},
      })),
      totalEur,
      status: "AWAITING_PAYMENT",
      paymentMethod: "",       // <--- IMPORTANT
      transcashCode: "",
      transcashAmount: "",
      labelFileId: "",
      createdAt: Date.now(),
    };

    store.orders[orderCode] = order;
    saveStore(store);

    await ctx.replyWithMarkdown(
      `✅ *Commande reçue : ${orderCode}*\nTotal: *${euro(totalEur)} €*\n\nChoisissez votre moyen de paiement 👇`,
      payKeyboard(orderCode)
    );

    // NOTIF ADMIN + BOUTONS
    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, formatOrder(order), {
        parse_mode: "Markdown",
        reply_markup: adminKeyboard(orderCode).reply_markup,
      });
      console.log("ADMIN NOTIF sent to", ADMIN_CHAT_ID, "order", orderCode);
    } else {
      console.log("ADMIN_CHAT_ID=0 => pas de notif admin");
    }
    return;
  }

  // 2) PDF reçu
  if (msg?.document?.mime_type === "application/pdf") {
    const store = loadStore();
    const orders = Object.values(store.orders || {}).filter((o) => o.userId === ctx.from.id);
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const current = orders.find((o) => o.status === "AWAITING_LABEL");

    if (!current) {
      await ctx.reply("Je n’attends pas encore le PDF (attendez la validation du paiement).");
      return;
    }

    current.labelFileId = msg.document.file_id;
    current.status = "DONE";
    store.orders[current.orderCode] = current;
    saveStore(store);

    await ctx
