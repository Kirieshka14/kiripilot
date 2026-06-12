require('dotenv').config();
const express    = require('express');
const http       = require('http');
const socketIO   = require('socket.io');
const nodemailer = require('nodemailer');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const pendingOTPs = new Map();
const sessions    = new Map();
const admins      = new Map();

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

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
  <p style="color:#6b7280;font-size:11px;margin:0;text-align:center;">© KiriPilot.com</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from:    `"KiriPilot" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `${otp} — код входа KiriPilot`,
    html:    buildOtpEmailHtml(otp),
    text:    `Код: ${otp} (действителен 10 мин)`,
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/kiri-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

io.on('connection', (socket) => {

  socket.on('auth:request-otp', async ({ email }) => {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return socket.emit('auth:error', { message: 'Некорректный email' });
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    pendingOTPs.set(email.toLowerCase(), { code: otp, expires: Date.now() + 10*60*1000 });
    try {
      await sendOtpEmail(email, otp);
      socket.emit('auth:otp-sent', { email });
    } catch (err) {
      socket.emit('auth:error', { message: 'Не удалось отправить письмо.' });
    }
  });

  socket.on('auth:verify-otp', ({ email, code }) => {
    const normalEmail = email?.toLowerCase();
    const pending = pendingOTPs.get(normalEmail);
    if (!pending) return socket.emit('auth:error', { message: 'Код не найден. Запросите новый.' });
    if (Date.now() > pending.expires) { pendingOTPs.delete(normalEmail); return socket.emit('auth:error', { message: 'Код истёк.' }); }
    if (pending.code !== String(code).trim()) return socket.emit('auth:error', { message: 'Неверный код.' });
    pendingOTPs.delete(normalEmail);
    let sessionId = null;
    for (const [id, s] of sessions.entries()) {
      if (s.email === normalEmail) { sessionId = id; s.socketId = socket.id; break; }
    }
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessions.set(sessionId, { email: normalEmail, socketId: socket.id, messages: [], createdAt: Date.now() });
    }
    socket.sessionId = sessionId;
    socket.userEmail = normalEmail;
    socket.join(`session:${sessionId}`);
    const session = sessions.get(sessionId);
    socket.emit('auth:success', { sessionId, email: normalEmail, history: session.messages });
    io.to('admins').emit('admin:user-online', { sessionId, email: normalEmail, messageCount: session.messages.length });
  });

  socket.on('user:message', ({ sessionId, text }) => {
    if (!sessionId || !text?.trim()) return;
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('error', { message: 'Сессия не найдена' });
    const message = { id: crypto.randomUUID(), from: 'user', email: session.email, text: text.trim(), timestamp: Date.now() };
    session.messages.push(message);
    socket.emit('chat:message', message);
    io.to('admins').emit('admin:message', { ...message, sessionId });
  });

  socket.on('admin:login', ({ token, name }) => {
    if (token !== process.env.ADMIN_TOKEN) return socket.emit('admin:auth-error', { message: 'Неверный токен' });
    const adminName = (name?.trim() || 'Модератор').substring(0, 30);
    socket.join('admins');
    socket.isAdmin   = true;
    socket.adminName = adminName;
    admins.set(socket.id, { name: adminName });
    const activeSessions = [];
    for (const [id, s] of sessions.entries()) {
      activeSessions.push({ sessionId: id, email: s.email, messageCount: s.messages.length, lastMessage: s.messages.at(-1)||null, createdAt: s.createdAt });
    }
    socket.emit('admin:auth-success', { name: adminName, sessions: activeSessions });
    socket.to('admins').emit('admin:colleague-joined', { name: adminName });
  });

  socket.on('admin:get-history', ({ sessionId }) => {
    if (!socket.isAdmin) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    socket.emit('admin:history', { sessionId, email: session.email, messages: session.messages });
  });

  socket.on('admin:reply', ({ sessionId, text }) => {
    if (!socket.isAdmin || !text?.trim()) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const stored = { id: crypto.randomUUID(), from: 'admin', adminName: socket.adminName, text: text.trim(), timestamp: Date.now() };
    session.messages.push(stored);
    io.to(`session:${sessionId}`).emit('chat:message', { id: stored.id, from: 'admin', isAdmin: true, text: stored.text, timestamp: stored.timestamp });
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
  console.log(`   Админ-панель:    http://localhost:${PORT}/kiri-admin\n`);
});
