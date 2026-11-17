const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔑 کلید API واقعی خودت را اینجا بگذار
process.env.GEMINI_API_KEY

const activeAccounts = {};
const chatHistory = {};

const SYSTEM_PROMPT = `تو یک دستیار هوش مصنوعی بسیار باهوش، مودب، تحلیل‌گر و مسلط به زبان فارسی هستی.

قوانین پاسخ‌گویی:
1. پاسخ‌هایت باید به زبان فارسی بسیار روان، طبیعی، محترمانه و کامل باشند.
2. از حروف یا کلمات نامفهوم استفاده نکن و هرگز پیام کاربر را تکرار نکن.
3. برای زیباسازی پیام در واتساپ:
   - پیام را با یک ایموجی مرتبط و تیتر کوتاه و *ضخیم* شروع کن.
   - نکات مهم را با بولت (•) یا شماره‌گذاری مرتب بنویس.
   - کلمات کلیدی مهم را بین ستاره (*کلمه*) قرار بده.`;

async function askGemini(userId, newMessage) {
    if (!chatHistory[userId]) {
        chatHistory[userId] = [];
    }

    chatHistory[userId].push({
        role: 'user',
        parts: [{ text: newMessage }]
    });

    if (chatHistory[userId].length > 10) {
        chatHistory[userId] = chatHistory[userId].slice(-10);
    }

    const models = ['gemini-3.8-flash', 'gemini-3.1-pro-preview'];

    for (const model of models) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
            
            const response = await axios.post(url, {
                system_instruction: {
                    parts: [{ text: SYSTEM_PROMPT }]
                },
                contents: chatHistory[userId],
                generationConfig: {
                    temperature: 0.6
                }
            });

            const aiReply = response.data.candidates[0].content.parts[0].text.trim();

            chatHistory[userId].push({
                role: 'model',
                parts: [{ text: aiReply }]
            });

            return aiReply;
        } catch (error) {
            const status = error.response?.status;
            if (status === 400 || status === 429 || status === 503 || status === 404) {
                continue;
            }
            break;
        }
    }

    chatHistory[userId].pop();
    return '⚠️ خطا در ارتباط با هوش مصنوعی. لطفاً دوباره تلاش کنید.';
}

async function startAccount(accountName, phoneNumber = null) {
    if (activeAccounts[accountName]?.status === 'متصل') return { status: 'already_connected' };

    activeAccounts[accountName] = { status: 'در حال دریافت کد...', code: null, sock: null };
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${accountName}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    activeAccounts[accountName].sock = sock;

    if (!sock.authState.creds.registered && phoneNumber) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            const code = await sock.requestPairingCode(cleanNumber);
            // قالب‌بندی کد ۶ رقمی به شکل XXXX-XX برای خوانایی بهتر
            const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
            activeAccounts[accountName].code = formattedCode;
            activeAccounts[accountName].status = 'منتظر ورود کد در واتساپ';
        } catch (err) {
            activeAccounts[accountName].status = 'خطا در دریافت کد';
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            activeAccounts[accountName].status = 'قطع شده';
            if (shouldReconnect) {
                setTimeout(() => startAccount(accountName), 5000);
            } else {
                fs.rmSync(`./sessions/${accountName}`, { recursive: true, force: true });
                delete activeAccounts[accountName];
            }
        } else if (connection === 'open') {
            activeAccounts[accountName].status = 'متصل';
            activeAccounts[accountName].code = null;
            console.log(`✅ اکانت [${accountName}] متصل شد!`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        if (remoteJid.endsWith('@g.us')) return;

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!text) return;

        if (text === '/پاک' || text === '/reset') {
            delete chatHistory[remoteJid];
            await sock.sendMessage(remoteJid, { text: '🧹 *حافظه گفتگوی ما پاک شد!*' });
            return;
        }

        await sock.sendPresenceUpdate('composing', remoteJid);
        const aiReply = await askGemini(remoteJid, text);
        await sock.sendMessage(remoteJid, { text: aiReply });
    });

    return activeAccounts[accountName];
}

if (fs.existsSync('./sessions')) {
    const savedSessions = fs.readdirSync('./sessions');
    savedSessions.forEach(acc => startAccount(acc));
}

// 🌐 روت اصلی پنل مدیریت با سیستم لاگین و داشبورد
app.get('/', (req, res) => {
    const connectedAccount = Object.keys(activeAccounts).find(acc => activeAccounts[acc].status === 'متصل');
    const pendingAccount = Object.keys(activeAccounts).find(acc => activeAccounts[acc].status !== 'متصل');

    // حالت اول: اگر هیچ اکانتی متصل نیست یا در حال گرفتن کد است -> صفحه لاگین و دریافت کد
    if (!connectedAccount) {
        let pendingBox = '';
        if (pendingAccount) {
            const accData = activeAccounts[pendingAccount];
            if (accData.code) {
                pendingBox = `
                <div class="code-box-container">
                    <p style="color: #aaa; font-size: 14px; margin-bottom: 5px;">کد اتصال ۶ رقمی شما:</p>
                    <div class="code-box">${accData.code}</div>
                    <p style="font-size: 12px; color: #ffcc80; margin-top: 8px;">این کد را در بخش Linked Devices واتساپ گوشی خود وارد کنید.</p>
                </div>`;
            } else {
                pendingBox = `<p style="text-align:center; color:#ffcc80; margin-top:15px;">⏳ ${accData.status}</p>`;
            }
        }

        return res.send(`
        <!DOCTYPE html>
        <html lang="fa" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ورود به پنل مدیریت واتساپ</title>
            <style>
                body { font-family: Tahoma, sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
                .login-card { background: #1e1e1e; padding: 24px; border-radius: 16px; width: 100%; max-width: 400px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); text-align: center; }
                h2 { color: #25D366; margin-bottom: 20px; }
                input, button { width: 100%; padding: 14px; margin-top: 12px; border-radius: 8px; border: none; font-size: 16px; box-sizing: border-box; }
                input { background: #2c2c2c; color: #fff; text-align: center; letter-spacing: 1px; }
                button { background: #25D366; color: #000; font-weight: bold; cursor: pointer; transition: 0.2s; }
                button:active { transform: scale(0.98); }
                .code-box-container { margin-top: 20px; background: #252525; padding: 16px; border-radius: 10px; }
                .code-box { background: #000; padding: 12px; font-size: 24px; color: #25D366; letter-spacing: 4px; border-radius: 6px; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h2>🤖 ورود به ربات واتساپ</h2>
                <p style="color: #aaa; font-size: 13px; margin-bottom: 15px;">برای شروع، شماره واتساپ خود را با کد کشور وارد کنید:</p>
                <input type="text" id="phone" placeholder="93790000000">
                <button onclick="requestPairingCode()">دریافت کد تایید ۶ رقمی</button>
                ${pendingBox}
            </div>

            <script>
                async function requestPairingCode() {
                    const phone = document.getElementById('phone').value;
                    if(!phone) return alert('لطفاً شماره خود را وارد کنید');
                    
                    await fetch('/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone })
                    });
                    setTimeout(() => location.reload(), 3000);
                }
            </script>
        </body>
        </html>
        `);
    }

    // حالت دوم: اگر اکانت متصل است -> نمایش داشبورد اصلی، چت‌ها و تنظیمات
    let activeChatsHtml = Object.keys(chatHistory).map(jid => `
        <div class="chat-item">
            <span>👤 ${jid.split('@')[0]}</span>
            <button onclick="clearChat('${jid}')" style="background:#d32f2f; padding:6px 12px; font-size:12px; width:auto;">پاک کردن حافظه</button>
        </div>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="fa" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>داشبورد مدیریت واتساپ</title>
        <style>
            body { font-family: Tahoma, sans-serif; background: #121212; color: #fff; padding: 16px; max-width: 480px; margin: auto; }
            .header { display: flex; justify-content: space-between; align-items: center; background: #1e1e1e; padding: 14px 16px; border-radius: 12px; margin-bottom: 16px; }
            h2 { color: #25D366; margin: 0; font-size: 18px; }
            .badge { background: #1b5e20; color: #a5d6a7; padding: 4px 10px; border-radius: 6px; font-size: 12px; }
            .box { background: #1e1e1e; padding: 16px; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
            input, textarea, button { width: 100%; padding: 12px; margin-top: 8px; border-radius: 8px; border: none; font-size: 15px; box-sizing: border-box; }
            input, textarea { background: #2c2c2c; color: #fff; }
            button { background: #25D366; color: #000; font-weight: bold; cursor: pointer; transition: 0.2s; }
            button:active { transform: scale(0.98); }
            .chat-item { background: #252525; padding: 10px; border-radius: 6px; margin-top: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 14px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>🤖 پنل مدیریت ربات</h2>
            <span class="badge">متصل (${connectedAccount})</span>
        </div>

        <div class="box">
            <label><strong>💬 ارسال پیام مستقیم:</strong></label>
            <input type="text" id="targetPhone" placeholder="شماره گیرنده (مثال: 93790000000)">
            <textarea id="messageText" rows="2" placeholder="متن پیام..."></textarea>
            <button onclick="sendMessage()" style="background:#00bcd4; color:#000;">ارسال پیام</button>
        </div>

        <div class="box">
            <strong>🧠 گفتگوهای فعال ربات:</strong>
            ${activeChatsHtml || '<p style="color:#777; font-size:13px; margin-top:8px;">هنوز گفتگوی فعالی ثبت نشده است.</p>'}
        </div>

        <div class="box">
            <strong>⚙️ تنظیمات و مدیریت:</strong>
            <button onclick="location.reload()" style="background:#333; color:#fff; margin-top:10px;">🔄 بروزرسانی صفحه</button>
            <button onclick="logoutAccount('${connectedAccount}')" style="background:#d32f2f; color:#fff; margin-top:10px;">🚪 خروج و قطع اتصال اکانت</button>
        </div>

        <script>
            async function sendMessage() {
                const phone = document.getElementById('targetPhone').value;
                const message = document.getElementById('messageText').value;
                if(!phone || !message) return alert('شماره و متن پیام را کامل وارد کنید');
                
                const res = await fetch('/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, message })
                });
                const data = await res.json();
                if(data.ok) {
                    alert('✅ پیام با موفقیت ارسال شد!');
                    document.getElementById('targetPhone').value = '';
                    document.getElementById('messageText').value = '';
                } else {
                    alert('❌ خطا در ارسال پیام.');
                }
            }

            async function clearChat(jid) {
                if(!confirm('حافظه این گفتگو پاک شود؟')) return;
                await fetch('/clearchat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jid })
                });
                location.reload();
            }

            async function logoutAccount(accName) {
                if(!confirm('آیا می‌خواهید از این اکانت خارج شوید؟')) return;
                await fetch('/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accName })
                });
                location.reload();
            }
        </script>
    </body>
    </html>
    `);
});

app.post('/add', async (req, res) => {
    const { phone } = req.body;
    const accName = 'acc_' + phone.replace(/[^0-9]/g, '');
    await startAccount(accName, phone);
    res.json({ ok: true });
});

app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    const cleanPhone = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    
    const activeAccName = Object.keys(activeAccounts).find(acc => activeAccounts[acc].status === 'متصل');
    if (!activeAccName) return res.json({ ok: false, error: 'No connected account' });

    try {
        const sock = activeAccounts[activeAccName].sock;
        await sock.sendMessage(cleanPhone, { text: message });
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

app.post('/clearchat', (req, res) => {
    const { jid } = req.body;
    if (chatHistory[jid]) {
        delete chatHistory[jid];
    }
    res.json({ ok: true });
});

app.post('/logout', (req, res) => {
    const { accName } = req.body;
    if (activeAccounts[accName]) {
        try {
            activeAccounts[accName].sock?.logout();
            fs.rmSync(`./sessions/${accName}`, { recursive: true, force: true });
            delete activeAccounts[accName];
        } catch(e) {}
    }
    res.json({ ok: true });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('🌐 پنل مدیریت امن آماده است! در مرورگر گوشی آدرس IP کامپیوتر و پورت 3000 را باز کنید.');
});