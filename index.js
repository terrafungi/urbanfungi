/**
 * UrbanFungi Bot — Telegraf + Webhook + Express (Render friendly)
 * - Mini-app shop (button WebApp)
 * - Réception commande via Telegram.WebApp.sendData() => web_app_data
 * - Paiement BTC / Transcash
 * - Validation admin => demande PDF
 * - Réception PDF => forward admin
 *
 * IMPORTANT:
 * - Ce bot tourne en WEBHOOK (pas de polling)
 * - Sur Render: service = Web Service (pas Background Worker)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

// ========================= ENV =========================
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN manquant");

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
if (!WEBAPP_URL) throw new Error("❌ WEBAPP_URL manquant (URL miniapp)");

/**
 * ADMIN_CHAT_ID = où recevoir les notifications (ton DM ou un groupe)
 * ADMIN_USER_ID = ton user_id Telegram (sert à sécuriser les boutons admin)
 *
 * Si tu n’as pas de groupe: mets ADMIN_CHAT_ID = ton chat_id (souvent même valeur que user_id en DM).
 */
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || "0");

// Paiements
const BTC_ADDRESS = (process.env.BTC_ADDRESS || "").trim();
const TRANSCASH_TEXT =
  (process.env.TRANSCASH_TEXT || "").trim() ||
  "Envoyez votre code Transcash (copier/coller) + montant exact dans ce chat.";

// Webhook Render
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || "").trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

if (!WEBHOOK_BASE_URL) {
  throw new Error(
    '❌ WEBHOOK_BASE_URL manquant (ex: "https://urbanfungi-tp50.onrender.com")'
  );
}
if (!WEBHOOK_SECRET) {
  throw new Error('❌ WEBHOOK_SECRET manquant (ex: "uf_x9Kp2dLx7")');
}

const PORT = Number(process.env.PORT || "10000");

// ⚠️ le path secret webhook
const HOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const HOOK_URL = `${WEBHOOK_BASE_URL.replace(/\/+$/, "")}${HOOK_PATH}`;

// ========================= STORE (fichier) =========================
// ⚠️ Sur Render, le filesystem peut être reset au redeploy (ou si pas de disque).
// Pour production, utiliser DB ou Render Disk.
const STORE_FILE =
  (process.env.ORDERS_STORE || "").trim() ||
  path.join(process.cwd(), "orders.json");

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

// ========================= Helpers HTML =========================
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatOrderHTML(order) {
  const lines = [];
  lines.push(`🧾 <b>Commande ${escapeHtml(order.orderCode)}</b>`);
  lines.push(
    `👤 Client: <b>${
      order.username ? "@" + escapeHtml(order.username) : escapeHtml(order.userId)
    }</b>`
  );
  lines.push(`💶 Total: <b>${escapeHtml(euro(order.totalEur))} €</b>`);
  lines.push("");
  lines.push("📦 <b>Articles :</b>");
  for (const it of order.items || []) {
    const qty = Number(it.qty || 1);
    const name = escapeHtml(it.nom || it.id || "Produit");

    let opts = "";
    if (it.options && typeof it.options === "object" && Object.keys(it.options).length) {
      const optText = Object.entries(it.options)
        .map(([k, v]) => {
          const val = Array.isArray(v) ? v.join(",") : String(v);
          return `${escapeHtml(k)}:${escapeHtml(val)}`;
        })
        .join(" | ");
      opts = ` <i>(${optText})</i>`;
    }
    lines.push(`• x${qty} ${name}${opts}`);
  }
  lines.push("");
  lines.push(`📌 Statut: <b>${escapeHtml(order.status)}</b>`);
  return lines.join("\n");
}

// ========================= Keyboards =========================
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

// ========================= ADMIN check =========================
function isAdmin(ctx) {
  // sécurisé si ADMIN_USER_ID défini
  if (ADMIN_USER_ID) return ctx.from?.id === ADMIN_USER_ID;

  // fallback: si pas défini, on laisse passer (pas recommandé)
  return true;
}

// ========================= BOT =========================
const bot = new Telegraf(BOT_TOKEN);

// Logs d’updates (très utile)
bot.use(async (ctx, next) => {
  try {
    const short = {
      updateType: ctx.updateType,
      from: ctx.from?.id,
      chat: ctx.chat?.id,
      hasWebAppData: !!ctx.message?.web_app_data?.data,
      hasDocument: !!ctx.message?.document,
      text: ctx.message?.text ? String(ctx.message.text).slice(0, 80) : undefined,
    };
    console.log("TG UPDATE:", JSON.stringify(short));
  } catch {}
  return next();
});

bot.command("id", async (ctx) => {
  await ctx.reply(`user_id=${ctx.from.id}\nchat_id=${ctx.chat.id}`);
});

bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot OK");
});

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

// DEBUG webhook (vérifie où Telegram envoie)
bot.command("debug_webhook", async (ctx) => {
  const info = await bot.telegram.getWebhookInfo();
  await ctx.reply(
    "Webhook info:\n" +
      `url=${info.url || "none"}\n` +
      `pending=${info.pending_update_count}\n` +
      `last_error=${info.last_error_message || "none"}`
  );
});

// Réception messages (commande / pdf / transcash)
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;

  // 1) Commande envoyée par miniapp via Telegram.WebApp.sendData()
  if (msg?.web_app_data?.data) {
    console.log("WEB_APP_DATA RAW:", msg.web_app_data.data);

    let payload;
    try {
      payload = JSON.parse(msg.web_app_data.data);
    } catch {
      await ctx.reply("❌ Données commande illisibles (JSON invalide).");
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

    await ctx.replyWithHTML(
      `✅ <b>Commande reçue : ${escapeHtml(orderCode)}</b>\n\n` +
        `💶 Total: <b>${escapeHtml(euro(totalEur))} €</b>\n\n` +
        `Choisissez votre moyen de paiement 👇`,
      payKeyboard(orderCode)
    );

    // Notif admin
    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, formatOrderHTML(order), {
        parse_mode: "HTML",
        ...adminKeyboard(orderCode),
      });
      console.log("ADMIN NOTIF SENT to", ADMIN_CHAT_ID, "for", orderCode);
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

    await ctx.reply("✅ PDF reçu ! Merci, on traite la commande.");

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📄 PDF reçu pour <b>${escapeHtml(current.orderCode)}</b> ✅`,
        { parse_mode: "HTML" }
      );
      await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
    }
    return;
  }

  // 3) Transcash (texte)
  if (typeof msg?.text === "string") {
    const text = msg.text.trim();

    // heuristique simple
    const looksLikeCode = text.length >= 10 && text.length <= 40 && /[A-Za-z0-9]/.test(text);

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
          `✅ Code Transcash reçu pour ${current.orderCode}.\nOn valide et on vous demandera le PDF.`
        );

        if (ADMIN_CHAT_ID) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `💳 Transcash reçu ✅\nCommande: <b>${escapeHtml(
              current.orderCode
            )}</b>\nCode: <code>${escapeHtml(text)}</code>`,
            { parse_mode: "HTML", ...adminKeyboard(current.orderCode) }
          );
        }
        return;
      }
    }
  }

  return next();
});

// ========================= ACTIONS CLIENT =========================
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("BTC");

  if (!BTC_ADDRESS) {
    await ctx.reply("❌ Adresse BTC non configurée (admin).");
    return;
  }

  await ctx.replyWithHTML(
    `₿ <b>Bitcoin — ${escapeHtml(orderCode)}</b>\n\n` +
      `Adresse: <code>${escapeHtml(BTC_ADDRESS)}</code>\n\n` +
      `Après paiement, envoyez une preuve ici.\n` +
      `Ensuite on vous demandera l'étiquette PDF.`
  );
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("Transcash");

  await ctx.replyWithHTML(
    `💳 <b>Transcash — ${escapeHtml(orderCode)}</b>\n\n` +
      `${escapeHtml(TRANSCASH_TEXT)}\n\n` +
      `Envoyez maintenant votre <b>code Transcash</b> dans le chat.`
  );
});

bot.action(/^SEND_PDF:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("OK");

  await ctx.replyWithHTML(
    `📄 Envoyez maintenant votre <b>étiquette PDF</b> pour la commande <b>${escapeHtml(
      orderCode
    )}</b>.`
  );
});

// ========================= ACTIONS ADMIN =========================
bot.action(/^ADM_PAID:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];

  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Admin only", { show_alert: true });
    return;
  }

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) {
    await ctx.answerCbQuery("Introuvable", { show_alert: true });
    return;
  }

  order.status = "AWAITING_LABEL";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Validé ✅");

  // Message client
  await bot.telegram.sendMessage(
    order.userId,
    `✅ Paiement validé pour <b>${escapeHtml(orderCode)}</b>.\n\n📄 Envoyez maintenant votre <b>étiquette PDF</b> ici (document).`,
    { parse_mode: "HTML" }
  );

  // (optionnel) tente de mettre à jour le message admin
  try {
    await ctx.editMessageText(formatOrderHTML(order), {
      parse_mode: "HTML",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_CANCEL:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];

  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Admin only", { show_alert: true });
    return;
  }

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) {
    await ctx.answerCbQuery("Introuvable", { show_alert: true });
    return;
  }

  order.status = "CANCELED";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Annulé");

  await bot.telegram.sendMessage(order.userId, `❌ Commande <b>${escapeHtml(orderCode)}</b> annulée.`, {
    parse_mode: "HTML",
  });

  try {
    await ctx.editMessageText(formatOrderHTML(order), {
      parse_mode: "HTML",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_DONE:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];

  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Admin only", { show_alert: true });
    return;
  }

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) {
    await ctx.answerCbQuery("Introuvable", { show_alert: true });
    return;
  }

  order.status = "DONE";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("OK");

  await bot.telegram.sendMessage(
    order.userId,
    `✅ Commande <b>${escapeHtml(orderCode)}</b> finalisée. Merci !`,
    { parse_mode: "HTML" }
  );

  try {
    await ctx.editMessageText(formatOrderHTML(order), {
      parse_mode: "HTML",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

// ========================= EXPRESS WEBHOOK SERVER =========================
const app = express();

// Body JSON (Telegram envoie du JSON)
app.use(express.json({ limit: "2mb" }));

// Log HTTP => tu verras si Telegram POST bien sur /telegraf/...
app.use((req, _res, next) => {
  console.log("HTTP IN:", req.method, req.originalUrl);
  next();
});

// Health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ✅ IMPORTANT : NE PAS monter sur HOOK_PATH (sinon Telegraf ne matche plus)
// ✅ On laisse Telegraf matcher l’URL lui-même
app.use(bot.webhookCallback(HOOK_PATH));

async function start() {
  // Pose le webhook Telegram vers TON service Render
  await bot.telegram.setWebhook(HOOK_URL);
  console.log("✅ Webhook set:", HOOK_URL);
  console.log("✅ HOOK_PATH:", HOOK_PATH);
  console.log("✅ ADMIN_CHAT_ID:", ADMIN_CHAT_ID, "ADMIN_USER_ID:", ADMIN_USER_ID);

  // Ouvre un port détectable par Render
  app.listen(PORT, "0.0.0.0", () => {
    console.log("✅ HTTP listening on", PORT);
    console.log("✅ Service is live");
  });
}

start().catch((e) => {
  console.error("❌ Startup error:", e);
  process.exit(1);
});
