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

function setupDiscord(aiEngine) {
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
      .setName("analyze")
      .setDescription("วิเคราะห์ตลาดด้วย ENGULF-X")
      .addStringOption((opt) =>
        opt
          .setName("symbol")
          .setDescription("สินทรัพย์ เช่น XAUUSD, EURUSD, BTC")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("checklist")
      .setDescription("แสดงเช็คลิสต์ 5 ขั้นตอน ENGULF-X"),
    new SlashCommandBuilder()
      .setName("zones")
      .setDescription("แสดงตาราง Zone Priority"),
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

    if (interaction.commandName === "checklist") {
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("📋 ENGULF-X เช็คลิสต์ 5 ขั้นตอน")
        .addFields(
          { name: "1️⃣ BOS", value: "MAJOR หรือ MINOR?", inline: true },
          { name: "2️⃣ YELLOW BOX", value: "RET ที่ยังไม่ได้ใช้", inline: true },
          { name: "3️⃣ CONFIRM", value: "CHOCH PULLBACK", inline: true },
          { name: "4️⃣ ZONE", value: "1ST MAJOR หรือ KF", inline: true },
          { name: "5️⃣ ACTION", value: "คำนวณ TP/SL", inline: true }
        )
        .setFooter({ text: "กฎ 1%/2% อัตโนมัติ มีความสำคัญสูงสุด!" });
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "zones") {
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("📊 Zone Priority Table")
        .setDescription(
          "```\n" +
            "Priority | Zone       | Stars | Size | R:R\n" +
            "---------|------------|-------|------|-----\n" +
            "1 (Best) | 1ST MAJOR  | ★★★★★ | 100% | 1:1.5\n" +
            "2        | KF         | ★★★★☆ | 100% | 1:2\n" +
            "3        | YELLOW BOX | ★★★☆☆ | 80%  | 1:2.5\n" +
            "4        | MAJOR BOX  | ★★☆☆☆ | 60%  | 1:3\n" +
            "5 (Avoid)| MINOR RET  | ★☆☆☆☆ | 50%  | 1:3+\n" +
            "```"
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "reset") {
      aiEngine.resetConversation("discord", userId);
      return interaction.reply("🔄 เริ่มบทสนทนาใหม่แล้วครับ");
    }

    if (interaction.commandName === "analyze") {
      const symbol = interaction.options.getString("symbol");
      await interaction.deferReply();

      try {
        const reply = await aiEngine.chat(
          "discord",
          userId,
          `วิเคราะห์ ${symbol} ด้วย ENGULF-X ให้หน่อย`,
          userName
        );

        // Discord has 2000 char limit
        if (reply.length > 1900) {
          const chunks = reply.match(/.{1,1900}/gs);
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
          }
        } else {
          await interaction.editReply(reply);
        }
      } catch (err) {
        await interaction.editReply("❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
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

    await message.channel.sendTyping();

    try {
      const reply = await aiEngine.chat("discord", userId, text, userName);

      if (reply.length > 1900) {
        const chunks = reply.match(/.{1,1900}/gs);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } else {
        await message.reply(reply);
      }
    } catch (err) {
      console.error("Discord handler error:", err.message);
      await message.reply("❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
    }
  });

  client.login(token);
  return client;
}

module.exports = setupDiscord;
