const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const nacl = require("tweetnacl");

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// URL QRIS setelah deploy.
// Contoh: https://horestore-bot.vercel.app/qris.png.jpg
const QRIS_URL = process.env.QRIS_URL || "";

if (!DISCORD_PUBLIC_KEY) throw new Error("DISCORD_PUBLIC_KEY belum diisi");
if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN belum diisi");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL belum diisi");
if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY belum diisi");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// =====================================================
// HELPER
// =====================================================

function rupiah(n) {
return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function getUserId(interaction) {
return interaction.member?.user?.id || interaction.user?.id;
}

function isAdmin(interaction) {
if (!interaction.member) return false;

// Administrator permission
const permissions = BigInt(interaction.member.permissions || "0");

if ((permissions & 8n) === 8n) return true;

if (!ADMIN_ROLE_ID) return false;

return interaction.member.roles?.includes(ADMIN_ROLE_ID);
}

// =====================================================
// HITUNG HARGA
//
// 1.000 Robux = Rp158.000
// Sisa = Rp160 / Robux
// =====================================================

function calculatePrice(robux) {
const thousands = Math.floor(robux / 1000);
const remainder = robux % 1000;

return thousands * 158000 + remainder * 160;
}

// =====================================================
// DISCORD API
// =====================================================

async function discordFetch(endpoint, options = {}) {
const response = await fetch(
"https://discord.com/api/v10${endpoint}",
{
...options,
headers: {
Authorization: "Bot ${DISCORD_TOKEN}",
"Content-Type": "application/json",
...(options.headers || {}),
},
}
);

if (!response.ok) {
const text = await response.text();
throw new Error("Discord API error: ${response.status} ${text}");
}

return response.json();
}

// =====================================================
// AMBIL DATA TICKET KING
// =====================================================

async function readTicketKingOrder(channelId) {
// Ambil 50 pesan terbaru dalam ticket
const messages = await discordFetch(
"/channels/${channelId}/messages?limit=50"
);

// Cari pesan terbaru yang memiliki embed
for (const message of messages) {
if (!message.embeds || !message.embeds.length) continue;

for (const embed of message.embeds) {
  if (!embed.fields || !embed.fields.length) continue;

  let robux = null;
  let robloxUsername = null;

  for (const field of embed.fields) {
    const fieldName = String(field.name || "")
      .toLowerCase()
      .trim();

    const fieldValue = String(field.value || "").trim();

    // Cari field "berapa robux?"
    if (
      fieldName.includes("berapa robux") ||
      fieldName.includes("robux")
    ) {
      // Ambil angka dari isi field.
      // Contoh: "200" → 200
      const match = fieldValue.replace(/\./g, "").match(/\d+/);

      if (match) {
        robux = Number(match[0]);
      }
    }

    // Cari username Roblox
    if (
      fieldName === "username" ||
      fieldName.includes("roblox username")
    ) {
      robloxUsername = fieldValue;
    }
  }

  // Kalau jumlah Robux ditemukan, gunakan order ini
  if (robux && robux > 0) {
    return {
      robux,
      robloxUsername,
      messageId: message.id,
    };
  }
}

}

return null;
}

// =====================================================
// KODE UNIK
// =====================================================

async function generateUniqueCode() {
for (let i = 0; i < 200; i++) {
const code = crypto.randomInt(11, 100);

const { data, error } = await supabase
  .from("orders")
  .select("id")
  .eq("unique_code", code)
  .eq("status", "PENDING")
  .limit(1);

if (error) throw error;

if (!data || data.length === 0) {
  return code;
}

}

throw new Error("Kode unik sedang penuh. Coba lagi.");
}

function makeOrderCode() {
return (
"HOR-" +
Date.now().toString().slice(-7) +
"-" +
crypto.randomInt(100, 999)
);
}

// =====================================================
// VERIFIKASI REQUEST DISCORD
// =====================================================

function verifyDiscordRequest(req) {
const signature = req.headers["x-signature-ed25519"];
const timestamp = req.headers["x-signature-timestamp"];

if (!signature || !timestamp) return false;

const rawBody =
typeof req.body === "string"
? req.body
: JSON.stringify(req.body);

return nacl.sign.detached.verify(
Buffer.from(timestamp + rawBody),
Buffer.from(signature, "hex"),
Buffer.from(DISCORD_PUBLIC_KEY, "hex")
);
}

// =====================================================
// RESPONSE HELPER
// =====================================================

function responseMessage(content, ephemeral = false) {
return {
type: 4,
data: {
content,
flags: ephemeral ? 64 : 0,
},
};
}

// =====================================================
// /PAY
// =====================================================

async function handlePay(interaction) {
if (!isAdmin(interaction)) {
return responseMessage(
"❌ Command "/pay" hanya bisa digunakan admin.",
true
);
}

const channelId = interaction.channel_id;

// Cari data dari Ticket King
const ticketData = await readTicketKingOrder(channelId);

if (!ticketData) {
return responseMessage(
"❌ Data order Ticket King tidak ditemukan.\nPastikan form order sudah dikirim terlebih dahulu.",
true
);
}

const robux = ticketData.robux;

// Pastikan kelipatan 100
if (robux % 100 !== 0) {
return responseMessage(
"❌ Jumlah yang terbaca (${robux} Robux) bukan kelipatan 100.",
true
);
}

const basePrice = calculatePrice(robux);
const uniqueCode = await generateUniqueCode();
const totalPrice = basePrice + uniqueCode;

const orderCode = makeOrderCode();

// Cari buyer dari owner ticket.
// Sementara menggunakan user yang menjalankan /pay jika
// owner ticket belum bisa dideteksi dari Ticket King.
const discordId = getUserId(interaction);

// Simpan order
const { error } = await supabase
.from("orders")
.insert({
order_code: orderCode,
discord_id: discordId,
discord_username:
interaction.member?.user?.username || "Unknown",
roblox_username: ticketData.robloxUsername,
robux,
base_price: basePrice,
unique_code: uniqueCode,
total_price: totalPrice,
status: "PENDING",
channel_id: channelId,
});

if (error) {
throw error;
}

const qrisImageUrl = QRIS_URL;

return {
type: 4,
data: {
embeds: [
{
title: "💳 PEMBAYARAN HORE STORE",
description:
"🧾 **Order:** \"${orderCode}`\n\n"+"🎮 Username: `${ticketData.robloxUsername || "-"}`\n"+"🪙 Robux: ${robux.toLocaleString("id-ID")}\n\n"+"💰 Harga: ${rupiah(basePrice)}\n"+"🔢 Kode Unik: ${uniqueCode}\n\n"+"💳 TOTAL BAYAR: ${rupiah(totalPrice)}\n\n"+"⚠️ Bayar TEPAT sesuai nominal yang tertera.\n"+"📱 Scan QRIS di bawah.", image: qrisImageUrl ? { url: qrisImageUrl } : undefined, footer: { text: "HORE STORE • Menunggu Pembayaran", }, }, ], components: [ { type: 1, components: [ { type: 2, style: 3, label: "💳 Saya Sudah Bayar", custom_id: "paid_${orderCode}", }, { type: 2, style: 4, label: "❌ Batalkan", custom_id: "cancel_${orderCode}`,
},
],
},
],
},
};
}

// =====================================================
// TOMBOL SUDAH BAYAR
// =====================================================

async function handlePaid(interaction, orderCode) {
const { data: order } = await supabase
.from("orders")
.select("*")
.eq("order_code", orderCode)
.single();

if (!order) {
return responseMessage("❌ Order tidak ditemukan.", true);
}

return responseMessage(
"⏳ **Pembayaran sedang menunggu pengecekan admin.**\n\n" +
"🧾 Order: \"${order.order_code}`\n"+"💳 Total: ${rupiah(order.total_price)}`,
true
);
}

// =====================================================
// BATALKAN ORDER
// =====================================================

async function handleCancel(interaction, orderCode) {
const { error } = await supabase
.from("orders")
.update({ status: "CANCELLED" })
.eq("order_code", orderCode)
.eq("status", "PENDING");

if (error) throw error;

return responseMessage(
"❌ Order \"${orderCode}` berhasil dibatalkan.`,
true
);
}

// =====================================================
// VERCEL HANDLER
// =====================================================

module.exports = async (req, res) => {
try {
if (req.method !== "POST") {
return res.status(405).json({
error: "Method Not Allowed",
});
}

if (!verifyDiscordRequest(req)) {
  return res.status(401).json({
    error: "Invalid request signature",
  });
}

const interaction =
  typeof req.body === "string"
    ? JSON.parse(req.body)
    : req.body;

// Discord PING
if (interaction.type === 1) {
  return res.status(200).json({
    type: 1,
  });
}

let response;

// BUTTON
if (interaction.type === 3) {
  const customId = interaction.data.custom_id;

  if (customId.startsWith("paid_")) {
    response = await handlePaid(
      interaction,
      customId.replace("paid_", "")
    );
  } else if (customId.startsWith("cancel_")) {
    response = await handleCancel(
      interaction,
      customId.replace("cancel_", "")
    );
  } else {
    response = responseMessage("❌ Tombol tidak dikenal.", true);
  }

  return res.status(200).json(response);
}

// SLASH COMMAND
if (interaction.type === 2) {
  const command = interaction.data.name;

  if (command === "pay") {
    response = await handlePay(interaction);
  } else {
    response = responseMessage(
      "❌ Command belum tersedia.",
      true
    );
  }

  return res.status(200).json(response);
}

return res.status(400).json({
  error: "Unknown interaction",
});

} catch (error) {
console.error("ERROR:", error);

return res.status(500).json({
  error: "Internal Server Error",
});

}
};
