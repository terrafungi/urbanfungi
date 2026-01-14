/**
 * UrbanFungi Bot — Telegraf + Webhook + Express (Render friendly)
 * + Debug webhook: /webhook (TG) + /debug/webhook (HTTP)
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

// ================== ENV ==================
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN manquant");

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim(); // URL de la miniapp (Render miniapp)
if (!WEBAPP_URL) throw new Error("❌ WEBAPP_URL manquant (URL miniapp)");

const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0"); // où TU reçois les notifs admin
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || "0"); // ton user_id perso

const BTC_ADDRESS = (process.env.BTC_ADDRESS || "").trim();
const TRANSCASH_TEXT =
  (process.env.TRANSCASH_TEXT || "").trim() ||
  "Envoyez votre code Transcash (copier/coller) + montant exact dans ce chat.";

const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || "").trim(); // URL du service BOT Render
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

if (!WEBHOOK_BASE_URL) {
  throw new Error('❌ WEBHOOK_BASE_URL manquant (ex: "https://urbanfungi-tp50.onrender.com")');
}
if (!WEBHOOK_SECRET) {
  throw new Error('❌ WEBHOOK_SECRET manquant (ex: "azertyuiop123")');
}

const PORT = Number(process.env.PORT || "10000");
const HOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const HOOK_URL = `${WEBHOOK_BASE_URL.replace(/\/+$/, "")}${HOOK_PATH}`;

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
function isAdmin(ctx) {
  return ADMIN_USER_ID ? ctx.from?.id === ADMIN_USER_ID : false;
}

// ================== Keyboards ==================
function userKeyboard() {
  return Markup.keyboard([[Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)]])
    .resize()
    .persistent();
}
function userInlineShop() {
  return Markup.inlineKeyboard([[Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)]]);
}
function payKeyboard(orderCode) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("₿ Payer en BTC", `PAY_BTC:${orderCode}`),
      Markup.button.callback("💳 Transcash", `PAY_TC:${orderCode}`),
    ],
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

// ================== BOT ==================
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err) => console.error("❌ BOT ERROR:", err));

// Logs TG
bot.use(async (ctx, next) => {
  try {
    if (ctx.updateType === "message") {
      const m = ctx.message || {};
      const from = ctx.from?.id;
      const txt = m.text ? String(m.text).slice(0, 200) : "";
      console.log(
        `TG IN: from=${from} text=${txt || "-"} webapp=${!!m.web_app_data} doc=${!!m.document}`
      );
    } else {
      console.log(`TG IN: updateType=${ctx.updateType}`);
    }
  } catch {}
  return next();
});

// Debug: /id /ping
bot.command("id", async (ctx) => {
  await ctx.reply(`user_id=${ctx.from.id}\nchat_id=${ctx.chat.id}`);
});
bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot OK");
});

// 🔥 Debug webhook: /webhook (admin only)
bot.command("webhook", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Admin only");
  try {
    const info = await bot.telegram.getWebhookInfo();
    await ctx.reply(
      `WEBHOOK INFO:\n` +
        `url: ${info.url || "-"}\n` +
        `pending: ${info.pending_update_count}\n` +
        `last_error_date: ${info.last_error_date || "-"}\n` +
        `last_error_message: ${info.last_error_message || "-"}`
    );
  } catch (e) {
    await ctx.reply("❌ Impossible de lire webhook info (token/env?)");
    console.error(e);
  }
});

// /start /shop
bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi\n\nCliquez sur le bouton ci-dessous pour ouvrir la boutique.",
    userKeyboard()
  );
  await ctx.reply("Si le bouton disparaît : /shop", userInlineShop());
});
bot.command("shop", async (ctx) => {
  await ctx.reply("🛒 Ouvrir la boutique :", userKeyboard());
});

// ================== Réception messages ==================
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;

  // 1) Commande miniapp via sendData()
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
      transcashCode: "",
      labelFileId: "",
      createdAt: Date.now(),
    };

    store.orders[orderCode] = order;
    saveStore(store);

    await ctx.replyWithMarkdown(
      `✅ *Commande reçue : ${orderCode}*\n\n💶 Total: *${euro(totalEur)} €*\n\nChoisissez votre moyen de paiement 👇`,
      payKeyboard(orderCode)
    );

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, formatOrder(order), {
        parse_mode: "Markdown",
        ...adminKeyboard(orderCode),
      });
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

    await ctx.reply("✅ PDF reçu ! Merci, on traite la commande.");

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📄 PDF reçu pour *${current.orderCode}* ✅`,
        { parse_mode: "Markdown" }
      );
      await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
    }
    return;
  }

  // 3) Transcash (texte)
  if (typeof msg?.text === "string") {
    const text = msg.text.trim();
    const looksLikeCode = text.length >= 6 && text.length <= 120 && /[A-Za-z0-9]/.test(text);

    if (looksLikeCode) {
      const store = loadStore();
      const orders = Object.values(store.orders || {}).filter((o) => o.userId === ctx.from.id);
      orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const current = orders.find((o) => o.status === "AWAITING_PAYMENT");

      if (current) {
        current.transcashCode = text;
        store.orders[current.orderCode] = current;
        saveStore(store);

        await ctx.reply(
          `✅ Code Transcash reçu pour *${current.orderCode}*.\nOn valide et on vous demandera le PDF.`
        );

        if (ADMIN_CHAT_ID) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `💳 Transcash reçu ✅\nCommande: *${current.orderCode}*\nCode: \`${text}\``,
            { parse_mode: "Markdown", ...adminKeyboard(current.orderCode) }
          );
        }
        return;
      }
    }
  }

  return next();
});

// ================== ACTIONS CLIENT ==================
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("BTC");
  if (!BTC_ADDRESS) return ctx.reply("❌ Adresse BTC non configurée (admin).");

  await ctx.replyWithMarkdown(
    `₿ *Bitcoin — ${orderCode}*\n\nAdresse: \`${BTC_ADDRESS}\`\n\nAprès paiement, envoyez une preuve ici.\nEnsuite on vous demandera l'étiquette PDF.`
  );
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("Transcash");
  await ctx.replyWithMarkdown(
    `💳 *Transcash — ${orderCode}*\n\n${TRANSCASH_TEXT}\n\nEnvoyez maintenant votre *code Transcash* dans le chat.`
  );
});

// ================== ACTIONS ADMIN ==================
bot.action(/^ADM_PAID:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only", { show_alert: true });

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "AWAITING_LABEL";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Validé ✅");

  await bot.telegram.sendMessage(
    order.userId,
    `✅ Paiement validé pour *${orderCode}*.\n\n📄 Envoyez maintenant votre *étiquette PDF* ici (document).`,
    { parse_mode: "Markdown" }
  );
});

bot.action(/^ADM_CANCEL:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only", { show_alert: true });

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "CANCELED";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Annulé");
  await bot.telegram.sendMessage(order.userId, `❌ Commande *${orderCode}* annulée.`, {
    parse_mode: "Markdown",
  });
});

bot.action(/^ADM_DONE:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only", { show_alert: true });

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "DONE";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("OK");
  await bot.telegram.sendMessage(order.userId, `✅ Commande *${orderCode}* finalisée. Merci !`, {
    parse_mode: "Markdown",
  });
});

// ================== EXPRESS WEBHOOK SERVER ==================
const app = express();

// JSON body (important pour certains setups)
app.use(express.json({ limit: "10mb" }));

// Log HTTP (évite spam /health)
app.use((req, _res, next) => {
  if (req.path !== "/health") console.log("HTTP IN:", req.method, req.path);
  next();
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ✅ Debug HTTP: /debug/webhook?key=SECRET
app.get("/debug/webhook", async (req, res) => {
  if (req.query.key !== WEBHOOK_SECRET) return res.status(401).send("nope");
  try {
    const info = await bot.telegram.getWebhookInfo();
    res.json({
      expected: HOOK_URL,
      current: info.url,
      pending: info.pending_update_count,
      last_error_date: info.last_error_date || null,
      last_error_message: info.last_error_message || null,
    });
  } catch (e) {
    res.status(500).json({ error: "cannot_get_webhook_info" });
  }
});

// Webhook Telegraf
app.use(bot.webhookCallback(HOOK_PATH));

async function start() {
  console.log("BOOT CONFIG:", {
    ADMIN_CHAT_ID,
    ADMIN_USER_ID,
    WEBAPP_URL,
    HOOK_URL,
    HOOK_PATH,
  });

  await bot.telegram.setWebhook(HOOK_URL);
  console.log("Webhook set →", HOOK_URL);

  app.listen(PORT, "0.0.0.0", () => console.log("HTTP listening on", PORT));
}

start().catch((e) => {
  console.error("❌ Startup error:", e);
  process.exit(1);
});
