const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const multer = require('multer');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DELAY_MS = parseInt(process.env.DELAY_MS) || 30000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 50;

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const upload = multer({ dest: 'uploads/' });

const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// ==================== FUNÇÕES DE DADOS ====================

function loadContacts() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
        }
    } catch (error) {
        console.error('Erro ao carregar contatos:', error);
    }
    return [];
}

function saveContacts(contacts) {
    try {
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
        return true;
    } catch (error) {
        console.error('Erro ao salvar contatos:', error);
        return false;
    }
}

function loadMessages() {
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
        }
    } catch (error) {
        console.error('Erro ao carregar mensagens:', error);
    }
    return [];
}

function saveMessages(messages) {
    try {
        // Manter apenas as últimas 1000 mensagens para não crescer indefinidamente
        const trimmed = messages.slice(-1000);
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(trimmed, null, 2));
        return true;
    } catch (error) {
        console.error('Erro ao salvar mensagens:', error);
        return false;
    }
}

// Garantir diretórios necessários
['session', 'uploads', 'public'].forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// ==================== CLIENTE WHATSAPP ====================

let client = null;
let isReady = false;
let qrCodeData = null;
let isSending = false;
let cancelSending = false;

function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "bulk-sender",
            dataPath: path.join(__dirname, 'session')
        }),
        puppeteer: {
            headless: true,
            executablePath: '/usr/bin/google-chrome-stable',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR Code recebido');
        try {
            qrCodeData = await QRCode.toDataURL(qr);
            io.emit('qr', qrCodeData);
        } catch (err) {
            console.error('Erro ao gerar QR:', err);
        }
    });

    client.on('ready', () => {
        console.log('WhatsApp conectado!');
        isReady = true;
        qrCodeData = null;
        io.emit('ready', { message: 'WhatsApp conectado com sucesso!' });
    });

    client.on('authenticated', () => {
        console.log('Autenticado com sucesso');
        io.emit('authenticated');
    });

    client.on('auth_failure', (msg) => {
        console.error('Falha na autenticação:', msg);
        isReady = false;
        io.emit('auth_failure', { message: 'Falha na autenticação. Tente novamente.' });
    });

    client.on('disconnected', (reason) => {
        console.log('Cliente desconectado:', reason);
        isReady = false;
        io.emit('disconnected', { message: 'WhatsApp desconectado.' });
        setTimeout(() => initializeClient(), 5000);
    });

    // ==================== RECEBER MENSAGENS ====================
    client.on('message', async (msg) => {
        try {
            const contact = await msg.getContact();
            const chat = await msg.getChat();
            
            // Ignorar mensagens de grupos (opcional - pode ser configurável)
            if (chat.isGroup) return;

            const messageData = {
                id: msg.id._serialized || uuidv4(),
                from: msg.from.replace('@c.us', ''),
                fromName: contact.pushname || contact.name || msg.from.replace('@c.us', ''),
                body: msg.body,
                timestamp: msg.timestamp * 1000,
                receivedAt: new Date().toISOString(),
                isRead: false,
                replied: false,
                type: msg.type
            };

            const messages = loadMessages();
            messages.push(messageData);
            saveMessages(messages);

            io.emit('new_message', messageData);
            console.log(`Nova mensagem de ${messageData.fromName}: ${messageData.body}`);
        } catch (error) {
            console.error('Erro ao processar mensagem recebida:', error);
        }
    });

    client.initialize();
}

initializeClient();

// ==================== ROTAS DE CONTATOS ====================

app.get('/api/contacts', (req, res) => {
    res.json(loadContacts());
});

app.post('/api/contacts', (req, res) => {
    const { name, number, group } = req.body;
    if (!name || !number) {
        return res.status(400).json({ error: 'Nome e número são obrigatórios' });
    }

    const contacts = loadContacts();
    const cleanNumber = number.toString().replace(/\D/g, '');

    // Verificar duplicado
    if (contacts.some(c => c.number === cleanNumber)) {
        return res.status(400).json({ error: 'Número já cadastrado' });
    }

    const newContact = {
        id: uuidv4(),
        name: name.trim(),
        number: cleanNumber,
        group: group || 'Geral',
        createdAt: new Date().toISOString()
    };

    contacts.push(newContact);
    if (saveContacts(contacts)) {
        res.json(newContact);
    } else {
        res.status(500).json({ error: 'Erro ao salvar contato' });
    }
});

app.put('/api/contacts/:id', (req, res) => {
    const { id } = req.params;
    const { name, number, group } = req.body;

    const contacts = loadContacts();
    const index = contacts.findIndex(c => c.id === id);
    if (index === -1) return res.status(404).json({ error: 'Contato não encontrado' });

    if (name) contacts[index].name = name.trim();
    if (number) contacts[index].number = number.toString().replace(/\D/g, '');
    if (group !== undefined) contacts[index].group = group;

    if (saveContacts(contacts)) {
        res.json(contacts[index]);
    } else {
        res.status(500).json({ error: 'Erro ao atualizar contato' });
    }
});

app.post('/api/contacts/bulk-delete', (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Lista de IDs inválida' });
    }

    let contacts = loadContacts();
    const before = contacts.length;
    const newContacts = contacts.filter(c => !ids.includes(c.id));

    if (saveContacts(newContacts)) {
        res.json({ success: true, deleted: before - newContacts.length });
    } else {
        res.status(500).json({ error: 'Erro ao excluir contatos' });
    }
});

app.delete('/api/contacts/:id', (req, res) => {
    const { id } = req.params;
    let contacts = loadContacts();
    const newContacts = contacts.filter(c => c.id !== id);
    if (contacts.length === newContacts.length) {
        return res.status(404).json({ error: 'Contato não encontrado' });
    }
    if (saveContacts(newContacts)) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Erro ao excluir contato' });
    }
});

// Importar CSV
app.post('/api/contacts/import', upload.single('csvFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo CSV não enviado' });

    const csvContent = fs.readFileSync(req.file.path, 'utf-8');
    const Papa = require('papaparse');

    Papa.parse(csvContent, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
            const existingContacts = loadContacts();
            const existingNumbers = new Set(existingContacts.map(c => c.number));
            const newContacts = [];

            results.data.forEach(row => {
                const name = (row.nome || row.name || '').trim();
                const number = (row.telefone || row.phone || row.number || '').toString().replace(/\D/g, '');
                if (name && number && !existingNumbers.has(number)) {
                    newContacts.push({
                        id: uuidv4(),
                        name,
                        number,
                        group: row.grupo || row.group || 'Importados',
                        createdAt: new Date().toISOString()
                    });
                    existingNumbers.add(number);
                }
            });

            const allContacts = [...existingContacts, ...newContacts];
            fs.unlinkSync(req.file.path);

            if (saveContacts(allContacts)) {
                res.json({ success: true, imported: newContacts.length, total: allContacts.length });
            } else {
                res.status(500).json({ error: 'Erro ao salvar contatos' });
            }
        },
        error: (error) => {
            fs.unlinkSync(req.file.path);
            res.status(400).json({ error: 'Erro ao processar CSV: ' + error.message });
        }
    });
});

// ==================== ROTAS DE MENSAGENS (INBOX) ====================

app.get('/api/messages', (req, res) => {
    const messages = loadMessages();
    // Ordenar por mais recente
    messages.sort((a, b) => b.timestamp - a.timestamp);
    res.json(messages);
});

app.post('/api/messages/:id/read', (req, res) => {
    const messages = loadMessages();
    const msg = messages.find(m => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    msg.isRead = true;
    saveMessages(messages);
    res.json({ success: true });
});

app.post('/api/messages/mark-all-read', (req, res) => {
    const messages = loadMessages();
    messages.forEach(m => m.isRead = true);
    saveMessages(messages);
    res.json({ success: true });
});

app.delete('/api/messages/:id', (req, res) => {
    let messages = loadMessages();
    const before = messages.length;
    messages = messages.filter(m => m.id !== req.params.id);
    if (messages.length === before) return res.status(404).json({ error: 'Mensagem não encontrada' });
    saveMessages(messages);
    res.json({ success: true });
});

// Responder mensagem
app.post('/api/reply', async (req, res) => {
    if (!isReady) return res.status(400).json({ error: 'WhatsApp não está conectado' });

    const { to, message, messageId } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Destinatário e mensagem são obrigatórios' });

    try {
        const number = to.toString().replace(/\D/g, '') + '@c.us';
        const chat = await client.getChatById(number);
        await chat.sendMessage(message);

        // Marcar como respondida
        if (messageId) {
            const messages = loadMessages();
            const msg = messages.find(m => m.id === messageId);
            if (msg) {
                msg.replied = true;
                msg.isRead = true;
                saveMessages(messages);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao responder:', error);
        res.status(500).json({ error: 'Erro ao enviar resposta: ' + error.message });
    }
});

// ==================== ROTAS DE ENVIO ====================

app.get('/api/status', (req, res) => {
    res.json({
        ready: isReady,
        qr: qrCodeData,
        delay: DELAY_MS,
        batchSize: BATCH_SIZE,
        isSending
    });
});

app.post('/api/send-to-contacts', async (req, res) => {
    if (!isReady) return res.status(400).json({ error: 'WhatsApp não está conectado' });
    if (isSending) return res.status(400).json({ error: 'Já existe um envio em andamento' });

    const { contactIds, message, delayMs } = req.body;
    const delay = Math.max(parseInt(delayMs) || DELAY_MS, 5000); // mínimo 5s

    if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem não fornecida' });
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
        return res.status(400).json({ error: 'Nenhum contato selecionado' });
    }

    const allContacts = loadContacts();
    const contacts = allContacts.filter(c => contactIds.includes(c.id));
    if (contacts.length === 0) return res.status(400).json({ error: 'Contatos não encontrados' });

    isSending = true;
    cancelSending = false;

    // Responder imediatamente para não deixar o request pendurado
    res.json({ success: true, message: 'Envio iniciado', total: contacts.length });

    io.emit('sending-started', { total: contacts.length, delay });

    const results = { sent: 0, failed: 0, total: contacts.length, details: [], cancelled: false };

    for (let i = 0; i < contacts.length; i++) {
        if (cancelSending) {
            results.cancelled = true;
            break;
        }

        const contact = contacts[i];
        const personalizedMessage = message.replace(/\{nome\}/gi, contact.name);

        try {
            const number = contact.number.toString().replace(/\D/g, '') + '@c.us';
            const chat = await client.getChatById(number);
            await chat.sendMessage(personalizedMessage);

            results.sent++;
            results.details.push({ ...contact, status: 'sent' });
        } catch (error) {
            results.failed++;
            results.details.push({ ...contact, status: 'failed', error: error.message });
            console.error(`Erro ao enviar para ${contact.name}:`, error.message);
        }

        io.emit('progress', {
            current: i + 1,
            total: contacts.length,
            sent: results.sent,
            failed: results.failed,
            currentName: contact.name,
            cancelled: cancelSending
        });

        if (i < contacts.length - 1 && !cancelSending) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    isSending = false;
    io.emit('sending-complete', results);
});

app.post('/api/cancel-send', (req, res) => {
    if (isSending) {
        cancelSending = true;
        res.json({ success: true, message: 'Cancelamento solicitado' });
    } else {
        res.json({ success: false, message: 'Nenhum envio em andamento' });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        if (client && isReady) {
            await client.logout();
        }
        isReady = false;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
    console.log('Cliente conectado via Socket.IO');
    if (qrCodeData) socket.emit('qr', qrCodeData);
    if (isReady) socket.emit('ready', { message: 'WhatsApp já está conectado' });
    if (isSending) socket.emit('sending-in-progress');
    socket.on('disconnect', () => console.log('Cliente desconectado'));
});

server.listen(PORT, () => {
    console.log(`\n✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`⏱️  Delay configurado: ${DELAY_MS}ms`);
});
