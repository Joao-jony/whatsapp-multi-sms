const socket = io();

// ============ UTILS ============
function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show ' + type;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.className = 'toast', 3000);
}

function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Ontem';
    if (diffDays < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function getInitial(name) {
    return (name || '?').charAt(0).toUpperCase();
}

// ============ STATE ============
let allContacts = [];
let selectedContactIds = new Set();
let allMessages = [];
let activeMessageId = null;
let isConnected = false;
let sendSearchTerm = '';

// ============ NAVIGATION ============
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-section').forEach(s => s.style.display = 'none');
        document.getElementById(tab + 'Tab').style.display = 'block';

        if (tab === 'contacts') loadContacts();
        if (tab === 'send') { loadContacts(); renderSendList(); }
        if (tab === 'inbox') loadInbox();
    });
});

// ============ CONNECTION STATUS ============
function setStatus(state, text) {
    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const pill = document.getElementById('connStatusPill');

    dot.className = 'status-dot ' + state;
    statusText.textContent = text;
    if (pill) {
        pill.textContent = text;
        pill.className = 'status-pill ' + state;
    }
}

// ============ SOCKET EVENTS ============
socket.on('qr', (qrData) => {
    setStatus('connecting', 'Aguardando QR');
    document.getElementById('qrContainer').style.display = 'block';
    document.getElementById('qrImage').src = qrData;
    isConnected = false;
    document.getElementById('sendBtn').disabled = true;
});

socket.on('ready', () => {
    setStatus('connected', 'Conectado');
    document.getElementById('qrContainer').style.display = 'none';
    isConnected = true;
    document.getElementById('sendBtn').disabled = false;
    loadContacts();
    toast('WhatsApp conectado!', 'success');
});

socket.on('disconnected', () => {
    setStatus('disconnected', 'Desconectado');
    isConnected = false;
    document.getElementById('sendBtn').disabled = true;
});

socket.on('auth_failure', () => {
    setStatus('disconnected', 'Erro de autenticação');
    toast('Falha na autenticação', 'error');
});

socket.on('sending-started', (data) => {
    document.getElementById('sendBtn').style.display = 'none';
    document.getElementById('cancelBtn').style.display = 'flex';
    const card = document.getElementById('progressCard');
    card.style.display = 'block';
    document.getElementById('resultsCard').style.display = 'none';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressStats').innerHTML = `Iniciando envio para <strong>${data.total}</strong> contatos...`;
});

socket.on('progress', (data) => {
    const pct = Math.round((data.current / data.total) * 100);
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressStats').innerHTML = `
        <span>Progresso: <strong>${data.current}/${data.total}</strong></span>
        <span>✅ <strong>${data.sent}</strong> enviadas</span>
        <span>❌ <strong>${data.failed}</strong> falhas</span>
        ${data.currentName ? `<span>Atual: <strong>${data.currentName}</strong></span>` : ''}
    `;
});

socket.on('sending-complete', (results) => {
    document.getElementById('sendBtn').style.display = 'flex';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('progressCard').style.display = 'none';

    const card = document.getElementById('resultsCard');
    card.style.display = 'block';

    const sentSVG = `<svg class="result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    const failSVG = `<svg class="result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    let html = `<div class="results-summary">
        <div class="summary-stat neutral"><span class="val">${results.total}</span><span class="lbl">Total</span></div>
        <div class="summary-stat success"><span class="val">${results.sent}</span><span class="lbl">Enviadas</span></div>
        <div class="summary-stat danger"><span class="val">${results.failed}</span><span class="lbl">Falhas</span></div>
    </div>
    <div class="result-list">`;

    results.details.forEach(d => {
        html += `<div class="result-row ${d.status}">
            ${d.status === 'sent' ? sentSVG : failSVG}
            <span>${d.name}</span>
            <span style="color:var(--text-muted);font-size:0.75rem">${d.number}</span>
            ${d.error ? `<span class="err-msg">— ${d.error}</span>` : ''}
        </div>`;
    });

    html += '</div>';
    document.getElementById('resultsContent').innerHTML = html;

    if (results.cancelled) toast('Envio cancelado', 'error');
    else toast(`Enviado! ${results.sent} ok, ${results.failed} falhas`, results.failed > 0 ? 'error' : 'success');
});

socket.on('new_message', (msg) => {
    allMessages.unshift(msg);
    renderInbox();
    updateInboxBadge();
    toast(`Nova mensagem de ${msg.fromName}`);
});

// ============ CONTACTS ============
async function loadContacts() {
    try {
        const r = await fetch('/api/contacts');
        allContacts = await r.json();
        renderContactsList();
        if (document.getElementById('sendContactsList')) renderSendList();
    } catch (e) { console.error('Erro ao carregar contatos:', e); }
}

function renderContactsList() {
    const search = (document.getElementById('searchContacts')?.value || '').toLowerCase();
    const filtered = allContacts.filter(c =>
        c.name.toLowerCase().includes(search) || c.number.includes(search)
    );

    document.getElementById('contactsCount').textContent = `${allContacts.length} contato${allContacts.length !== 1 ? 's' : ''}`;
    const container = document.getElementById('contactsList');
    if (!container) return;

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            <p>${search ? 'Nenhum resultado para "' + search + '"' : 'Nenhum contato cadastrado'}</p>
            <span>${search ? 'Tente outro termo' : 'Adicione um contato ou importe um CSV'}</span>
        </div>`;
        return;
    }

    container.innerHTML = filtered.map(c => `
        <div class="contact-row" data-id="${c.id}">
            <input type="checkbox" class="contact-checkbox" value="${c.id}">
            <div class="avatar">${getInitial(c.name)}</div>
            <div class="contact-meta">
                <div class="contact-name">${c.name}</div>
                <div class="contact-details">
                    <span>+${c.number}</span>
                    <span class="group-tag">${c.group || 'Geral'}</span>
                </div>
            </div>
            <div class="row-actions">
                <button class="icon-btn edit-btn" data-id="${c.id}" title="Editar">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="icon-btn danger delete-btn" data-id="${c.id}" title="Excluir">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                </button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', () => openEditModal(b.dataset.id)));
    container.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', () => deleteContact(b.dataset.id)));
}

function renderSendList() {
    const search = (document.getElementById('searchSendContacts')?.value || '').toLowerCase();
    const filtered = allContacts.filter(c =>
        c.name.toLowerCase().includes(search) || c.number.includes(search)
    );
    const container = document.getElementById('sendContactsList');
    if (!container) return;

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state" style="padding:20px"><p>Nenhum contato</p></div>`;
    } else {
        container.innerHTML = filtered.map(c => `
            <div class="contact-row">
                <input type="checkbox" class="send-cb" value="${c.id}" ${selectedContactIds.has(c.id) ? 'checked' : ''}>
                <div class="avatar" style="width:28px;height:28px;font-size:0.75rem">${getInitial(c.name)}</div>
                <div class="contact-meta">
                    <div class="contact-name">${c.name}</div>
                    <div class="contact-details"><span>+${c.number}</span></div>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.send-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                if (e.target.checked) selectedContactIds.add(e.target.value);
                else selectedContactIds.delete(e.target.value);
                updateSelectionSummary();
            });
        });
    }
    updateSelectionSummary();
}

function updateSelectionSummary() {
    const el = document.getElementById('selectionSummary');
    if (el) el.textContent = `${selectedContactIds.size} contato${selectedContactIds.size !== 1 ? 's' : ''} selecionado${selectedContactIds.size !== 1 ? 's' : ''}`;
}

// Modal
function openAddModal() {
    document.getElementById('modalTitle').textContent = 'Novo Contato';
    document.getElementById('contactId').value = '';
    document.getElementById('contactName').value = '';
    document.getElementById('contactNumber').value = '';
    document.getElementById('contactModal').style.display = 'flex';
    document.getElementById('contactName').focus();
}

function openEditModal(id) {
    const c = allContacts.find(c => c.id === id);
    if (!c) return;
    document.getElementById('modalTitle').textContent = 'Editar Contato';
    document.getElementById('contactId').value = c.id;
    document.getElementById('contactName').value = c.name;
    document.getElementById('contactNumber').value = c.number.startsWith('244') ? c.number.slice(3) : c.number;
    document.getElementById('contactModal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('contactModal').style.display = 'none';
}

async function saveContact() {
    const id = document.getElementById('contactId').value;
    const name = document.getElementById('contactName').value.trim();
    const localNumber = document.getElementById('contactNumber').value.trim();
    const number = '244' + localNumber;

    if (!name || !localNumber) { toast('Preencha nome e número', 'error'); return; }

    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/contacts/${id}` : '/api/contacts';

    try {
        const r = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, number, group: 'Geral' })
        });
        const data = await r.json();
        if (r.ok) {
            closeModal();
            loadContacts();
            toast(id ? 'Contato atualizado' : 'Contato adicionado', 'success');
        } else {
            toast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        toast('Erro ao salvar contato', 'error');
    }
}

async function deleteContact(id) {
    if (!confirm('Excluir este contato?')) return;
    try {
        const r = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
        if (r.ok) {
            selectedContactIds.delete(id);
            loadContacts();
            toast('Contato excluído', 'success');
        }
    } catch (e) { toast('Erro ao excluir', 'error'); }
}

async function deleteSelected() {
    const cbs = document.querySelectorAll('.contact-checkbox:checked');
    const ids = Array.from(cbs).map(cb => cb.value);
    if (ids.length === 0) { toast('Selecione ao menos um contato', 'error'); return; }
    if (!confirm(`Excluir ${ids.length} contato(s)?`)) return;

    try {
        // CORREÇÃO: usando nova rota /bulk-delete
        const r = await fetch('/api/contacts/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        if (r.ok) {
            ids.forEach(id => selectedContactIds.delete(id));
            loadContacts();
            toast(`${ids.length} contato(s) excluído(s)`, 'success');
        }
    } catch (e) { toast('Erro ao excluir', 'error'); }
}

// ============ SEND ============
document.getElementById('sendBtn').addEventListener('click', async () => {
    if (selectedContactIds.size === 0) { toast('Selecione ao menos um contato', 'error'); return; }
    const msg = document.getElementById('message').value.trim();
    if (!msg) { toast('Digite uma mensagem', 'error'); return; }

    document.getElementById('sendBtn').disabled = true;

    try {
        const r = await fetch('/api/send-to-contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contactIds: Array.from(selectedContactIds),
                message: msg,
                delayMs: (parseInt(document.getElementById('delaySeconds').value) || 30) * 1000
            })
        });
        const data = await r.json();
        if (!r.ok) {
            toast('Erro: ' + data.error, 'error');
            document.getElementById('sendBtn').disabled = false;
        }
    } catch (e) {
        toast('Erro ao enviar', 'error');
        document.getElementById('sendBtn').disabled = false;
    }
});

document.getElementById('cancelBtn').addEventListener('click', async () => {
    await fetch('/api/cancel-send', { method: 'POST' });
    toast('Cancelamento solicitado');
});

// Char counter
document.getElementById('message').addEventListener('input', function() {
    document.getElementById('charCount').textContent = this.value.length + ' caracteres';
});

// Select all/none
document.getElementById('selectAllBtn')?.addEventListener('click', () => {
    allContacts.forEach(c => selectedContactIds.add(c.id));
    renderSendList();
});

document.getElementById('selectNoneBtn')?.addEventListener('click', () => {
    selectedContactIds.clear();
    renderSendList();
});

document.getElementById('searchSendContacts')?.addEventListener('input', renderSendList);

// ============ INBOX ============
async function loadInbox() {
    try {
        const r = await fetch('/api/messages');
        allMessages = await r.json();
        renderInbox();
        updateInboxBadge();
    } catch (e) { console.error('Erro ao carregar inbox:', e); }
}

function renderInbox() {
    const container = document.getElementById('inboxList');
    if (!container) return;

    const unread = allMessages.filter(m => !m.isRead).length;
    document.getElementById('inboxCount').textContent = `${allMessages.length} mensagem${allMessages.length !== 1 ? 's' : ''} • ${unread} não lida${unread !== 1 ? 's' : ''}`;

    if (allMessages.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>
            <p>Nenhuma mensagem recebida</p>
            <span>As mensagens aparecem aqui quando o WhatsApp estiver conectado</span>
        </div>`;
        return;
    }

    container.innerHTML = allMessages.map(m => `
        <div class="msg-row ${!m.isRead ? 'unread' : ''} ${m.id === activeMessageId ? 'active' : ''}" data-id="${m.id}">
            <div class="avatar">${getInitial(m.fromName)}</div>
            <div class="msg-body">
                <div class="msg-top">
                    <span class="msg-sender">${m.fromName}</span>
                    <span class="msg-time">${formatTime(m.timestamp)}</span>
                </div>
                <div class="msg-preview">${m.body}</div>
                <div class="msg-indicators">
                    ${!m.isRead ? '<span class="unread-dot"></span>' : ''}
                    ${m.replied ? '<span class="replied-tag">respondida</span>' : ''}
                </div>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.msg-row').forEach(row => {
        row.addEventListener('click', () => openReply(row.dataset.id));
    });
}

function updateInboxBadge() {
    const unread = allMessages.filter(m => !m.isRead).length;
    const badge = document.getElementById('inboxBadge');
    if (badge) {
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'inline-block' : 'none';
    }
}

async function openReply(msgId) {
    const msg = allMessages.find(m => m.id === msgId);
    if (!msg) return;

    activeMessageId = msgId;

    // Marcar como lida
    if (!msg.isRead) {
        await fetch(`/api/messages/${msgId}/read`, { method: 'POST' });
        msg.isRead = true;
        updateInboxBadge();
    }

    renderInbox();

    const replyPanel = document.getElementById('inboxReply');
    replyPanel.style.display = 'flex';

    document.getElementById('replyAvatar').textContent = getInitial(msg.fromName);
    document.getElementById('replyName').textContent = msg.fromName;
    document.getElementById('replyNumber').textContent = '+' + msg.from;

    document.getElementById('replyThread').innerHTML = `
        <div class="thread-msg received">
            <div>${msg.body}</div>
            <div class="msg-meta">${new Date(msg.timestamp).toLocaleString('pt-BR')}</div>
        </div>
    `;

    document.getElementById('replyMessage').value = '';
    document.getElementById('replyMessage').focus();

    // Store current msg in reply button
    document.getElementById('sendReplyBtn').dataset.to = msg.from;
    document.getElementById('sendReplyBtn').dataset.msgId = msgId;
}

document.getElementById('sendReplyBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('sendReplyBtn');
    const to = btn.dataset.to;
    const msgId = btn.dataset.msgId;
    const text = document.getElementById('replyMessage').value.trim();

    if (!text) { toast('Escreve uma mensagem', 'error'); return; }
    if (!isConnected) { toast('WhatsApp não está conectado', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
        const r = await fetch('/api/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, message: text, messageId: msgId })
        });
        const data = await r.json();

        if (r.ok) {
            // Adicionar ao thread
            const thread = document.getElementById('replyThread');
            const div = document.createElement('div');
            div.className = 'thread-msg sent-msg';
            div.innerHTML = `<div>${text}</div><div class="msg-meta">${new Date().toLocaleTimeString('pt-BR')}</div>`;
            thread.appendChild(div);
            thread.scrollTop = thread.scrollHeight;

            document.getElementById('replyMessage').value = '';

            // Marcar como respondida
            const msg = allMessages.find(m => m.id === msgId);
            if (msg) msg.replied = true;
            renderInbox();
            toast('Resposta enviada!', 'success');
        } else {
            toast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        toast('Erro ao enviar resposta', 'error');
    }

    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Responder`;
});

document.getElementById('closeReplyBtn')?.addEventListener('click', () => {
    document.getElementById('inboxReply').style.display = 'none';
    activeMessageId = null;
    renderInbox();
});

document.getElementById('markAllReadBtn')?.addEventListener('click', async () => {
    await fetch('/api/messages/mark-all-read', { method: 'POST' });
    allMessages.forEach(m => m.isRead = true);
    renderInbox();
    updateInboxBadge();
    toast('Todas marcadas como lidas', 'success');
});

document.getElementById('refreshInboxBtn')?.addEventListener('click', loadInbox);

// ============ CONFIG ============
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    if (!confirm('Desconectar WhatsApp?')) return;
    try {
        await fetch('/api/logout', { method: 'POST' });
        setStatus('disconnected', 'Desconectado');
        isConnected = false;
        document.getElementById('sendBtn').disabled = true;
        toast('WhatsApp desconectado', 'success');
    } catch (e) { toast('Erro ao desconectar', 'error'); }
});

// ============ CONTACTS EVENTS ============
document.getElementById('addContactBtn')?.addEventListener('click', openAddModal);
document.getElementById('saveContactBtn')?.addEventListener('click', saveContact);
document.getElementById('closeModalBtn')?.addEventListener('click', closeModal);
document.getElementById('closeModalBtn2')?.addEventListener('click', closeModal);
document.getElementById('deleteSelectedBtn')?.addEventListener('click', deleteSelected);
document.getElementById('searchContacts')?.addEventListener('input', renderContactsList);

// Enter to save in modal
document.getElementById('contactModal')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveContact();
    if (e.key === 'Escape') closeModal();
});

// Enter to reply
document.getElementById('replyMessage')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) document.getElementById('sendReplyBtn').click();
});

// ============ INIT ============
async function checkStatus() {
    try {
        const r = await fetch('/api/status');
        const data = await r.json();
        if (data.ready) {
            setStatus('connected', 'Conectado');
            isConnected = true;
            document.getElementById('sendBtn').disabled = false;
            loadContacts();
        } else if (data.qr) {
            setStatus('connecting', 'Aguardando QR');
            document.getElementById('qrContainer').style.display = 'block';
            document.getElementById('qrImage').src = data.qr;
        } else {
            setStatus('connecting', 'A iniciar...');
        }
        if (data.delay) document.getElementById('delaySeconds').value = data.delay / 1000;
    } catch (e) { console.error('Erro no checkStatus:', e); }
}

checkStatus();
