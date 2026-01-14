/**
 * UrbanFungi Bot — Telegraf + Webhook + Express (Render)
 * - MiniApp -> ORDER via WebApp sendData()
 * - Paiement BTC / Transcash
 * - Admin valide -> demande PDF
 * - PDF reçu -> forward admin
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
  await ctx.reply("🍄 UrbanFungi\n\nCliquez ci-dessous :", userKeyboard());
  await ctx.reply("Si le bouton disparaît : /shop", userInlineShop());
});

bot.command("shop", async (ctx) => {
  await ctx.reply("🛒 Ouvrir la boutique :", userKeyboard());
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

    await ctx.reply("✅ PDF reçu ! Merci, on traite la commande.");

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `📄 PDF reçu pour *${current.orderCode}* ✅`, {
        parse_mode: "Markdown",
      });
      await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
    }
    return;
  }

  // 3) Transcash (texte) -> on accepte TOUT si la commande est en mode TRANSCASH
  if (typeof msg?.text === "string") {
    const text = msg.text.trim();
    const store = loadStore();
    const orders = Object.values(store.orders || {}).filter((o) => o.userId === ctx.from.id);
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const current = orders.find(
      (o) => o.status === "AWAITING_PAYMENT" && o.paymentMethod === "TRANSCASH"
    );

    if (current) {
      // Exemple: "RTGVCGH 55€" -> code = premier bloc, montant = le reste
      const parts = text.split(/\s+/).filter(Boolean);
      const code = parts[0] || text;
      const amount = parts.slice(1).join(" ").trim();

      current.transcashCode = code;
      current.transcashAmount = amount;
      store.orders[current.orderCode] = current;
      saveStore(store);

      await ctx.reply(
        `✅ Transcash reçu pour ${current.orderCode}.\n` +
          `Code: ${code}${amount ? `\nMontant: ${amount}` : ""}\n\n` +
          `On valide le paiement puis on vous demandera l'étiquette PDF.`
      );

      // NOTIF ADMIN + BOUTONS
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `💳 Transcash reçu ✅\nCommande: *${current.orderCode}*\nCode: \`${code}\`${amount ? `\nMontant: *${amount}*` : ""}`,
          {
            parse_mode: "Markdown",
            reply_markup: adminKeyboard(current.orderCode).reply_markup,
          }
        );
        console.log("ADMIN transcash notif sent for", current.orderCode);
      }
      return;
    }
  }

  return next();
});

// ================== ACTIONS CLIENT ==================
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("BTC");

  const store = loadStore();
  const order = store.orders?.[orderCode];
  if (order) {
    order.paymentMethod = "BTC";
    store.orders[orderCode] = order;
    saveStore(store);
  }

  if (!BTC_ADDRESS) {
    await ctx.reply("❌ Adresse BTC non configurée (admin).");
    return;
  }

  await ctx.replyWithMarkdown(
    `₿ *Bitcoin — ${orderCode}*\n\nAdresse: \`${BTC_ADDRESS}\`\n\nAprès paiement, envoyez une preuve ici.\nEnsuite on vous demandera l'étiquette PDF.`
  );
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("Transcash");

  const store = loadStore();
  const order = store.orders?.[orderCode];
  if (order) {
    order.paymentMethod = "TRANSCASH";
    store.orders[orderCode] = order;
    saveStore(store);
  }

  await ctx.replyWithMarkdown(
    `💳 *Transcash — ${orderCode}*\n\n${TRANSCASH_TEXT}\n\nEnvoyez maintenant votre *code Transcash* (vous pouvez mettre aussi le montant).`
  );
});

bot.action(/^SEND_PDF:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("OK");
  await ctx.replyWithMarkdown(`📄 Envoyez maintenant votre *étiquette PDF* pour la commande *${orderCode}*.`);
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
  const order = store.orders?.[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable", { show_alert: true });

  order.status = "CANCELED";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Annulé");
  await bot.telegram.sendMessage(order.userId, `❌ Commande *${orderCode}* annulée.`, {
    parse_mode: "Markdown",
  });

  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      reply_markup: adminKeyboard(orderCode).reply_markup,
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
  saveStore(store);

  await ctx.answerCbQuery("OK");
  await bot.telegram.sendMessage(order.userId, `✅ Commande *${orderCode}* finalisée. Merci !`, {
    parse_mode: "Markdown",
  });

  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      reply_markup: adminKeyboard(orderCode).reply_markup,
    });
  } catch {}
});

// ================== EXPRESS WEBHOOK SERVER ==================
const app = express();

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.use(bot.webhookCallback(HOOK_PATH));

async function start() {
  await bot.telegram.setWebhook(HOOK_URL);
  console.log("Webhook set →", HOOK_URL);
  console.log("ADMIN_CHAT_ID =", ADMIN_CHAT_ID, "ADMIN_USER_ID =", ADMIN_USER_ID);

  app.listen(PORT, "0.0.0.0", () => {
    console.log("HTTP listening on", PORT);
    console.log("Bot webhook path:", HOOK_PATH);
  });
}

start().catch((e) => {
  console.error("❌ Startup error:", e);
  process.exit(1);
});
