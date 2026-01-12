const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);

const MINIAPP_URL = process.env.MINIAPP_URL || "https://urbanfungi-miniapp.onrender.com";

// URL de ton API Render
const API_BASE = (process.env.API_BASE || "").replace(/\/+$/, "");
// le même secret que dans urbanfungi-api
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ BOT_TOKEN ou ADMIN_CHAT_ID manquant");
  process.exit(1);
}
if (!API_BASE || !ADMIN_SECRET) {
  console.error("❌ API_BASE ou ADMIN_SECRET manquant (Render > Environment du BOT)");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// 🔒 Map: userId -> orderCode (verrou PDF)
const awaitingLabel = new Map();

// ---------- Helpers
async function apiAdminSetStatus(orderCode, status) {
  const res = await fetch(`${API_BASE}/api/admin/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: ADMIN_SECRET, orderCode, status }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `API status error ${res.status}`);
  return data.order;
}

async function apiAdminGetOrders(limit = 10) {
  const res = await fetch(`${API_BASE}/api/admin/orders?secret=${encodeURIComponent(ADMIN_SECRET)}&limit=${limit}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `API orders error ${res.status}`);
  return data.orders || [];
}

function onlyAdmin(ctx) {
  return ctx.chat?.id === ADMIN_CHAT_ID;
}

// ---------- Commands user
bot.command("shop", async (ctx) => {
  await ctx.reply(
    "🛒 Ouvrir la boutique (mode Mini App) :",
    Markup.inlineKeyboard([Markup.button.webApp("✅ Ouvrir la boutique", MINIAPP_URL)])
  );
});

bot.command("ping", async (ctx) => {
  await ctx.reply("✅ Bot UrbanFungi opérationnel");
});

// ---------- Command admin: historique simple
bot.command("orders", async (ctx) => {
  if (!onlyAdmin(ctx)) return ctx.reply("⛔ Accès admin uniquement.");

  try {
    const list = await apiAdminGetOrders(10);
    if (!list.length) return ctx.reply("Aucune commande en mémoire (ou restart Render).");

    const lines = list.map((o) => {
      const u = o.user?.username ? `@${o.user.username}` : `id ${o.user?.id}`;
      const total = Number(o.totalEur || 0).toFixed(2);
      return `• <b>${o.orderCode}</b> — ${total}€ — <b>${o.status}</b> — ${u}`;
    });

    await ctx.reply(`📦 <b>Dernières commandes</b>\n\n${lines.join("\n")}`, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Erreur /orders: ${String(e.message || e)}`);
  }
});

// ---------- ADMIN buttons (callback_data ok:CMD-1234 / cancel: / ship:)
bot.on("callback_query", async (ctx) => {
  try {
    if (!onlyAdmin(ctx)) return ctx.answerCbQuery("Admin uniquement.");

    const data = ctx.callbackQuery?.data || "";
    const [action, orderCode] = data.split(":");
    if (!action || !orderCode) return ctx.answerCbQuery("Bouton invalide.");

    // ✅ Confirmer payé
    if (action === "ok") {
      // Status -> AWAITING_LABEL
      const order = await apiAdminSetStatus(orderCode, "AWAITING_LABEL");

      // Verrou PDF: le prochain PDF du client sera attaché à cette commande
      if (order?.user?.id) awaitingLabel.set(Number(order.user.id), orderCode);

      // notifier client
      if (order?.user?.id) {
        await ctx.telegram.sendMessage(
          order.user.id,
          `✅ Paiement confirmé pour <b>${orderCode}</b>.\n\n` +
            `📦 Merci d'envoyer votre <b>étiquette d'envoi (PDF)</b> ici.\n` +
            `➡️ Envoyez le PDF en pièce jointe.`,
          { parse_mode: "HTML" }
        );
      }

      await ctx.answerCbQuery("Paiement confirmé ✅");
      return ctx.reply(
        `✅ Paiement confirmé pour <b>${orderCode}</b> — client notifié — en attente du PDF.`,
        { parse_mode: "HTML" }
      );
    }

    // ❌ Annuler
    if (action === "cancel") {
      const order = await apiAdminSetStatus(orderCode, "ANNULE");
      // enlever verrou si jamais
      if (order?.user?.id && awaitingLabel.get(Number(order.user.id)) === orderCode) {
        awaitingLabel.delete(Number(order.user.id));
      }

      if (order?.user?.id) {
        await ctx.telegram.sendMessage(order.user.id, `❌ Votre commande <b>${orderCode}</b> a été annulée.`, {
          parse_mode: "HTML",
        });
      }

      await ctx.answerCbQuery("Annulé ❌");
      return ctx.reply(`❌ Commande <b>${orderCode}</b> annulée.`, { parse_mode: "HTML" });
    }

    // 📦 Expédié
    if (action === "ship") {
      const order = await apiAdminSetStatus(orderCode, "EXPEDIE");
      if (order?.user?.id) {
        await ctx.telegram.sendMessage(order.user.id, `📦 Votre commande <b>${orderCode}</b> a été expédiée.`, {
          parse_mode: "HTML",
        });
      }
      await ctx.answerCbQuery("Expédié 📦");
      return ctx.reply(`📦 Commande <b>${orderCode}</b> marquée expédiée.`, { parse_mode: "HTML" });
    }

    await ctx.answerCbQuery("Action inconnue.");
  } catch (e) {
    console.error(e);
    try {
      await ctx.answerCbQuery("Erreur ❌");
    } catch {}
    await ctx.reply(`❌ Erreur bouton: ${String(e.message || e)}`);
  }
});

// ---------- Réception PDF client
bot.on("document", async (ctx) => {
  try {
    const fromId = Number(ctx.message?.from?.id || 0);
    if (!fromId) return;

    const doc = ctx.message.document;
    const isPdf =
      doc?.mime_type === "application/pdf" ||
      (doc?.file_name || "").toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      // On ne bloque pas tout, mais on guide
      return ctx.reply("⚠️ Merci d'envoyer un fichier PDF (étiquette d'envoi).");
    }

    const orderCode = awaitingLabel.get(fromId);
    if (!orderCode) {
      return ctx.reply(
        "⚠️ Je n'ai pas de commande en attente d'étiquette pour vous.\n" +
          "Si vous venez de payer, attendez la confirmation puis envoyez le PDF."
      );
    }

    // Forward au chat admin (avec contexte)
    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `📄 <b>ÉTIQUETTE REÇUE</b>\nCommande: <b>${orderCode}</b>\nClient id: <code>${fromId}</code>`,
      { parse_mode: "HTML" }
    );

    // forward du document (ou copyMessage)
    await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id);

    // status -> LABEL_RECEIVED
    await apiAdminSetStatus(orderCode, "LABEL_RECEIVED");

    // déverrouille
    awaitingLabel.delete(fromId);

    // confirmer au client
    await ctx.reply(`✅ PDF reçu pour <b>${orderCode}</b>. Merci !`, { parse_mode: "HTML" });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Erreur lors de la réception du PDF. Réessayez.");
  }
});

// ---------- Lancement
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("✅ UrbanFungi bot lancé");
  } catch (err) {
    console.error("❌ Erreur au lancement :", err);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
