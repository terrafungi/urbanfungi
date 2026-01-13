/**
 * UrbanFungi Bot — PROPRE + LOGS
 * Telegraf + Express + Webhook (Render OK)
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || "0");
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");
const BTC_ADDRESS = process.env.BTC_ADDRESS || "";
const TRANSCASH_TEXT =
  process.env.TRANSCASH_TEXT ||
  "Envoyez votre code Transcash + le montant exact.";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN || !WEBAPP_URL || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  throw new Error("❌ Variable d’environnement manquante");
}

/* ================== PATHS ================== */
const HOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const HOOK_URL = `${WEBHOOK_BASE_URL.replace(/\/+$/, "")}${HOOK_PATH}`;
const STORE_FILE = path.join(process.cwd(), "orders.json");
const LOG_FILE = path.join(process.cwd(), "orders.log");

/* ================== LOG ================== */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
}

/* ================== STORE ================== */
function loadStore() {
  if (!fs.existsSync(STORE_FILE)) return { orders: {} };
  return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function newOrderCode() {
  return `UF-${Date.now().toString(36).toUpperCase()}`;
}

/* ================== BOT ================== */
const bot = new Telegraf(BOT_TOKEN);

/* ================== ADMIN ================== */
function isAdmin(ctx) {
  return ADMIN_USER_ID && ctx.from?.id === ADMIN_USER_ID;
}

/* ================== UI ================== */
const shopKeyboard = Markup.keyboard([
  [Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)],
])
  .resize()
  .persistent();

/* ================== COMMANDES ================== */
bot.start(async (ctx) => {
  log(`START from ${ctx.from.id}`);
  await ctx.reply("🍄 UrbanFungi\nCliquez ci-dessous :", shopKeyboard);
});

bot.command("ping", async (ctx) => {
  log(`PING from ${ctx.from.id}`);
  await ctx.reply("✅ Bot OK");
});

bot.command("id", async (ctx) => {
  await ctx.reply(`user_id=${ctx.from.id}\nchat_id=${ctx.chat.id}`);
});

/* ================== MESSAGES ================== */
bot.on("message", async (ctx) => {
  const msg = ctx.message;

  log(`MSG from ${ctx.from.id}: ${JSON.stringify(msg).slice(0, 300)}`);

  /* ===== COMMANDE MINI-APP ===== */
  if (msg?.web_app_data?.data) {
    log("📦 COMMANDE MINI-APP REÇUE");

    const payload = JSON.parse(msg.web_app_data.data);
    const store = loadStore();
    const orderCode = newOrderCode();

    store.orders[orderCode] = {
      orderCode,
      userId: ctx.from.id,
      items: payload.items,
      totalEur: payload.totalEur,
      status: "AWAITING_PAYMENT",
      createdAt: Date.now(),
    };

    saveStore(store);
    log(`✅ COMMANDE ${orderCode} enregistrée`);

    await ctx.reply(
      `✅ Commande *${orderCode}* reçue\nTotal: *${payload.totalEur} €*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "₿ BTC", callback_data: `PAY_BTC:${orderCode}` },
              { text: "💳 Transcash", callback_data: `PAY_TC:${orderCode}` },
            ],
          ],
        },
      }
    );

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🧾 Nouvelle commande *${orderCode}*\n💶 ${payload.totalEur} €`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  /* ===== PDF ===== */
  if (msg.document?.mime_type === "application/pdf") {
    log(`📄 PDF reçu de ${ctx.from.id}`);
  }

  /* ===== TRANSCASH ===== */
  if (typeof msg.text === "string" && msg.text.length > 10) {
    log(`💳 Transcash reçu: ${msg.text}`);
  }
});

/* ================== ACTIONS ================== */
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  log(`BTC choisi pour ${ctx.match[1]}`);
  await ctx.answerCbQuery();
  await ctx.reply(`Adresse BTC:\n\`${BTC_ADDRESS}\``, {
    parse_mode: "Markdown",
  });
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  log(`Transcash choisi pour ${ctx.match[1]}`);
  await ctx.answerCbQuery();
  await ctx.reply(TRANSCASH_TEXT);
});

/* ================== EXPRESS ================== */
const app = express();

app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));
app.use(bot.webhookCallback(HOOK_PATH));

/* ================== START ================== */
(async () => {
  await bot.telegram.setWebhook(HOOK_URL);
  log(`Webhook set → ${HOOK_URL}`);

  app.listen(PORT, () => {
    log(`HTTP listening on ${PORT}`);
  });
})();
