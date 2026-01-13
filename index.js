const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0); // ex: 123456789
const BTC_ADDRESS = process.env.BTC_ADDRESS || ""; // votre adresse BTC
const TRANSCASH_TEXT =
  process.env.TRANSCASH_TEXT ||
  "Envoyez votre code Transcash + montant exact ici dans le chat.";

const bot = new Telegraf(BOT_TOKEN);

// --- mini "DB" mémoire (simple)
const orders = new Map(); // orderCode -> order
const lastOrderByChat = new Map(); // chatId -> orderCode

function makeCode() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const r = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `UF-${y}${m}${da}-${r}`;
}

function fmtOrder(order) {
  const lines = [];
  lines.push(`🧾 **Commande ${order.code}**`);
  lines.push(`Total: **${Number(order.totalEur || 0).toFixed(2)} €**`);
  lines.push(`Articles: ${order.items?.length || 0}`);
  lines.push("");
  lines.push("Choisissez un moyen de paiement :");
  return lines.join("\n");
}

function payKeyboard(code) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("₿ Bitcoin", `pay_btc:${code}`),
      Markup.button.callback("💳 Transcash", `pay_tc:${code}`),
    ],
  ]);
}

function adminKeyboard(code) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Paiement OK", `admin_paid:${code}`),
      Markup.button.callback("❌ Annuler", `admin_cancel:${code}`),
    ],
    [Markup.button.callback("📄 Étiquette reçue", `admin_label:${code}`)],
  ]);
}

// --- commandes utiles
bot.start(async (ctx) => {
  await ctx.reply(
    "🍄 UrbanFungi\n\nOuvrez la boutique via le bouton WebApp, faites votre panier, puis cliquez sur ✅ Commander.\n\nSi besoin: /id",
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`chat_id = ${ctx.chat.id}`);
});

// --- réception commande depuis MiniApp (web_app_data)
bot.on("message", async (ctx, next) => {
  const wad = ctx.message?.web_app_data;
  if (!wad?.data) return next();

  let payload = null;
  try {
    payload = JSON.parse(wad.data);
  } catch {
    await ctx.reply("❌ Données commande illisibles.");
    return;
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const totalEur = Number(payload?.totalEur || 0);

  if (!items.length || !Number.isFinite(totalEur)) {
    await ctx.reply("❌ Commande invalide (items/total).");
    return;
  }

  const code = makeCode();
  const order = {
    code,
    chatId: ctx.chat.id,
    userId: ctx.from?.id || null,
    username: ctx.from?.username || "",
    items,
    totalEur,
    status: "awaiting_payment",
    createdAt: new Date().toISOString(),
  };

  orders.set(code, order);
  lastOrderByChat.set(ctx.chat.id, code);

  // Message client
  await ctx.replyWithMarkdown(fmtOrder(order), payKeyboard(code));

  // Message admin
  if (ADMIN_CHAT_ID) {
    const adminText =
      `🔔 **Nouvelle commande ${code}**\n` +
      `Client: ${order.username ? "@" + order.username : order.userId}\n` +
      `Total: **${totalEur.toFixed(2)} €**\n` +
      `Articles: ${items.length}\n\n` +
      `👉 Validez le paiement puis demandez l'étiquette PDF.`;

    await bot.telegram.sendMessage(ADMIN_CHAT_ID, adminText, {
      parse_mode: "Markdown",
      ...adminKeyboard(code),
    });
  }
});

// --- boutons paiement client
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  const [action, code] = data.split(":");

  if (!code) {
    await ctx.answerCbQuery("OK");
    return;
  }

  const order = orders.get(code);
  if (!order) {
    await ctx.answerCbQuery("Commande introuvable");
    return;
  }

  // Paiement Bitcoin
  if (action === "pay_btc") {
    order.status = "awaiting_payment";
    orders.set(code, order);

    const txt =
      `₿ **Paiement Bitcoin — ${code}**\n\n` +
      (BTC_ADDRESS
        ? `Adresse BTC:\n\`${BTC_ADDRESS}\`\n\n`
        : "⚠️ Adresse BTC non configurée (BTC_ADDRESS).\n\n") +
      `Montant: **${Number(order.totalEur).toFixed(2)} €**\n\n` +
      `✅ Après paiement, envoyez la preuve ici.\n` +
      `⏳ Une fois validé, vous pourrez envoyer votre **étiquette PDF**.`;

    await ctx.editMessageText(txt, { parse_mode: "Markdown" }).catch(() => {});
    await ctx.answerCbQuery("Bitcoin");
    return;
  }

  // Paiement Transcash
  if (action === "pay_tc") {
    order.status = "awaiting_payment";
    orders.set(code, order);

    const txt =
      `💳 **Paiement Transcash — ${code}**\n\n` +
      `${TRANSCASH_TEXT}\n\n` +
      `Montant: **${Number(order.totalEur).toFixed(2)} €**\n\n` +
      `✅ Envoyez le code Transcash ici.\n` +
      `⏳ Une fois validé, vous pourrez envoyer votre **étiquette PDF**.`;

    await ctx.editMessageText(txt, { parse_mode: "Markdown" }).catch(() => {});
    await ctx.answerCbQuery("Transcash");
    return;
  }

  // Admin: paiement OK
  if (action === "admin_paid") {
    if (ADMIN_CHAT_ID && ctx.chat.id !== ADMIN_CHAT_ID) {
      await ctx.answerCbQuery("Admin uniquement");
      return;
    }

    order.status = "awaiting_label";
    orders.set(code, order);

    await ctx.answerCbQuery("Paiement validé ✅");

    // Notifie client
    await bot.telegram.sendMessage(
      order.chatId,
      `✅ Paiement validé pour **${code}**.\n\n📄 Envoyez maintenant votre **étiquette PDF** ici (en document).`,
      { parse_mode: "Markdown" }
    );

    // Update message admin
    await ctx.editMessageText(
      `✅ Paiement validé — ${code}\nEn attente de l'étiquette PDF.`,
      { ...adminKeyboard(code) }
    ).catch(() => {});
    return;
  }

  // Admin: annuler
  if (action === "admin_cancel") {
    if (ADMIN_CHAT_ID && ctx.chat.id !== ADMIN_CHAT_ID) {
      await ctx.answerCbQuery("Admin uniquement");
      return;
    }

    order.status = "cancelled";
    orders.set(code, order);

    await ctx.answerCbQuery("Annulé");

    await bot.telegram.sendMessage(
      order.chatId,
      `❌ Commande **${code}** annulée.\nSi besoin, refaites une commande.`,
      { parse_mode: "Markdown" }
    );

    await ctx.editMessageText(`❌ Annulée — ${code}`).catch(() => {});
    return;
  }

  // Admin: étiquette reçue
  if (action === "admin_label") {
    if (ADMIN_CHAT_ID && ctx.chat.id !== ADMIN_CHAT_ID) {
      await ctx.answerCbQuery("Admin uniquement");
      return;
    }

    order.status = "done";
    orders.set(code, order);

    await ctx.answerCbQuery("OK");

    await bot.telegram.sendMessage(
      order.chatId,
      `✅ Étiquette reçue pour **${code}**.\nMerci !`,
      { parse_mode: "Markdown" }
    );

    await ctx.editMessageText(`✅ Terminé — ${code}`).catch(() => {});
    return;
  }

  await ctx.answerCbQuery("OK");
});

// --- réception PDF (document) : on l'envoie à l'admin
bot.on("document", async (ctx) => {
  const chatId = ctx.chat.id;
  const last = lastOrderByChat.get(chatId);
  const order = last ? orders.get(last) : null;

  // si aucune commande trouvée
  if (!order) return;

  if (order.status !== "awaiting_label") {
    // on laisse passer (peut-être proof de paiement)
    return;
  }

  if (ADMIN_CHAT_ID) {
    const caption =
      `📄 **Étiquette PDF reçue**\nCommande: **${order.code}**\nClient: ${
        order.username ? "@" + order.username : order.userId
      }\n`;

    await ctx.forwardMessage(ADMIN_CHAT_ID).catch(() => {});
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, caption, {
      parse_mode: "Markdown",
      ...adminKeyboard(order.code),
    });
  }

  await ctx.reply(
    `✅ PDF reçu. Attendez la confirmation.`,
  );
});

bot.launch();
console.log("Bot started");
