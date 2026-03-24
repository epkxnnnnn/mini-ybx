/**
 * Telegram Bot — Yellow Box Markets
 */
const TelegramBot = require("node-telegram-bot-api");

function setupTelegram(aiEngine) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("⏭️  Telegram: No token, skipping");
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });

  // /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name || "Trader";
    bot.sendMessage(
      chatId,
      `สวัสดีครับ ${name}! 👋\n\n` +
        `ผมคือ **YBX Assistant** ผู้ช่วย AI ของ Yellow Box Markets\n\n` +
        `🔹 วิเคราะห์ตลาดด้วย ENGULF-X\n` +
        `🔹 ตอบคำถามเรื่องบัญชี/แพลตฟอร์ม\n` +
        `🔹 สอนกลยุทธ์การเทรด\n\n` +
        `พิมพ์ข้อความได้เลยครับ! 💬\n\n` +
        `คำสั่ง:\n` +
        `/analyze [symbol] — วิเคราะห์สินทรัพย์\n` +
        `/checklist — ดูเช็คลิสต์ 5 ขั้นตอน\n` +
        `/zones — ตาราง Zone Priority\n` +
        `/reset — เริ่มบทสนทนาใหม่`,
      { parse_mode: "Markdown" }
    );
  });

  // /checklist command
  bot.onText(/\/checklist/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `📋 **ENGULF-X เช็คลิสต์ 5 ขั้นตอน**\n\n` +
        `1️⃣ BOS — MAJOR หรือ MINOR?\n` +
        `2️⃣ YELLOW BOX — กล่อง RET ที่ยังไม่ได้ใช้\n` +
        `3️⃣ CONFIRM — CHOCH PULLBACK\n` +
        `4️⃣ ZONE — 1ST MAJOR หรือ KF\n` +
        `5️⃣ ACTION — คำนวณ TP/SL\n\n` +
        `❗ กฎ 1%/2% อัตโนมัติมีความสำคัญสูงสุด\n` +
        `• BUY = ราคาลด 1% → ซื้อทันที\n` +
        `• SELL = ราคาเพิ่ม 2% → ขายทันที`,
      { parse_mode: "Markdown" }
    );
  });

  // /zones command
  bot.onText(/\/zones/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `📊 **Zone Priority Table**\n\n` +
        `1. 1ST MAJOR ★★★★★ — 100% size, R:R 1:1.5\n` +
        `2. KF (ข้ามฟาก) ★★★★☆ — 100% size, R:R 1:2\n` +
        `3. YELLOW BOX ★★★☆☆ — 80% size, R:R 1:2.5\n` +
        `4. MAJOR BOX ★★☆☆☆ — 60% size, R:R 1:3\n` +
        `5. MINOR RET ★☆☆☆☆ — 50% size, R:R 1:3+\n\n` +
        `⚠️ ถ้า R:R ไม่ถึงขั้นต่ำ → SKIP`,
      { parse_mode: "Markdown" }
    );
  });

  // /reset command
  bot.onText(/\/reset/, (msg) => {
    aiEngine.resetConversation("telegram", msg.from.id);
    bot.sendMessage(msg.chat.id, "🔄 เริ่มบทสนทนาใหม่แล้วครับ");
  });

  // Handle all other messages
  bot.on("message", async (msg) => {
    // Skip commands
    if (msg.text && msg.text.startsWith("/")) return;
    if (!msg.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || "";

    // Show typing indicator
    bot.sendChatAction(chatId, "typing");

    try {
      const reply = await aiEngine.chat(
        "telegram",
        userId,
        msg.text,
        userName
      );

      // Telegram has 4096 char limit — split if needed
      if (reply.length > 4000) {
        const chunks = reply.match(/.{1,4000}/gs);
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
        }
      } else {
        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      }
    } catch (err) {
      console.error("Telegram handler error:", err.message);
      bot.sendMessage(chatId, "❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
    }
  });

  console.log("✅ Telegram bot started");
  return bot;
}

module.exports = setupTelegram;
