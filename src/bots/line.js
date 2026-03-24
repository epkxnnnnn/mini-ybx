/**
 * LINE Bot — Yellow Box Markets
 */
const line = require("@line/bot-sdk");

function setupLINE(app, aiEngine) {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken || !channelSecret) {
    console.log("⏭️  LINE: No credentials, skipping");
    return null;
  }

  const config = { channelAccessToken, channelSecret };
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken,
  });

  // LINE webhook endpoint
  app.post("/webhook/line", line.middleware(config), async (req, res) => {
    res.status(200).end(); // Always respond 200 to LINE

    const events = req.body.events || [];

    for (const event of events) {
      try {
        await handleEvent(event, client, aiEngine);
      } catch (err) {
        console.error("LINE event error:", err.message);
      }
    }
  });

  console.log("✅ LINE bot webhook registered at /webhook/line");
  return client;
}

async function handleEvent(event, client, aiEngine) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // Quick commands
  if (text === "/start" || text === "เริ่มต้น") {
    return client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text:
            "สวัสดีครับ! 👋\n\n" +
            "ผมคือ YBX Assistant ผู้ช่วย AI ของ Yellow Box Markets\n\n" +
            "🔹 วิเคราะห์ตลาดด้วย ENGULF-X\n" +
            "🔹 ตอบคำถามเรื่องบัญชี/แพลตฟอร์ม\n" +
            "🔹 สอนกลยุทธ์การเทรด\n\n" +
            "พิมพ์ข้อความได้เลยครับ! 💬",
        },
      ],
    });
  }

  if (text === "/checklist" || text === "เช็คลิสต์") {
    return client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text:
            "📋 ENGULF-X เช็คลิสต์ 5 ขั้นตอน\n\n" +
            "1️⃣ BOS — MAJOR หรือ MINOR?\n" +
            "2️⃣ YELLOW BOX — กล่อง RET ที่ยังไม่ได้ใช้\n" +
            "3️⃣ CONFIRM — CHOCH PULLBACK\n" +
            "4️⃣ ZONE — 1ST MAJOR หรือ KF\n" +
            "5️⃣ ACTION — คำนวณ TP/SL\n\n" +
            "❗ กฎ 1%/2% อัตโนมัติ มีความสำคัญสูงสุด\n" +
            "• BUY = ราคาลด 1% → ซื้อทันที\n" +
            "• SELL = ราคาเพิ่ม 2% → ขายทันที",
        },
      ],
    });
  }

  if (text === "/reset" || text === "เริ่มใหม่") {
    aiEngine.resetConversation("line", userId);
    return client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "🔄 เริ่มบทสนทนาใหม่แล้วครับ" }],
    });
  }

  // AI chat
  try {
    const reply = await aiEngine.chat("line", userId, text);

    // LINE has 5000 char limit per message, max 5 messages per reply
    const messages = [];
    if (reply.length > 4500) {
      const chunks = reply.match(/.{1,4500}/gs);
      for (const chunk of chunks.slice(0, 5)) {
        messages.push({ type: "text", text: chunk });
      }
    } else {
      messages.push({ type: "text", text: reply });
    }

    await client.replyMessage({ replyToken, messages });
  } catch (err) {
    console.error("LINE reply error:", err.message);
    await client.replyMessage({
      replyToken,
      messages: [
        { type: "text", text: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ" },
      ],
    });
  }
}

module.exports = setupLINE;
