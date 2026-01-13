const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN manquant");

const WEBAPP_URL = process.env.WEBAPP_URL || "https://TON-URL-MINIAPP/";
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || "0");

const BTC_ADDRESS = process.env.BTC_ADDRESS || "TON_ADRESSE_BTC_ICI";
const TRANSCASH_TEXT =
  process.env.TRANSCASH_TEXT ||
  "Envoyez votre code Transcash (copier/coller) + montant exact dans ce chat.";

// ========= STORE (simple fichier) =========
// (sur Render, ça peut être reset si redeploy, mais suffisant)
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

function userKeyboard() {
  return Markup.keyboard([[Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)]])
    .resize()
    .persistent();
}

function userInlineShop() {
  return Markup.inlineKeyboard([
    [Markup.button.webApp("🛒 Ouvrir la boutique", WEBAPP_URL)],
  ]);
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

const bot = new Telegraf(BOT_TOKEN);

// ========= START / SHOP =========
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

// ========= RÉCEPTION COMMANDE (web_app_data) =========
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;

  // 1) Commande envoyée par MiniApp (sendData)
  if (msg?.web_app_data?.data) {
    let payload = null;
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

    // Message client
    await ctx.replyWithMarkdown(
      `✅ *Commande reçue : ${orderCode}*\n\n` +
        `💶 Total: *${euro(totalEur)} €*\n\n` +
        `Choisissez votre moyen de paiement 👇`,
      payKeyboard(orderCode)
    );

    // Notif admin
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
    // prend la dernière commande de cet user en attente PDF
    const orders = Object.values(store.orders || {}).filter(
      (o) => o.userId === ctx.from.id
    );
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
    const looksLikeCode = text.length >= 10 && text.length <= 40 && /[A-Za-z0-9]/.test(text);

    if (looksLikeCode) {
      const store = loadStore();
      const orders = Object.values(store.orders || {}).filter(
        (o) => o.userId === ctx.from.id
      );
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

// ========= ACTIONS CLIENT =========
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("BTC");

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

bot.action(/^SEND_PDF:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("OK");
  await ctx.replyWithMarkdown(
    `📄 Envoyez maintenant votre *étiquette PDF* pour la commande *${orderCode}*.`
  );
});

// ========= ACTIONS ADMIN =========
bot.action(/^ADM_PAID:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID) return ctx.answerCbQuery("Admin only");

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable");

  order.status = "AWAITING_LABEL";
  store.orders[orderCode] = order;
  saveStore(store);

  await ctx.answerCbQuery("Validé ✅");
  await bot.telegram.sendMessage(
    order.userId,
    `✅ Paiement validé pour *${orderCode}*.\n\n📄 Envoyez maintenant votre *étiquette PDF* ici (document).`,
    { parse_mode: "Markdown" }
  );

  try {
    await ctx.editMessageText(formatOrder(order), {
      parse_mode: "Markdown",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_CANCEL:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID) return ctx.answerCbQuery("Admin only");

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable");

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
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_DONE:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (ADMIN_CHAT_ID && ctx.from.id !== ADMIN_CHAT_ID) return ctx.answerCbQuery("Admin only");

  const store = loadStore();
  const order = store.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable");

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
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

// ========= LAUNCH =========
bot.launch();
console.log("✅ Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
