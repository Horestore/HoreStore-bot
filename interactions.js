const nacl = require('tweetnacl');
const { createClient } = require('@supabase/supabase-js');

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const QRIS_URL =
  process.env.QRIS_URL ||
  'https://horestorebot.vercel.app/qris.png.jpg';

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
);

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

function verifyDiscordRequest(
  rawBody,
  signature,
  timestamp
) {
  try {
    if (
      !signature ||
      !timestamp ||
      !DISCORD_PUBLIC_KEY
    ) {
      return false;
    }

    const message = Buffer.concat([
      Buffer.from(String(timestamp)),
      rawBody,
    ]);

    return nacl.sign.detached.verify(
      new Uint8Array(message),
      new Uint8Array(
        Buffer.from(signature, 'hex')
      ),
      new Uint8Array(
        Buffer.from(
          DISCORD_PUBLIC_KEY,
          'hex'
        )
      )
    );
  } catch (error) {
    console.error(
      'Signature verification failed:',
      error
    );

    return false;
  }
}

function formatRupiah(value) {
  return (
    'Rp' +
    Number(value || 0).toLocaleString(
      'id-ID'
    )
  );
}

function calculatePrice(robux) {
  const thousands = Math.floor(
    robux / 1000
  );

  const remainder = robux % 1000;

  return (
    thousands * 158000 +
    remainder * 160
  );
}

function isAdministrator(interaction) {
  const permissions = BigInt(
    interaction.member?.permissions || '0'
  );

  return (permissions & 8n) === 8n;
}

function interactionResponse(
  content,
  ephemeral
) {
  return {
    type: 4,
    data: {
      content,
      flags: ephemeral ? 64 : 0,
    },
  };
}

async function discordApi(path) {
  const response = await fetch(
    `https://discord.com/api/v10${path}`,
    {
      headers: {
        Authorization:
          `Bot ${DISCORD_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Discord API ${response.status}: ` +
      `${await response.text()}`
    );
  }

  return response.json();
}

function extractRobuxFromText(value) {
  const normalized = String(value || '')
    .replace(/\./g, '')
    .replace(/,/g, '');

  const match = normalized.match(/\d+/);

  return match ? Number(match[0]) : null;
}

async function readTicketKingOrder(
  channelId
) {
  const messages = await discordApi(
    `/channels/${channelId}/messages?limit=100`
  );

  for (const message of messages) {
    for (const embed of message.embeds || []) {
      let robux = null;
      let username = null;

      for (const field of embed.fields || []) {
        const name = String(
          field.name || ''
        )
          .toLowerCase()
          .trim();

        const value = String(
          field.value || ''
        ).trim();

        if (
          name.includes('berapa robux') ||
          name.includes('jumlah robux')
        ) {
          robux =
            extractRobuxFromText(value);
        }

        if (
          name === 'username' ||
          name.includes('roblox username') ||
          name.includes('username roblox')
        ) {
          username = value;
        }
      }

      if (
        Number.isFinite(robux) &&
        robux > 0
      ) {
        return {
          robux,
          username,
          messageId: message.id,
        };
      }
    }
  }

  return null;
}

async function generateUniqueCode() {
  for (
    let attempt = 0;
    attempt < 100;
    attempt += 1
  ) {
    const uniqueCode =
      Math.floor(Math.random() * 89) + 11;

    const { data, error } =
      await supabase
        .from('orders')
        .select('id')
        .eq('unique_code', uniqueCode)
        .eq('status', 'PENDING')
        .limit(1);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return uniqueCode;
    }
  }

  throw new Error(
    'Kode unik sedang penuh. Coba lagi.'
  );
}

function makeOrderCode() {
  return (
    `HOR-${Date.now()}-` +
    `${Math.floor(Math.random() * 900 + 100)}`
  );
}

async function createPayment(interaction) {
  if (!isAdministrator(interaction)) {
    return interactionResponse(
      '❌ Command `/pay` hanya bisa digunakan oleh Administrator.',
      true
    );
  }

  const ticket =
    await readTicketKingOrder(
      interaction.channel_id
    );

  if (!ticket) {
    return interactionResponse(
      '❌ Tidak menemukan jumlah Robux dari form Ticket King di channel ini.',
      true
    );
  }

  const robux = ticket.robux;

  if (robux % 100 !== 0) {
    return interactionResponse(
      `❌ Jumlah ${robux} Robux harus kelipatan 100.`,
      true
    );
  }

  const basePrice =
    calculatePrice(robux);

  const uniqueCode =
    await generateUniqueCode();

  const totalPrice =
    basePrice + uniqueCode;

  const orderCode =
    makeOrderCode();

  const { error } =
    await supabase
      .from('orders')
      .insert({
        order_code: orderCode,
        discord_id:
          interaction.member?.user?.id ||
          null,
        discord_username:
          interaction.member?.user?.username ||
          null,
        roblox_username:
          ticket.username || null,
        robux,
        base_price: basePrice,
        unique_code: uniqueCode,
        total_price: totalPrice,
        status: 'PENDING',
        channel_id:
          interaction.channel_id,
      });

  if (error) {
    throw error;
  }

  return {
    type: 4,

    data: {
      embeds: [
        {
          title:
            '💳 PEMBAYARAN HORE STORE',

          description:
            `🧾 **Order:** \`${orderCode}\`\n\n` +
            `🎮 **Username:** \`${ticket.username || '-'}\`\n` +
            `🪙 **Robux:** **${robux.toLocaleString('id-ID')}**\n\n` +
            `💰 **Harga:** ${formatRupiah(basePrice)}\n` +
            `🔢 **Kode Unik:** ${uniqueCode}\n\n` +
            `💳 **TOTAL BAYAR: ${formatRupiah(totalPrice)}**\n\n` +
            '⚠️ Bayar tepat sesuai nominal.\n' +
            '📱 Scan QRIS di bawah.',

          image: {
            url: QRIS_URL,
          },

          footer: {
            text:
              'HORE STORE • Menunggu Pembayaran',
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
              label:
                '💳 Saya Sudah Bayar',

              custom_id:
                `paid_${orderCode}`,
            },

            {
              type: 2,
              style: 4,
              label:
                '❌ Batalkan',

              custom_id:
                `cancel_${orderCode}`,
            },
          ],
        },
      ],
    },
  };
}

async function handleButton(interaction) {
  const customId = String(
    interaction.data?.custom_id || ''
  );

  if (customId.startsWith('paid_')) {
    const orderCode =
      customId.slice(5);

    const { error } =
      await supabase
        .from('orders')
        .update({
          status: 'PAYMENT_CLAIMED',
        })
        .eq(
          'order_code',
          orderCode
        )
        .eq(
          'status',
          'PENDING'
        );

    if (error) {
      throw error;
    }

    return interactionResponse(
      `⏳ Order \`${orderCode}\` ditandai sudah dibayar. Menunggu pengecekan admin.`,
      true
    );
  }

  if (
    customId.startsWith('cancel_')
  ) {
    if (!isAdministrator(interaction)) {
      return interactionResponse(
        '❌ Hanya Administrator yang dapat membatalkan order.',
        true
      );
    }

    const orderCode =
      customId.slice(7);

    const { error } =
      await supabase
        .from('orders')
        .update({
          status: 'CANCELLED',
        })
        .eq(
          'order_code',
          orderCode
        );

    if (error) {
      throw error;
    }

    return interactionResponse(
      `❌ Order \`${orderCode}\` dibatalkan.`,
      true
    );
  }

  return interactionResponse(
    '❌ Tombol tidak dikenal.',
    true
  );
}

module.exports =
  async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        return res
          .status(405)
          .json({
            error:
              'Method Not Allowed',
          });
      }

      const rawBody =
        await readRawBody(req);

      const signature =
        req.headers[
          'x-signature-ed25519'
        ];

      const timestamp =
        req.headers[
          'x-signature-timestamp'
        ];

      if (
        !verifyDiscordRequest(
          rawBody,
          signature,
          timestamp
        )
      ) {
        return res
          .status(401)
          .json({
            error:
              'Invalid request signature',
          });
      }

      const interaction =
        JSON.parse(
          rawBody.toString('utf8')
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
          interaction.data?.name === 'pay'
        ) {
          return res
            .status(200)
            .json(
              await createPayment(
                interaction
              )
            );
        }

        return res
          .status(200)
          .json(
            interactionResponse(
              '❌ Command belum tersedia.',
              true
            )
          );
      }

      // Button
      if (interaction.type === 3) {
        return res
          .status(200)
          .json(
            await handleButton(
              interaction
            )
          );
      }

      return res
        .status(400)
        .json({
          error:
            'Unknown interaction',
        });

    } catch (error) {
      console.error(error);

      return res
        .status(500)
        .json({
          error:
            'Internal Server Error',
          message:
            error.message,
        });
    }
  };   const result =
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
