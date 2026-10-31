const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const QRIS_URL =
  process.env.QRIS_URL ||
  "https://horestorebot.vercel.app/qris.png.jpg";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Peringatan: Supabase URL atau Service Key belum lengkap.");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
);

// Discord membutuhkan raw body untuk signature verification
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function verifyDiscordSignature(rawBody, signature, timestamp) {
  if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
    return false;
  }

  try {
    const publicKeyDer = Buffer.concat([
      Buffer.from(
        "302a300506032b6570032100",
        "hex"
      ),
      Buffer.from(DISCORD_PUBLIC_KEY, "hex"),
    ]);

    const publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });

    return crypto.verify(
      null,
      Buffer.concat([
        Buffer.from(timestamp),
        rawBody,
      ]),
      publicKey,
      Buffer.from(signature, "hex")
    );
  } catch (error) {
    console.error(
      "Signature verification error:",
      error
    );

    return false;
  }
}

function rupiah(number) {
  return (
    "Rp" +
    Number(number || 0).toLocaleString("id-ID")
  );
}

function isAdministrator(interaction) {
  const permissions = BigInt(
    interaction.member?.permissions || "0"
  );

  return (permissions & 8n) === 8n;
}

// Harga:
// Setiap 1.000 Robux = Rp158.000
// Sisanya = Rp160 per Robux
function calculatePrice(robux) {
  const thousands = Math.floor(robux / 1000);
  const remainder = robux % 1000;

  return (
    thousands * 158000 +
    remainder * 160
  );
}

async function discordFetch(endpoint) {
  const response = await fetch(
    `https://discord.com/api/v10${endpoint}`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Discord API Error: ${response.status} ${errorText}`
    );
  }

  return response.json();
}

// Membaca pesan terbaru dari Ticket King
// dan mencari field "berapa robux?"
async function readTicketOrder(channelId) {
  try {
    const messages = await discordFetch(
      `/channels/${channelId}/messages?limit=100`
    );

    for (const message of messages) {
      for (const embed of message.embeds || []) {
        let robux = null;
        let username = null;

        for (const field of embed.fields || []) {
          const fieldName = String(
            field.name || ""
          )
            .toLowerCase()
            .trim();

          const fieldValue = String(
            field.value || ""
          ).trim();

          if (
            fieldName.includes("berapa robux") ||
            fieldName.includes("robux")
          ) {
            const digits = fieldValue.replace(
              /[^\d]/g,
              ""
            );

            if (digits) {
              robux = Number(digits);
            }
          }

          if (
            fieldName === "username" ||
            fieldName.includes("roblox username") ||
            fieldName.includes("username roblox")
          ) {
            username = fieldValue;
          }
        }

        if (robux && robux > 0) {
          return {
            robux,
            username,
            messageId: message.id,
          };
        }
      }
    }
  } catch (err) {
    console.error("Error reading ticket order:", err);
  }

  return null;
}

async function generateUniqueCode() {
  for (let i = 0; i < 100; i++) {
    const uniqueCode = crypto.randomInt(
      11,
      100
    );

    const { data, error } = await supabase
      .from("orders")
      .select("id")
      .eq("unique_code", uniqueCode)
      .eq("status", "PENDING")
      .limit(1);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return uniqueCode;
    }
  }

  throw new Error(
    "Kode unik sedang penuh. Coba lagi."
  );
}

function createOrderCode() {
  const time = Date.now()
    .toString()
    .slice(-8);

  const random = crypto.randomInt(
    100,
    1000
  );

  return `HOR-${time}-${random}`;
}

function responseMessage(
  content,
  ephemeral = false
) {
  return {
    type: 4,
    data: {
      content,
      flags: ephemeral ? 64 : 0,
    },
  };
}

async function handlePay(interaction) {
  if (!isAdministrator(interaction)) {
    return responseMessage(
      "❌ Command `/pay` hanya bisa digunakan oleh Administrator.",
      true
    );
  }

  if (!DISCORD_TOKEN) {
    throw new Error(
      "DISCORD_TOKEN belum diisi di Vercel."
    );
  }

  const ticket = await readTicketOrder(
    interaction.channel_id
  );

  if (!ticket) {
    return responseMessage(
      "❌ Tidak menemukan jumlah Robux dari form Ticket King di channel ini.",
      true
    );
  }

  const robux = ticket.robux;

  if (robux % 100 !== 0) {
    return responseMessage(
      `❌ Jumlah ${robux} Robux harus kelipatan 100.`,
      true
    );
  }

  const basePrice = calculatePrice(robux);
  const uniqueCode = await generateUniqueCode();
  const totalPrice = basePrice + uniqueCode;
  const orderCode = createOrderCode();

  const { error } = await supabase
    .from("orders")
    .insert({
      order_code: orderCode,
      discord_id: "TICKET_BUYER",
      discord_username: "Ticket King Buyer",
      roblox_username: ticket.username || null,
      robux: robux,
      base_price: basePrice,
      unique_code: uniqueCode,
      total_price: totalPrice,
      status: "PENDING",
      channel_id: interaction.channel_id,
    });

  if (error) {
    throw error;
  }

  return {
    type: 4,
    data: {
      embeds: [
        {
          title: "💳 PEMBAYARAN HORE STORE",
          description:
            `🧾 **Order:** \`${orderCode}\`\n\n` +
            `🎮 **Username:** \`${ticket.username || "-"}\`\n` +
            `🪙 **Robux:** **${robux.toLocaleString("id-ID")}**\n\n` +
            `💰 **Harga:** ${rupiah(basePrice)}\n` +
            `🔢 **Kode Unik:** ${uniqueCode}\n\n` +
            `💳 **TOTAL BAYAR: ${rupiah(totalPrice)}**\n\n` +
            `⚠️ Bayar tepat sesuai nominal.\n` +
            `📱 Scan QRIS di bawah.`,
          image: {
            url: QRIS_URL,
          },
          footer: {
            text: "HORE STORE • Menunggu Pembayaran",
          },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "💳 Saya Sudah Bayar",
              custom_id: `paid_${orderCode}`,
            },
            {
              type: 2,
              style: 4,
              label: "❌ Batalkan",
              custom_id: `cancel_${orderCode}`,
            },
          ],
        },
      ],
    },
  };
}

async function handlePaid(orderCode) {
  // Update status order menjadi WAITING_CONFIRMATION agar tercatat di database
  const { data, error } = await supabase
    .from("orders")
    .update({ status: "WAITING_CONFIRMATION" })
    .eq("order_code", orderCode)
    .select()
    .single();

  if (error || !data) {
    return responseMessage(
      "❌ Order tidak ditemukan atau sudah diproses.",
      true
    );
  }

  return responseMessage(
    `✅ Konfirmasi diterima untuk \`${orderCode}\`! Mohon tunggu sebentar, admin akan segera mengecek mutasi pembayaran Anda.`,
    true
  );
}

async function handleCancel(
  interaction,
  orderCode
) {
  if (!isAdministrator(interaction)) {
    return responseMessage(
      "❌ Hanya Administrator yang dapat membatalkan order.",
      true
    );
  }

  const { error } = await supabase
    .from("orders")
    .update({
      status: "CANCELLED",
    })
    .eq("order_code", orderCode)
    .eq("status", "PENDING");

  if (error) {
    throw error;
  }

  return responseMessage(
    `❌ Order \`${orderCode}\` dibatalkan.`,
    true
  );
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res
        .status(405)
        .json({
          error: "Method Not Allowed",
        });
    }

    const rawBody = await readRawBody(req);

    const signature =
      req.headers["x-signature-ed25519"];

    const timestamp =
      req.headers["x-signature-timestamp"];

    const verified =
      verifyDiscordSignature(
        rawBody,
        signature,
        timestamp
      );

    if (!verified) {
      return res
        .status(401)
        .json({
          error: "Invalid request signature",
        });
    }

    const interaction = JSON.parse(
      rawBody.toString("utf8")
    );

    // Discord PING
    if (interaction.type === 1) {
      return res
        .status(200)
        .json({
          type: 1,
        });
    }

    // Slash Command
    if (interaction.type === 2) {
      if (
        interaction.data?.name === "pay"
      ) {
        const result =
          await handlePay(interaction);

        return res
          .status(200)
          .json(result);
      }

      return res
        .status(200)
        .json(
          responseMessage(
            "❌ Command belum tersedia.",
            true
          )
        );
    }

    // Button interaction
    if (interaction.type === 3) {
      const customId =
        interaction.data?.custom_id || "";

      if (
        customId.startsWith("paid_")
      ) {
        const result =
          await handlePaid(
            customId.slice(5)
          );

        return res
          .status(200)
          .json(result);
      }

      if (
        customId.startsWith("cancel_")
      ) {
        const result =
          await handleCancel(
            interaction,
            customId.slice(7)
          );

        return res
          .status(200)
          .json(result);
      }
    }

    return res
      .status(400)
      .json({
        error: "Unknown interaction",
      });

  } catch (error) {
    console.error("API Error:", error);

    return res
      .status(500)
      .json({
        error: "Internal Server Error",
        message: error.message,
      });
  }
};
      return res
          .status(200)
          .json(result);
      }
    }

    return res
      .status(400)
      .json({
        error:
          "Unknown interaction",
      });

  } catch (error) {
    console.error(error);

    return res
      .status(500)
      .json({
        error:
          "Internal Server Error",

        message:
          error.message,
      });
  }
};
