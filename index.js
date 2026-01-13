const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");

// Mini-app URL (le lien vers ta boutique)
const WEBAPP_URL =
  process.env.WEBAPP_URL ||
  process.env.NEXT_PUBLIC_WEBAPP_URL ||
  "https://TON-LIEN-MINIAPP-ICI";

// Paiements
const BTC_ADDRESS = process.env.BTC_ADDRESS || "TON_ADRESSE_BTC_ICI";
const TRANSCASH_HELP =
  process.env.TRANSCASH_HELP ||
  "Envoyez ici votre **code Transcash** (copiez/collez).";

// Stockage simple
const STORE_FILE =
  process.env.ORDERS_STORE || path.join(process.cwd(), "orders.json");

if (!BOT_TOKEN) throw new Error("❌ Missing BOT_TOKEN");

const bot = new Telegraf(BOT_TOKEN);

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

function formatOrder(order) {
  const lines = [];
  lines.push(`🧾 *Commande ${order.orderCode}*`);
  lines.push(
    `👤 User: ${order.username ? "@" + order.username : String(order.userId)}`
  );
  lines.push(`💶 Total: *${Number(order.totalEur).toFixed(2)} €*`);
  lines.push("");
  lines.push("📦 Articles :");
  for (const it of order.items || []) {
    const opt =
      it.options && Object.keys(it.options).length
        ? ` (${Object.entries(it.options)
            .map(
              ([k, v]) =>
                `${k}:${Array.isArray(v) ? v.join(",") : String(v)}`
            )
            .join(" | ")})`
        : "";
    lines.push(
      `- ${Number(it.qty || 1)} × ${String(it.nom || "")} — ${Number(
        it.prix || 0
      ).toFixed(2)}€${opt}`
    );
  }
  if (order.transcashCode) lines.push(`\n💳 Transcash reçu: *${order.transcashCode}*`);
  if (order.labelFileId) lines.push(`\n📄 PDF reçu ✅`);
  lines.push(`\n📌 Statut: *${order.status}*`);
  return lines.join("\n");
}

function adminKeyboard(orderCode) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Paiement validé", `adm_paid:${orderCode}`),
      Markup.button.callback("❌ Annuler", `adm_cancel:${orderCode}`),
    ],
    [
      Markup.button.callback("📄 Demander PDF", `adm_needpdf:${orderCode}`),
      Markup.button.callback("✅ Terminer", `adm_done:${orderCode}`),
    ],
  ]);
}

function userPayKeyboard(orderCode) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("₿ J’ai payé en BTC", `usr_btc:${orderCode}`),
      Markup.button.callback("💳 Envoyer code Transcash", `usr_tc:${orderCode}`),
    ],
    [Markup.button.callback("❌ Annuler la commande", `usr_cancel:${orderCode}`)],
  ]);
}

function findLatestOrderForUser(store, userId) {
  const all = Object.values(store.orders || {});
  const list = all.filter((o) => o.userId === userId);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list[0] || null;
}

// ✅ START + bouton boutique
bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi\n\nOuvrez le catalogue 👇",
    Markup.inlineKeyboard([
      [Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)],
    ])
  );
});

// ✅ réception commande envoyée par la mini-app (sendData)
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;

  // 1) web_app_data (commande)
  if (msg && msg.web_app_data && msg.web_app_data.data) {
    let payload = null;
    try {
      payload = JSON.parse(msg.web_app_data.data);
    } catch {
      payload = null;
    }

    if (!payload || payload.type !== "ORDER") {
      await ctx.reply("❌ Commande invalide.");
      return;
    }

    const store = loadStore();
    const orderCode = newOrderCode();

    const userId = ctx.from.id;
    const username = ctx.from.username || "";

    const items = Array.isArray(payload.items) ? payload.items : [];
    const totalEur = Number(payload.totalEur || 0);

    const order = {
      orderCode,
      userId,
      username,
      items: items.map((it) => ({
        id: it.id,
        nom: String(it.nom || ""),
        prix: Number(it.prix || 0),
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
      `✅ *Commande reçue : ${orderCode}*\n\n` +
        `💶 Total: *${totalEur.toFixed(2)} €*\n\n` +
        `🔸 *Paiement BTC*\nAdresse: \`${BTC_ADDRESS}\`\n` +
        `👉 Merci d’indiquer *${orderCode}* en référence.\n\n` +
        `🔸 *Transcash*\n${TRANSCASH_HELP}\n\n` +
        `Une fois payé, je vous demanderai votre *étiquette PDF*.`,
      userPayKeyboard(orderCode)
    );

    // notif admin
    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, formatOrder(order), {
        parse_mode: "Markdown",
        ...adminKeyboard(orderCode),
      });
    }

    return;
  }

  // 2) PDF reçu
  if (msg && msg.document && msg.document.mime_type === "application/pdf") {
    const store = loadStore();
    const latest = findLatestOrderForUser(store, ctx.from.id);

    if (!latest) {
      await ctx.reply(
        "Je ne retrouve pas votre commande. Merci d’indiquer le code commande."
      );
      return;
    }
    if (latest.status !== "AWAITING_LABEL") {
      await ctx.reply(
        "Je n’attends pas encore l’étiquette PDF. Attendez la validation du paiement."
      );
      return;
    }

    latest.labelFileId = msg.document.file_id;
    latest.status = "DONE";
    store.orders[latest.orderCode] = latest;
    saveStore(store);

    await ctx.reply("✅ PDF reçu ! Merci, votre commande est en cours de traitement.");

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📄 PDF reçu pour *${latest.orderCode}* ✅`,
        { parse_mode: "Markdown" }
      );
      await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
    }
    return;
  }

  // 3) Transcash (texte)
  if (msg && typeof msg.text === "string") {
    const text = msg.text.trim();
    const looksLikeCode =
      text.length >= 10 && text.length <= 40 && /[A-Za-z0-9]/.test(text);

    if (looksLikeCode) {
      const store = loadStore();
      const latest = findLatestOrderForUser(store, ctx.from.id);

      if (latest && latest.status === "AWAITING_PAYMENT") {
        latest.transcashCode = text;
        store.orders[latest.orderCode] = latest;
        saveStore(store);

        await ctx.reply(
          `✅ Code Transcash reçu pour ${latest.orderCode}.\nJe valide et je vous demanderai le PDF.`
        );

        if (ADMIN_CHAT_ID) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `💳 Transcash reçu ✅\nCommande: *${latest.orderCode}*\nCode: *${text}*`,
            { parse_mode: "Markdown", ...adminKeyboard(latest.orderCode) }
          );
        }
        return;
      }
    }
  }

  return next();
});

// ---- ACTIONS USER ----
bot.action(/^usr_btc:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  await ctx.answerCbQuery("OK");
  await ctx.replyWithMarkdown(
    `Merci ✅\nJe vérifie le paiement BTC pour *${orderCode}*.\nDès validation, je vous demanderai le PDF.`
  );

  if (ADMIN_CHAT_ID) {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `₿ Client indique paiement BTC\nCommande: *${orderCode}*`,
      { parse_mode: "Markdown", ...adminKeyboard(orderCode) }
    );
  }
});

bot.action(/^usr_tc:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("OK");
  await ctx.replyWithMarkdown(
    `💳 Envoyez maintenant votre *code Transcash* pour la commande *${orderCode}* (copier/coller).`
  );
});

bot.action(/^usr_cancel:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Commande introuvable");
  if (ctx.from.id !== order.userId) return ctx.answerCbQuery("Non autorisé");

  order.status = "CANCELED";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Annulée");
  await ctx.reply(`❌ Commande ${orderCode} annulée.`);

  if (ADMIN_CHAT_ID) {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `❌ Client a annulé la commande *${orderCode}*`,
      { parse_mode: "Markdown" }
    );
  }
});

// ---- ACTIONS ADMIN ----
bot.action(/^adm_paid:(.+)$/, async (ctx) => {
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID)
    return ctx.answerCbQuery("Admin only");

  const orderCode = ctx.match[1];
  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  order.status = "AWAITING_LABEL";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Validé");
  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      ...adminKeyboard(orderCode),
    });
  } catch {}

  await bot.telegram.sendMessage(
    order.userId,
    `✅ Paiement validé pour *${orderCode}*.\n\n📄 Envoyez maintenant votre *étiquette PDF* ici (en document).`,
    { parse_mode: "Markdown" }
  );
});

bot.action(/^adm_needpdf:(.+)$/, async (ctx) => {
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID)
    return ctx.answerCbQuery("Admin only");

  const orderCode = ctx.match[1];
  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  order.status = "AWAITING_LABEL";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Demandé");
  await bot.telegram.sendMessage(
    order.userId,
    `📄 Merci d’envoyer votre *étiquette PDF* pour la commande *${orderCode}*.`,
    { parse_mode: "Markdown" }
  );
});

bot.action(/^adm_cancel:(.+)$/, async (ctx) => {
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID)
    return ctx.answerCbQuery("Admin only");

  const orderCode = ctx.match[1];
  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  order.status = "CANCELED";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Annulé");
  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      ...adminKeyboard(orderCode),
    });
  } catch {}

  await bot.telegram.sendMessage(order.userId, `❌ Commande *${orderCode}* annulée.`, {
    parse_mode: "Markdown",
  });
});

bot.action(/^adm_done:(.+)$/, async (ctx) => {
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID)
    return ctx.answerCbQuery("Admin only");

  const orderCode = ctx.match[1];
  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Commande introuvable");

  order.status = "DONE";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("OK");
  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      ...adminKeyboard(orderCode),
    });
  } catch {}

  await bot.telegram.sendMessage(
    order.userId,
    `✅ Commande *${orderCode}* finalisée. Merci !`,
    { parse_mode: "Markdown" }
  );
});

// Lancement
bot.launch();
console.log("✅ Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
