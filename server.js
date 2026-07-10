const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const fs = require('fs');
const schedule = require('node-schedule');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Ensure directories exist
const dirs = ['uploads', 'session'];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Multer config
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

let clientReady = false;
let lastQR = null;
let scheduledJobs = [];
let isInitializing = false;

// Scheduled jobs
function loadScheduledJobs() {
    try {
        if (fs.existsSync('scheduled.json')) {
            const data = fs.readFileSync('scheduled.json', 'utf8');
            scheduledJobs = JSON.parse(data);
        }
    } catch (e) {
        console.error('Failed to load scheduled jobs:', e);
    }
}

function saveScheduledJobs() {
    try {
        fs.writeFileSync('scheduled.json', JSON.stringify(scheduledJobs, null, 2));
    } catch (e) {
        console.error('Failed to save scheduled jobs:', e);
    }
}

function cleanNumber(raw) {
    let num = raw.toString().replace(/\D/g, '');
    num = num.replace(/^0+/, '');
    if (num.length === 10) num = '91' + num;
    else if (num.length === 11 && num.startsWith('0')) num = '91' + num.slice(1);
    else if (num.length === 12 && num.startsWith('91')) { /* valid */ }
    else return null;
    if (num.length === 12 && num.startsWith('91')) return num;
    return null;
}

// WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    lastQR = qr;
    console.log('QR Code generated. Scan with WhatsApp.');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Authentication successful.');
});

client.on('ready', () => {
    clientReady = true;
    lastQR = null;
    console.log('WhatsApp client ready!');
    loadScheduledJobs();
});

client.on('auth_failure', (msg) => {
    console.error('Auth failed:', msg);
    clientReady = false;
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    clientReady = false;
    if (reason === 'destroyed') return;
    if (!isInitializing) {
        isInitializing = true;
        setTimeout(() => {
            console.log('Reinitializing client...');
            client.initialize();
            isInitializing = false;
        }, 5000);
    }
});

client.initialize();

// Routes
app.get('/status', (req, res) => {
    res.json({ ready: clientReady, qr: lastQR });
});

app.get('/scheduled', (req, res) => {
    res.json({ jobs: scheduledJobs });
});

app.delete('/scheduled/:id', (req, res) => {
    const id = req.params.id;
    const index = scheduledJobs.findIndex(j => j.id === id);
    if (index === -1) return res.status(404).json({ error: 'Job not found' });
    scheduledJobs.splice(index, 1);
    saveScheduledJobs();
    res.json({ success: true });
});

app.post('/send-bulk', upload.array('media', 10), async (req, res) => {
    try {
        let numbers, message;
        let mediaFiles = [];
        
        if (req.files && req.files.length > 0) {
            mediaFiles = req.files.map(f => f.path);
            numbers = JSON.parse(req.body.numbers);
            message = req.body.message || '';
        } else {
            numbers = req.body.numbers;
            message = req.body.message;
        }

        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({ error: 'No numbers provided' });
        }
        if (!message && mediaFiles.length === 0) {
            return res.status(400).json({ error: 'Missing message or media' });
        }
        if (!clientReady) {
            return res.status(503).json({ error: 'WhatsApp not ready' });
        }

        const validNumbers = [];
        const invalidNumbers = [];
        for (const raw of numbers) {
            const cleaned = cleanNumber(raw);
            if (cleaned) validNumbers.push(cleaned + '@c.us');
            else invalidNumbers.push(raw);
        }

        if (validNumbers.length === 0) {
            return res.status(400).json({ error: 'No valid numbers', invalid: invalidNumbers });
        }

        let sent = 0, failed = 0, idx = 0;
        const errors = [];
        const mediaObjs = [];

        for (const path of mediaFiles) {
            if (fs.existsSync(path)) {
                try {
                    mediaObjs.push(MessageMedia.fromFilePath(path));
                } catch (err) {
                    console.error('Failed to load media:', err);
                }
            }
        }

        async function worker() {
            while (idx < validNumbers.length) {
                const i = idx++;
                const chatId = validNumbers[i];
                try {
                    if (mediaObjs.length > 0) {
                        for (const media of mediaObjs) {
                            await client.sendMessage(chatId, media, { caption: message || '' });
                        }
                    } else {
                        await client.sendMessage(chatId, message);
                    }
                    sent++;
                } catch (err) {
                    failed++;
                    errors.push({ number: chatId, error: err.message });
                }
            }
        }

        const concurrency = req.body.concurrency || 10;
        const workers = Array(Math.min(concurrency, validNumbers.length)).fill().map(() => worker());
        await Promise.all(workers);

        for (const f of mediaFiles) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }

        res.json({
            total: validNumbers.length,
            sent,
            failed,
            invalid: invalidNumbers,
            errors: errors.slice(0, 20)
        });
    } catch (err) {
        console.error('Send-bulk error:', err);
        if (req.files) {
            for (const f of req.files) {
                if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
            }
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/schedule', upload.array('media', 10), async (req, res) => {
    try {
        let numbers, message, scheduledTime;
        let mediaFiles = [];

        if (req.files && req.files.length > 0) {
            mediaFiles = req.files.map(f => f.path);
            numbers = JSON.parse(req.body.numbers);
            message = req.body.message || '';
            scheduledTime = req.body.scheduledTime;
        } else {
            numbers = req.body.numbers;
            message = req.body.message;
            scheduledTime = req.body.scheduledTime;
        }

        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({ error: 'Missing numbers' });
        }
        if (!message && mediaFiles.length === 0) {
            return res.status(400).json({ error: 'Missing message or media' });
        }
        if (!scheduledTime) {
            return res.status(400).json({ error: 'Missing scheduled time' });
        }

        const validNumbers = [];
        for (const raw of numbers) {
            const cleaned = cleanNumber(raw);
            if (cleaned) validNumbers.push(cleaned);
        }

        if (validNumbers.length === 0) {
            return res.status(400).json({ error: 'No valid numbers' });
        }

        const job = {
            id: Date.now().toString(),
            numbers: validNumbers,
            message: message || '',
            mediaFiles: mediaFiles || [],
            scheduledTime: scheduledTime,
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        scheduledJobs.push(job);
        saveScheduledJobs();

        const date = new Date(scheduledTime);
        if (date > new Date()) {
            schedule.scheduleJob(date, async function() {
                console.log('Executing scheduled job:', job.id);
                if (!clientReady) return;
                let sent = 0, failed = 0;
                for (const number of job.numbers) {
                    try {
                        const chatId = number + '@c.us';
                        if (job.mediaFiles && job.mediaFiles.length > 0) {
                            for (const mediaPath of job.mediaFiles) {
                                if (fs.existsSync(mediaPath)) {
                                    const media = MessageMedia.fromFilePath(mediaPath);
                                    await client.sendMessage(chatId, media, { caption: job.message || '' });
                                }
                            }
                        } else {
                            await client.sendMessage(chatId, job.message);
                        }
                        sent++;
                    } catch (err) {
                        failed++;
                    }
                }
                job.status = 'completed';
                job.sent = sent;
                job.failed = failed;
                job.completedAt = new Date().toISOString();
                saveScheduledJobs();
            });
        }

        res.json({ success: true, jobId: job.id });
    } catch (err) {
        console.error('Schedule error:', err);
        if (req.files) {
            for (const f of req.files) {
                if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
            }
        }
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        whatsapp: clientReady ? 'connected' : 'disconnected',
        uptime: process.uptime()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port', PORT);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await client.destroy();
    process.exit(0);
});
