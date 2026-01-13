const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN manquant");

const WEBAPP_URL = process.env.WEBAPP_URL || "https://urbanfungi-miniapp.onrender.com";
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "").trim(); // ex: "123456789"

const BTC_ADDRESS = process.env.BTC_ADDRESS || "TON_ADRESSE_BTC_ICI";
const TRANSCASH_TEXT =
  process.env.TRANSCASH_TEXT ||
  "Envoyez votre code Transcash (copier/coller) + le montant exact dans ce chat.";

// ✅ Sur Render, /tmp est writable. (Le dossier du projet peut être read-only selon config)
const STORE_FILE =
  process.env.ORDERS_STORE ||
  path.join(process.env.TMPDIR || "/tmp", "urbanfungi_orders.json");

// ========= HELPERS =========
function euro(n) {
  return Number(n || 0).toFixed(2);
}

// MarkdownV2 escape (évite les erreurs Telegram)
function mdv2(s) {
  return String(s ?? "").replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// Store en mémoire + fichier (safe)
let STORE = { orders: {} };

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return { orders: {} };
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { orders: {} };
    if (!parsed.orders || typeof parsed.orders !== "object") parsed.orders = {};
    return parsed;
  } catch (e) {
    console.log("⚠ loadStore failed:", e.message);
    return { orders: {} };
  }
}

function saveStoreSafe(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (e) {
    console.log("⚠ saveStore failed:", e.message);
    // IMPORTANT: ne jamais throw => le bot doit continuer à répondre
  }
}

function newOrderCode() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `UF-${y}${m}${day}-${rnd}`;
}

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

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return false;
  return String(ctx.from?.id) === String(ADMIN_CHAT_ID);
}

function formatOrderMdV2(order) {
  const lines = [];
  lines.push(`🧾 *Commande* *${mdv2(order.orderCode)}*`);
  lines.push(
    `👤 Client: ${
      order.username ? `@${mdv2(order.username)}` : mdv2(order.userId)
    }`
  );
  lines.push(`💶 Total: *${mdv2(euro(order.totalEur))} €*`);
  lines.push("");
  lines.push("📦 Articles :");

  for (const it of order.items || []) {
    const name = mdv2(it.nom || it.id || "Produit");
    const qty = mdv2(Number(it.qty || 1));
    let opts = "";

    if (it.options && typeof it.options === "object" && Object.keys(it.options).length) {
      const optStr = Object.entries(it.options)
        .map(([k, v]) => `${mdv2(k)}:${mdv2(Array.isArray(v) ? v.join(",") : String(v))}`)
        .join(" \\| ");
      opts = ` \\(${optStr}\\)`;
    }

    lines.push(`• x${qty} ${name}${opts}`);
  }

  lines.push("");
  lines.push(`📌 Statut: *${mdv2(order.status)}*`);
  return lines.join("\n");
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);

// Charge le store au démarrage
STORE = loadStore();

// Catch global (évite crash silencieux)
bot.catch((err, ctx) => {
  console.log("❌ BOT ERROR:", err?.message || err);
});

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
bot.on("message", async (ctx) => {
  const msg = ctx.message;

  // 1) Commande envoyée par MiniApp (sendData)
  if (msg?.web_app_data?.data) {
    let payload;
    try {
      payload = JSON.parse(msg.web_app_data.data);
    } catch (e) {
      await ctx.reply("❌ Données commande illisibles.");
      return;
    }

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const totalEur = Number(payload?.totalEur || 0);

    if (!items.length) {
      await ctx.reply("❌ Commande vide.");
      return;
    }

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

    // ✅ Répondre AU CLIENT d’abord (même si le store plante)
    await ctx.reply(
      `✅ Commande reçue : ${orderCode}\n\n💶 Total: ${euro(totalEur)} €\n\nChoisissez votre moyen de paiement 👇`,
      payKeyboard(orderCode)
    );

    // ✅ Store safe
    STORE.orders[orderCode] = order;
    saveStoreSafe(STORE);

    // ✅ Notif admin (safe)
    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, formatOrderMdV2(order), {
          parse_mode: "MarkdownV2",
          ...adminKeyboard(orderCode),
        });
      } catch (e) {
        console.log("⚠ admin notify failed:", e.message);
      }
    }
    return;
  }

  // 2) PDF reçu
  if (msg?.document?.mime_type === "application/pdf") {
    const orders = Object.values(STORE.orders || {}).filter((o) => o.userId === ctx.from.id);
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const current = orders.find((o) => o.status === "AWAITING_LABEL");

    if (!current) {
      await ctx.reply("Je n’attends pas encore le PDF (attendez la validation du paiement).");
      return;
    }

    current.labelFileId = msg.document.file_id;
    current.status = "DONE";
    STORE.orders[current.orderCode] = current;
    saveStoreSafe(STORE);

    await ctx.reply("✅ PDF reçu ! Merci, on traite la commande.");

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `📄 PDF reçu pour *${mdv2(current.orderCode)}* ✅`,
          { parse_mode: "MarkdownV2" }
        );
        await bot.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, msg.message_id);
      } catch (e) {
        console.log("⚠ forward pdf failed:", e.message);
      }
    }
    return;
  }

  // 3) Transcash (texte)
  if (typeof msg?.text === "string") {
    const text = msg.text.trim();

    // heuristique simple: évite de capter "/start" "/shop"
    if (text.startsWith("/")) return;

    const looksLikeCode =
      text.length >= 10 && text.length <= 60 && /[A-Za-z0-9]/.test(text);

    if (looksLikeCode) {
      const orders = Object.values(STORE.orders || {}).filter((o) => o.userId === ctx.from.id);
      orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const current = orders.find((o) => o.status === "AWAITING_PAYMENT");

      if (current) {
        current.transcashCode = text;
        STORE.orders[current.orderCode] = current;
        saveStoreSafe(STORE);

        await ctx.reply(
          `✅ Code Transcash reçu pour ${current.orderCode}.\nOn valide et on vous demandera le PDF.`
        );

        if (ADMIN_CHAT_ID) {
          try {
            await bot.telegram.sendMessage(
              ADMIN_CHAT_ID,
              `💳 Transcash reçu ✅\nCommande: *${mdv2(current.orderCode)}*\nCode: \`${mdv2(text)}\``,
              { parse_mode: "MarkdownV2", ...adminKeyboard(current.orderCode) }
            );
          } catch (e) {
            console.log("⚠ admin transcash notify failed:", e.message);
          }
        }
      }
    }
  }
});

// ========= ACTIONS CLIENT =========
bot.action(/^PAY_BTC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("BTC");

  await ctx.replyWithMarkdownV2(
    `₿ *Bitcoin — ${mdv2(orderCode)}*\n\n` +
      `Adresse: \`${mdv2(BTC_ADDRESS)}\`\n\n` +
      `Après paiement, envoyez une preuve ici (TXID ou capture).\n` +
      `Ensuite on validera et on vous demandera l'étiquette PDF\\.`
  );
});

bot.action(/^PAY_TC:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  await ctx.answerCbQuery("Transcash");

  await ctx.replyWithMarkdownV2(
    `💳 *Transcash — ${mdv2(orderCode)}*\n\n` +
      `${mdv2(TRANSCASH_TEXT)}\n\n` +
      `Envoyez maintenant votre *code Transcash* dans le chat\\.`
  );
});

// ========= ACTIONS ADMIN =========
bot.action(/^ADM_PAID:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only");

  const order = STORE.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable");

  order.status = "AWAITING_LABEL";
  STORE.orders[orderCode] = order;
  saveStoreSafe(STORE);

  await ctx.answerCbQuery("Validé ✅");

  // Notifie le client
  try {
    await bot.telegram.sendMessage(
      order.userId,
      `✅ Paiement validé pour *${orderCode}*.\n\n📄 Envoyez maintenant votre *étiquette PDF* ici (en document).`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.log("⚠ notify client failed:", e.message);
  }

  // Update message admin
  try {
    await ctx.editMessageText(formatOrderMdV2(order), {
      parse_mode: "MarkdownV2",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_CANCEL:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only");

  const order = STORE.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable");

  order.status = "CANCELED";
  STORE.orders[orderCode] = order;
  saveStoreSafe(STORE);

  await ctx.answerCbQuery("Annulé");

  try {
    await bot.telegram.sendMessage(order.userId, `❌ Commande *${orderCode}* annulée.`, {
      parse_mode: "Markdown",
    });
  } catch {}

  try {
    await ctx.editMessageText(formatOrderMdV2(order), {
      parse_mode: "MarkdownV2",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

bot.action(/^ADM_DONE:(.+)$/, async (ctx) => {
  const orderCode = ctx.match[1];
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Admin only");

  const order = STORE.orders[orderCode];
  if (!order) return ctx.answerCbQuery("Introuvable");

  order.status = "DONE";
  STORE.orders[orderCode] = order;
  saveStoreSafe(STORE);

  await ctx.answerCbQuery("OK");

  try {
    await bot.telegram.sendMessage(order.userId, `✅ Commande *${orderCode}* finalisée. Merci !`, {
      parse_mode: "Markdown",
    });
  } catch {}

  try {
    await ctx.editMessageText(formatOrderMdV2(order), {
      parse_mode: "MarkdownV2",
      ...adminKeyboard(orderCode),
    });
  } catch {}
});

// ========= LAUNCH =========
bot.launch();
console.log("✅ Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
