/**
 * Discord Bot — Yellow Box Markets
 */
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

function setupDiscord(aiEngine, commandRouter, authService) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  if (!token) {
    console.log("⏭️  Discord: No token, skipping");
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName("price")
      .setDescription("ดูราคาสดจาก YBX")
      .addStringOption((opt) =>
        opt.setName("symbol").setDescription("สินทรัพย์ เช่น XAUUSD, EURUSD").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("analyze")
      .setDescription("วิเคราะห์ตลาด (TA, FA, Sentiment)")
      .addStringOption((opt) =>
        opt.setName("symbol").setDescription("สินทรัพย์ เช่น XAUUSD, EURUSD, BTC").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("news")
      .setDescription("ข่าวเศรษฐกิจวันนี้"),
    new SlashCommandBuilder()
      .setName("levels")
      .setDescription("แนวรับแนวต้าน")
      .addStringOption((opt) =>
        opt.setName("symbol").setDescription("สินทรัพย์ เช่น XAUUSD").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("rate")
      .setDescription("อัตราแลกเปลี่ยน THB/USD"),
    new SlashCommandBuilder()
      .setName("checklist")
      .setDescription("แสดง Pre-trade Checklist 5 ขั้นตอน"),
    new SlashCommandBuilder()
      .setName("zones")
      .setDescription("แสดง Trade Setup Grading"),
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("เริ่มบทสนทนาใหม่"),
  ];

  client.once("ready", async () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}`);

    // Register slash commands
    if (appId) {
      try {
        const rest = new REST({ version: "10" }).setToken(token);
        await rest.put(Routes.applicationCommands(appId), {
          body: commands.map((c) => c.toJSON()),
        });
        console.log("   Discord slash commands registered");
      } catch (err) {
        console.error("   Failed to register slash commands:", err.message);
      }
    }
  });

  // Handle slash commands
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const cmdName = interaction.commandName;

    // Build command text for the router
    const symbolOpt = interaction.options?.getString("symbol") || "";
    const cmdText = symbolOpt ? `/${cmdName} ${symbolOpt}` : `/${cmdName}`;

    // Route through command router
    if (commandRouter) {
      // Defer for commands that may take time
      if (["analyze", "price", "news", "levels", "rate"].includes(cmdName)) {
        await interaction.deferReply();
      }

      const result = await commandRouter.execute(cmdText, "discord", userId, userName);
      if (result) {
        return sendDiscordReply(interaction, result.text);
      }
    }

    // Fallback: embed-based responses for checklist/zones/reset
    if (cmdName === "checklist") {
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("📋 Pre-trade Checklist 5 ขั้นตอน")
        .addFields(
          { name: "1️⃣ TREND", value: "HTF ทิศทางหลัก (Bullish/Bearish/Range?)", inline: true },
          { name: "2️⃣ LEVELS", value: "แนวรับ/แนวต้านสำคัญ + Fibonacci", inline: true },
          { name: "3️⃣ CONFIRM", value: "รอ confirmation (Candle, Indicator)", inline: true },
          { name: "4️⃣ ENTRY", value: "Entry, SL, TP + คำนวณ R:R", inline: true },
          { name: "5️⃣ SIZE", value: "คำนวณ Lot Size ตาม risk 1-2%", inline: true }
        )
        .setFooter({ text: "ตรวจครบ 5 ข้อก่อนเข้าเทรดทุกครั้ง!" });
      return interaction.reply({ embeds: [embed] });
    }

    if (cmdName === "zones") {
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("📊 Trade Setup Grading")
        .setDescription(
          "```\n" +
            "Grade | Stars | Confluence    | Size | Min R:R\n" +
            "------|-------|---------------|------|--------\n" +
            "A+    | ★★★★★ | Multi-TF      | 100% | 1:3\n" +
            "A     | ★★★★☆ | Strong        | 100% | 1:2\n" +
            "B     | ★★★☆☆ | Moderate      | 75%  | 1:2\n" +
            "C     | ★★☆☆☆ | Weak          | 50%  | 1:3\n" +
            "D     | ★☆☆☆☆ | No confluence | SKIP | -\n" +
            "```"
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (cmdName === "reset") {
      aiEngine.resetConversation("discord", userId);
      return interaction.reply("🔄 เริ่มบทสนทนาใหม่แล้วครับ");
    }

    // analyze fallback (no command router)
    if (cmdName === "analyze") {
      if (!interaction.deferred) await interaction.deferReply();
      try {
        const reply = await aiEngine.chat(
          "discord", userId,
          `วิเคราะห์ ${symbolOpt} ให้หน่อย`,
          userName
        );
        return sendDiscordReply(interaction, reply);
      } catch (err) {
        return sendDiscordReply(interaction, "❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
      }
    }
  });

  // Handle regular messages (when bot is mentioned or in DM)
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Respond to DMs or when mentioned
    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user);
    if (!isDM && !isMentioned) return;

    const userId = message.author.id;
    const userName = message.author.username;
    let text = message.content;

    // Remove mention from text
    if (isMentioned) {
      text = text.replace(/<@!?\d+>/g, "").trim();
    }
    if (!text) return;

    // Try command router for slash-like commands in DMs
    if (text.startsWith("/") && commandRouter) {
      const result = await commandRouter.execute(text, "discord", userId, userName);
      if (result) {
        return sendDiscordMessage(message, result.text);
      }
    }

    await message.channel.sendTyping();

    try {
      const reply = await aiEngine.chat("discord", userId, text, userName);
      await sendDiscordMessage(message, reply);
    } catch (err) {
      console.error("Discord handler error:", err.message);
      await message.reply("❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
    }
  });

  client.login(token);
  return client;
}

/**
 * Send reply to a Discord interaction (handles deferred + chunking)
 */
async function sendDiscordReply(interaction, text) {
  if (text.length > 1900) {
    const chunks = text.match(/.{1,1900}/gs);
    if (interaction.deferred) {
      await interaction.editReply(chunks[0]);
    } else {
      await interaction.reply(chunks[0]);
    }
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } else {
    if (interaction.deferred) {
      await interaction.editReply(text);
    } else {
      await interaction.reply(text);
    }
  }
}

/**
 * Send message reply (handles chunking for 2000 char limit)
 */
async function sendDiscordMessage(message, text) {
  if (text.length > 1900) {
    const chunks = text.match(/.{1,1900}/gs);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } else {
    await message.reply(text);
  }
}

module.exports = setupDiscord;
