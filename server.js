require('dotenv').config();
const express    = require('express');
const http       = require('http');
const socketIO   = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Хранилища (в памяти) ──
const pendingOTPs = new Map();
const sessions    = new Map();
const admins      = new Map();
const otpThrottle = new Map();

// ── Отправка через Brevo API ──
async function sendOtpEmail(email, otp) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender:  { name: 'KiriPilot', email: 'no-reply@kiripilot.ru' },
      to:      [{ email }],
      subject: `${otp} — код входа KiriPilot`,
      htmlContent: buildOtpEmailHtml(otp),
      textContent: `Код: ${otp} (действителен 10 мин)`,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo API error: ${res.status} ${err}`);
  }
}

function buildOtpEmailHtml(otp) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#07080f;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#07080f;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
  style="background:#0e1021;border-radius:16px;overflow:hidden;border:1px solid rgba(79,142,247,0.2);">
<tr><td style="padding:36px 40px 24px;border-bottom:1px solid rgba(79,142,247,0.15);">
  <div style="font-size:26px;font-weight:700;background:linear-gradient(135deg,#4f8ef7,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:inline-block;">KiriPilot</div>
</td></tr>
<tr><td style="padding:36px 40px;">
  <p style="color:#e8eaf6;font-size:16px;line-height:1.6;margin:0 0 24px;">Код подтверждения для входа в чат поддержки:</p>
  <div style="text-align:center;margin:32px 0;">
    <div style="display:inline-block;background:rgba(79,142,247,0.08);border:1px solid rgba(79,142,247,0.35);border-radius:12px;padding:20px 48px;">
      <div style="color:#6b7280;font-size:11px;text-transform:uppercase;margin-bottom:10px;">Код</div>
      <div style="font-size:42px;font-weight:700;letter-spacing:0.18em;background:linear-gradient(135deg,#4f8ef7,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${otp}</div>
      <div style="color:#6b7280;font-size:12px;margin-top:10px;">Действителен 10 минут</div>
    </div>
  </div>
</td></tr>
<tr><td style="padding:24px 40px;border-top:1px solid rgba(79,142,247,0.15);">
  <p style="color:#6b7280;font-size:11px;margin:0;text-align:center;">© KiriPilot.ru</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/start',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'start.html')));
app.get('/kiri-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

function notifyAdminsUserOnline(sessionId, session) {
  io.to('admins').emit('admin:user-online', {
    sessionId,
    email: session.email,
    messageCount: session.messages.length,
  });
}

io.on('connection', (socket) => {

  // ── Запрос кода на почту ──
  socket.on('auth:request-otp', async ({ email } = {}) => {
    if (!email || !EMAIL_RE.test(email)) {
      return socket.emit('auth:error', { message: 'Некорректный email' });
    }
    const key = email.toLowerCase();

    const now    = Date.now();
    const recent = (otpThrottle.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= 3) {
      return socket.emit('auth:error', { message: 'Слишком много запросов. Попробуйте через 10 минут.' });
    }
    recent.push(now);
    otpThrottle.set(key, recent);

    const otp = String(crypto.randomInt(100000, 1000000));
    pendingOTPs.set(key, { code: otp, expires: now + 10 * 60 * 1000, attempts: 0 });

    try {
      await sendOtpEmail(key, otp);
      socket.emit('auth:otp-sent', { email: key });
    } catch (err) {
      console.error('Brevo API error:', err.message);
      pendingOTPs.delete(key);
      socket.emit('auth:error', { message: 'Не удалось отправить письмо. Попробуйте позже.' });
    }
  });

  // ── Проверка кода ──
  socket.on('auth:verify-otp', ({ email, code } = {}) => {
    const key     = email ? String(email).toLowerCase() : null;
    const pending = key && pendingOTPs.get(key);
    if (!pending) return socket.emit('auth:error', { message: 'Код не найден. Запросите новый.' });
    if (Date.now() > pending.expires) {
      pendingOTPs.delete(key);
      return socket.emit('auth:error', { message: 'Код истёк. Запросите новый.' });
    }
    pending.attempts += 1;
    if (pending.attempts > 5) {
      pendingOTPs.delete(key);
      return socket.emit('auth:error', { message: 'Слишком много попыток. Запросите новый код.' });
    }
    if (pending.code !== String(code ?? '').trim()) {
      return socket.emit('auth:error', { message: 'Неверный код.' });
    }
    pendingOTPs.delete(key);

    let sessionId = null;
    for (const [id, s] of sessions.entries()) {
      if (s.email === key) { sessionId = id; s.socketId = socket.id; break; }
    }
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessions.set(sessionId, { email: key, socketId: socket.id, messages: [], createdAt: Date.now() });
    }

    socket.sessionId = sessionId;
    socket.userEmail = key;
    socket.join(`session:${sessionId}`);

    const session = sessions.get(sessionId);
    socket.emit('auth:success', { sessionId, email: key, history: session.messages });
    notifyAdminsUserOnline(sessionId, session);
  });

  // ── Возобновление сессии ──
  socket.on('session:resume', ({ sessionId } = {}) => {
    const session = sessionId && sessions.get(sessionId);
    if (!session) return socket.emit('session:invalid');
    session.socketId = socket.id;
    socket.sessionId = sessionId;
    socket.userEmail = session.email;
    socket.join(`session:${sessionId}`);
    socket.emit('session:resumed', { sessionId, email: session.email, history: session.messages });
    notifyAdminsUserOnline(sessionId, session);
  });

  // ── Сообщение от пользователя ──
  socket.on('user:message', ({ sessionId, text } = {}) => {
    if (!sessionId || !text?.trim()) return;
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:invalid');
    if (!socket.rooms.has(`session:${sessionId}`)) socket.join(`session:${sessionId}`);
    const message = {
      id:        crypto.randomUUID(),
      from:      'user',
      email:     session.email,
      text:      text.trim().slice(0, 4000),
      timestamp: Date.now(),
    };
    session.messages.push(message);
    socket.emit('chat:message', message);
    io.to('admins').emit('admin:message', { ...message, sessionId });
  });

  // ── Вход админа ──
  socket.on('admin:login', ({ token, name } = {}) => {
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return socket.emit('admin:auth-error', { message: 'Неверный токен' });
    }
    const adminName = (name?.trim() || 'Модератор').substring(0, 30);
    socket.join('admins');
    socket.isAdmin   = true;
    socket.adminName = adminName;
    admins.set(socket.id, { name: adminName });

    const activeSessions = [];
    for (const [id, s] of sessions.entries()) {
      activeSessions.push({
        sessionId:    id,
        email:        s.email,
        messageCount: s.messages.length,
        lastMessage:  s.messages.at(-1) || null,
        createdAt:    s.createdAt,
      });
    }
    socket.emit('admin:auth-success', { name: adminName, sessions: activeSessions });
    socket.to('admins').emit('admin:colleague-joined', { name: adminName });
  });

  // ── История для админа ──
  socket.on('admin:get-history', ({ sessionId } = {}) => {
    if (!socket.isAdmin) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    socket.emit('admin:history', { sessionId, email: session.email, messages: session.messages });
  });

  // ── Ответ админа ──
  socket.on('admin:reply', ({ sessionId, text } = {}) => {
    if (!socket.isAdmin || !text?.trim()) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const stored = {
      id:        crypto.randomUUID(),
      from:      'admin',
      adminName: socket.adminName,
      text:      text.trim().slice(0, 4000),
      timestamp: Date.now(),
    };
    session.messages.push(stored);
    io.to(`session:${sessionId}`).emit('chat:message', {
      id: stored.id, from: 'admin', isAdmin: true, text: stored.text, timestamp: stored.timestamp,
    });
    io.to('admins').emit('admin:message', { ...stored, sessionId });
  });

  socket.on('disconnect', () => {
    if (socket.isAdmin) {
      admins.delete(socket.id);
      socket.to('admins').emit('admin:colleague-left', { name: socket.adminName });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 KiriPilot запущен: http://localhost:${PORT}`);
  console.log(`   Чат поддержки:   http://localhost:${PORT}/start`);
  console.log(`   Админ-панель:    http://localhost:${PORT}/kiri-admin\n`);
});
