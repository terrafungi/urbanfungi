/**
 * UrbanFungi Bot — Telegraf + Webhook + Express (Render friendly)
 * - Paiement BTC / Transcash
 * - Validation admin -> demande PDF
 * - Réception PDF (document) -> forward admin
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
  "Envoyez votre code Transcash (copier/coller) + montant exact dans ce chat.";

// IMPORTANT : base webhook = URL DU SERVICE BOT (celle affichée dans Render)
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || "").trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

if (!WEBHOOK_BASE_URL) {
  throw new Error('❌ WEBHOOK_BASE_URL manquant (ex: "https://urbanfungi-tp50.onrender.com")');
}
if (!WEBHOOK_SECRET) {
  throw new Error('❌ WEBHOOK_SECRET manquant (ex: "uf_x9Kp2dLx7")');
}

const PORT = Number(process.env.PORT || "10000");
const HOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const HOOK_URL = `${WEBHOOK_BASE_URL.replace(/\/+$/, "")}${HOOK_PATH}`;

// ================== STORE (fichier simple) ==================
const STORE_FILE = process.env.ORDERS_STORE || path.join(process.cwd(), "orders.json");

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return { orders: {}, users: {} };
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      orders: parsed.orders || {},
      users: parsed.users || {},
    };
  } catch {
    return { orders: {}, users: {} };
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function setExpectedOrder(store, userId, orderCode) {
  store.users = store.users || {};
  store.users[String(userId)] = {
    ...(store.users[String(userId)] || {}),
    expectedOrderCode: orderCode || "",
    updatedAt: Date.now(),
  };
}
function getExpectedOrderCode(store, userId) {
  return store.users?.[String(userId)]?.expectedOrderCode || "";
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

// ================== AUTH ==================
function isAdmin(ctx) {
  if (ADMIN_USER_ID) return ctx.from?.id === ADMIN_USER_ID;
  return false;
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

// LOGS Telegram (hyper utile)
bot.use(async (ctx, next) => {
  try {
    const msg = ctx.message;
    const brief = {
      updateType: ctx.updateType,
      from: ctx.from?.id,
      chat: ctx.chat?.id,
      hasWebAppData: !!msg?.web_app_data?.data,
      hasDocument: !!msg?.document,
      text: msg?.text || "",
      docMime: msg?.document?.mime_type || "",
      docName: msg?.document?.file_name || "",
    };
    if (brief.text === "/ping") console.log(`PING from ${brief.from}`);
    else if (brief.text === "/start") console.log(`START from ${brief.from}`);
    else if (brief.text) console.log(`TEXT from ${brief.from}: ${brief.text}`);
    else if (brief.hasWebAppData) console.log(`WEBAPP_DATA from ${brief.from}`);
    else if (brief.hasDocument) console.log(`DOC from ${brief.from}: ${brief.docName} (${brief.docMime})`);
    else console.log("TG UPDATE:", JSON.stringify(brief));
  } catch {}
  return next();
});

bot.command("id", async (ctx) => {
  await ctx.reply(`user_id=${ctx.from.id}\nchat_id=${ctx.chat.id}`);
});

// /start & /shop
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

// ping debug
bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot OK");
});

// ================== RÉCEPTION MESSAGES (commande / pdf / transcash) ==================
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
      transcashCode: "",
      labelFileId: "",
      createdAt: Date.now(),
    };

    store.orders[orderCode] = order;
    // (sécurité) on efface l'attente PDF précédente, si existait
    setExpectedOrder(store, ctx.from.id, "");
    saveStore(store);

    await ctx.replyWithMarkdown(
      `✅ *Commande reçue : ${orderCode}*\n\n` +
        `💶 Total: *${euro(totalEur)} €*\n\n` +
        `Choisissez votre moyen de paiement 👇`,
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

  // 2) PDF reçu (robuste)
  const isPdf =
    msg?.document &&
    (msg.document.mime_type === "application/pdf" ||
      (msg.document.file_name || "").toLowerCase().endsWith(".pdf"));

  if (isPdf) {
    const store = loadStore();

    // 2a) priorité : expectedOrderCode (défini quand tu valides le paiement)
    let targetOrder = null;
    const expected = getExpectedOrderCode(store, ctx.from.id);
    if (expected && store.orders?.[expected]) {
      targetOrder = store.orders[expected];
    }

    // 2b) fallback : cherche une commande en AWAITING_LABEL
    if (!targetOrder) {
      const orders = Object.values(store.orders || {}).filter((o) => Number(o.userId) === Number(ctx.from.id));
      orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      targetOrder = orders.find((o) => o.status === "AWAITING_LABEL") || null;
    }

    if (!targetOrder) {
      await ctx.reply("Je n’attends pas encore le PDF (attendez la validation du paiement).");
      return;
    }

    if (targetOrder.status !== "AWAITING_LABEL") {
      // on force en état attendu si jamais ça a glissé
      targetOrder.status = "AWAITING_LABEL";
    }

    targetOrder.labelFileId = msg.document.file_id;
    targetOrder.status = "DONE";

    store.orders[targetOrder.orderCode] = targetOrder;
    // on efface l'attente PDF
    setExpectedOrder(store, ctx.from.id, "");
    saveStore(store);

    await ctx.reply("✅ PDF reçu ! Merci, on traite la commande.");

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📄 PDF reçu pour *${targetOrder.orderCode}* ✅`,
        { parse_mode: "Markdown" }
      );
      await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
    }
    return;
  }

  // 3) Transcash (texte)
  if (typeof msg?.text === "string") {
    const text = msg.text.trim();
    const looksLikeCode = text.length >= 6 && text.length <= 60 && /[A-Za-z0-9]/.test(text);

    if (looksLikeCode) {
      const store = loadStore();
      const orders = Object.values(store.orders || {}).filter((o) => Number(o.userId) === Number(ctx.from.id));
      orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const current = orders.find((o) => o.status === "AWAITING_PAYMENT");

      if (current) {
        current.transcashCode = text;
        store.orders[current.orderCode] = current;
        saveStore(store);

        await ctx.reply(
          `✅ Code Transcash reçu pour ${current.orderCode}.\n` +
            `On valide et on vous demandera le PDF.`
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

  if (!BTC_ADDRESS) {
    await ctx.reply("❌ Adresse BTC non configurée (admin).");
    return;
  }

  await ctx.replyWithMarkdown(
    `₿ *Bitcoin — ${orderCode}*\n\n` +
      `Adresse: \`${BTC_ADDRESS}\`\n\n` +
      `Après paiement, envoyez une preuve ici.\n` +
      `Ensuite on vous demandera l'étiquette PDF.`
  );
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("Transcash");

  await ctx.replyWithMarkdown(
    `💳 *Transcash — ${orderCode}*\n\n` +
      `${TRANSCASH_TEXT}\n\n` +
      `Envoyez maintenant votre *code Transcash* dans le chat.`
  );
});

// ================== ACTIONS ADMIN ==================
bot.action(/^ADM_PAID:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];

  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only", { show_alert: true });

  const store = loadStore();
  const order = store.orders?.[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "AWAITING_LABEL";
  store.orders[orderCode] = order;

  // ✅ clé du fix : on mémorise quel PDF on attend pour cet utilisateur
  setExpectedOrder(store, order.userId, orderCode);

  saveStore(store);

  await ctx.answerCbQuery("Validé ✅");

  // Message client
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
  const order = store.orders?.[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "CANCELED";
  store.orders[orderCode] = order;
  // si on attendait ce PDF, on clear
  const expected = getExpectedOrderCode(store, order.userId);
  if (expected === orderCode) setExpectedOrder(store, order.userId, "");
  saveStore(store);

  await ctx.answerCbQuery("Annulé");
  await bot.telegram.sendMessage(order.userId, `❌ Commande *${orderCode}* annulée.`, {
    parse_mode: "Markdown",
  });

  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_DONE:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only", { show_alert: true });

  const store = loadStore();
  const order = store.orders?.[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "DONE";
  store.orders[orderCode] = order;
  const expected = getExpectedOrderCode(store, order.userId);
  if (expected === orderCode) setExpectedOrder(store, order.userId, "");
  saveStore(store);

  await ctx.answerCbQuery("OK");
  await bot.telegram.sendMessage(order.userId, `✅ Commande *${orderCode}* finalisée. Merci !`, {
    parse_mode: "Markdown",
  });

  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

// ================== EXPRESS WEBHOOK SERVER ==================
const app = express();

// logs HTTP Render
app.use((req, _res, next) => {
  console.log(`HTTP IN: ${req.method} ${req.path}`);
  next();
});

// Health OK (Render)
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Webhook Telegraf
app.use(bot.webhookCallback(HOOK_PATH));

async function start() {
  await bot.telegram.setWebhook(HOOK_URL);
  console.log("Webhook set →", HOOK_URL);
  console.log("STORE_FILE →", STORE_FILE);
  console.log("ADMIN_CHAT_ID:", ADMIN_CHAT_ID, "ADMIN_USER_ID:", ADMIN_USER_ID);

  app.listen(PORT, "0.0.0.0", () => {
    console.log("HTTP listening on", PORT);
    console.log("Bot webhook path:", HOOK_PATH);
  });
}

start().catch((e) => {
  console.error("❌ Startup error:", e);
  process.exit(1);
});
