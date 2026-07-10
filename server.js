const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const puppeteer = require('puppeteer');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

let clientReady = false;
let lastQR = null;
let scheduledJobs = [];

function loadScheduledJobs() {
    try {
        if (fs.existsSync('scheduled.json')) {
            const data = fs.readFileSync('scheduled.json', 'utf8');
            scheduledJobs = JSON.parse(data);
        }
    } catch (e) {
        console.error('Error loading scheduled jobs:', e);
    }
}

function saveScheduledJobs() {
    try {
        fs.writeFileSync('scheduled.json', JSON.stringify(scheduledJobs, null, 2));
    } catch (e) {
        console.error('Error saving scheduled jobs:', e);
    }
}

function cleanNumber(raw) {
    let num = raw.toString().replace(/\D/g, '');
    num = num.replace(/^0+/, '');
    if (num.length === 10) num = '91' + num;
    else if (num.length === 11 && num.startsWith('0')) num = '91' + num.slice(1);
    else if (num.length === 12 && num.startsWith('91')) {}
    else return null;
    if (num.length === 12 && num.startsWith('91')) return num;
    return null;
}

// Function to download Chrome at runtime using the correct API
async function downloadChromeAtRuntime() {
    console.log('📥 Downloading Chrome at runtime...');
    try {
        // Use the correct BrowserFetcher API
        const browserFetcher = puppeteer.createBrowserFetcher();
        const revisionInfo = await browserFetcher.download('121.0.6167.85');
        console.log('✅ Chrome downloaded to:', revisionInfo.executablePath);
        return revisionInfo.executablePath;
    } catch (error) {
        console.error('❌ Failed to download Chrome:', error.message);
        return null;
    }
}

// Start the app
async function startApp() {
    console.log('🚀 Starting application...');

    // Try to find Chrome in various locations
    let chromePath = null;
    const possiblePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/opt/render/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome'
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            chromePath = p;
            console.log('✅ Found Chrome at:', p);
            break;
        }
    }

    // If Chrome wasn't found, download it at runtime
    if (!chromePath) {
        console.log('⚠️ Chrome not found in standard locations.');
        chromePath = await downloadChromeAtRuntime();
    }

    // If we still don't have Chrome, we can't continue
    if (!chromePath) {
        console.error('❌ Could not find or download Chrome. Exiting.');
        process.exit(1);
    }

    console.log('🔧 Using Chrome at:', chromePath);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: './session' }),
        puppeteer: {
            headless: true,
            executablePath: chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--disable-accelerated-jpeg-decoding',
                '--disable-accelerated-mjpeg-decode',
                '--disable-accelerated-video-decode'
            ]
        }
    });

    client.on('qr', (qr) => {
        lastQR = qr;
        console.log('📱 QR Code generated. Scan with WhatsApp!');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        clientReady = true;
        lastQR = null;
        console.log('✅ WhatsApp client ready!');
        loadScheduledJobs();
        console.log(`📋 ${scheduledJobs.length} scheduled jobs loaded`);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Auth failed:', msg);
    });
    
    client.on('disconnected', (reason) => {
        clientReady = false;
        console.log('🔌 Disconnected:', reason);
        console.log('🔄 Reconnecting in 5s...');
        setTimeout(() => {
            console.log('🔄 Attempting to reconnect...');
            client.initialize();
        }, 5000);
    });

    await client.initialize();

    // ----- ROUTES -----
    app.get('/', (req, res) => {
        res.json({ 
            status: 'WhatsApp Bot Running',
            ready: clientReady,
            version: '1.0.0'
        });
    });

    app.get('/status', (req, res) => {
        res.json({ 
            ready: clientReady, 
            qr: lastQR,
            scheduledJobs: scheduledJobs.length 
        });
    });

    app.get('/scheduled', (req, res) => {
        res.json({ jobs: scheduledJobs });
    });

    app.delete('/scheduled/:id', (req, res) => {
        const id = req.params.id;
        const index = scheduledJobs.findIndex(j => j.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Job not found' });
        }
        scheduledJobs.splice(index, 1);
        saveScheduledJobs();
        res.json({ success: true, message: 'Job deleted' });
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
            
            for (const filePath of mediaFiles) {
                if (fs.existsSync(filePath)) {
                    try {
                        mediaObjs.push(MessageMedia.fromFilePath(filePath));
                    } catch (err) {
                        console.error('Error loading media:', err);
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
            
            const concurrency = req.body.concurrency || 20;
            const workers = Array(Math.min(concurrency, validNumbers.length)).fill().map(() => worker());
            await Promise.all(workers);
            
            for (const f of mediaFiles) {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            }
            
            res.json({
                success: true,
                total: validNumbers.length,
                sent, 
                failed,
                invalid: invalidNumbers,
                errors: errors.slice(0, 20)
            });
        } catch (err) {
            console.error('Error in send-bulk:', err);
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
                    if (!clientReady) {
                        console.log('Client not ready, skipping job');
                        return;
                    }
                    
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
                            console.error('Failed to send to', number, err.message);
                        }
                    }
                    
                    job.status = 'completed';
                    job.sent = sent;
                    job.failed = failed;
                    job.completedAt = new Date().toISOString();
                    saveScheduledJobs();
                    console.log(`Job ${job.id} completed: ${sent} sent, ${failed} failed`);
                });
                console.log(`📅 Scheduled job ${job.id} for ${date.toISOString()}`);
            } else {
                job.status = 'invalid-time';
                saveScheduledJobs();
                console.log(`Job ${job.id} has invalid time: ${date.toISOString()}`);
            }
            
            res.json({ 
                success: true, 
                jobId: job.id,
                scheduledTime: date.toISOString()
            });
        } catch (err) {
            console.error('Error in schedule:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🌐 Status endpoint: http://localhost:${PORT}/status`);
    });
}

// Start the application
startApp().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
