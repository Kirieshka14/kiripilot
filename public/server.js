/**
 * KiriPilot — Real-time Support Chat Server
 * Node.js + Express + Socket.io + Nodemailer
 *
 * Запуск: node server.js
 * Требует: .env с переменными SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_TOKEN, PORT
 */

require('dotenv').config();
const express   = require('express');
const http      = require('http');
const socketIO  = require('socket.io');
const nodemailer = require('nodemailer');
const path      = require('path');
const crypto    = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─────────────────────────────────────────────
// Хранилище в памяти (без базы данных)
// ─────────────────────────────────────────────

// Ожидающие OTP-коды: { email → { code, expires } }
const pendingOTPs = new Map();

// Активные сессии пользователей: { sessionId → { email, socketId, messages[] } }
const sessions = new Map();

// Список подключённых админов: { socketId → { name } }
const admins = new Map();

// ─────────────────────────────────────────────
// Настройка Nodemailer (SMTP из .env)
// ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true для 465, false для других портов
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Генерирует HTML-шаблон письма с OTP-кодом в тёмном стиле KiriPilot
 */
function buildOtpEmailHtml(otp) {
  return `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>KiriPilot — Код подтверждения</title>
</head>
<body style="margin:0;padding:0;background:#07080f;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07080f;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0"
               style="background:#0e1021;border-radius:16px;overflow:hidden;
                      border:1px solid rgba(79,142,247,0.2);
                      box-shadow:0 0 40px rgba(79,142,247,0.1);">

          <!-- Шапка -->
          <tr>
            <td style="padding:36px 40px 24px;border-bottom:1px solid rgba(79,142,247,0.15);">
              <div style="font-size:26px;font-weight:700;letter-spacing:-0.03em;
                          background:linear-gradient(135deg,#4f8ef7,#a78bfa);
                          -webkit-background-clip:text;-webkit-text-fill-color:transparent;
                          display:inline-block;">
                KiriPilot
              </div>
              <div style="color:#6b7280;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-top:4px;">
                Navigate your potential
              </div>
            </td>
          </tr>

          <!-- Тело -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="color:#e8eaf6;font-size:16px;line-height:1.6;margin:0 0 24px;">
                Привет! Вы запросили доступ к чату поддержки KiriPilot.<br/>
                Используйте код ниже для подтверждения вашего Email.
              </p>

              <!-- Код -->
              <div style="text-align:center;margin:32px 0;">
                <div style="display:inline-block;background:rgba(79,142,247,0.08);
                            border:1px solid rgba(79,142,247,0.35);border-radius:12px;
                            padding:20px 48px;">
                  <div style="color:#6b7280;font-size:11px;letter-spacing:0.12em;
                               text-transform:uppercase;margin-bottom:10px;">
                    Код подтверждения
                  </div>
                  <div style="font-size:42px;font-weight:700;letter-spacing:0.18em;
                               background:linear-gradient(135deg,#4f8ef7,#a78bfa);
                               -webkit-background-clip:text;-webkit-text-fill-color:transparent;">
                    ${otp}
                  </div>
                  <div style="color:#6b7280;font-size:12px;margin-top:10px;">
                    Действителен 10 минут
                  </div>
                </div>
              </div>

              <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0;">
                Если вы не запрашивали этот код — просто проигнорируйте письмо.<br/>
                Никто другой не сможет войти без этого кода.
              </p>
            </td>
          </tr>

          <!-- Подвал с No-Reply -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid rgba(79,142,247,0.15);
                        background:rgba(7,8,15,0.5);">
              <div style="background:rgba(247,179,79,0.08);border:1px solid rgba(247,179,79,0.25);
                          border-radius:8px;padding:14px 18px;margin-bottom:16px;">
                <p style="color:#f7b34f;font-size:13px;line-height:1.5;margin:0;">
                  ⚠️ Это автоматическое письмо, пожалуйста, не отвечайте на него (No-Reply).<br/>
                  По всем вопросам и предложениям пишите на нашу официальную почту:&nbsp;
                  <a href="mailto:KiriSupport@proton.me"
                     style="color:#4f8ef7;text-decoration:none;font-weight:600;">
                    KiriSupport@proton.me
                  </a>
                </p>
              </div>
              <p style="color:#6b7280;font-size:11px;margin:0;text-align:center;letter-spacing:0.06em;">
                © KiriPilot.com — Coming Soon
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Отправляет OTP-код на указанный email
 */
async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from:    `"KiriPilot Поддержка" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `${otp} — ваш код входа в KiriPilot`,
    html:    buildOtpEmailHtml(otp),
    // Текстовая версия на случай, если HTML не отображается
    text:    `Ваш код подтверждения KiriPilot: ${otp}\n\nДействителен 10 минут.\n\n⚠️ Не отвечайте на это письмо. По вопросам: KiriSupport@proton.me`,
  });
}

// ─────────────────────────────────────────────
// HTTP-маршруты (статические файлы)
// ─────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Главная страница сайта
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Скрытая страница админ-панели
app.get('/kiri-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─────────────────────────────────────────────
// Socket.io — обработка событий
// ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Подключён: ${socket.id}`);

  // ── АВТОРИЗАЦИЯ ПОЛЬЗОВАТЕЛЯ ──────────────────

  /**
   * Шаг 1: Пользователь вводит email → генерируем и отправляем OTP
   * Принимает: { email: string }
   * Отправляет: 'otp:sent' | 'otp:error'
   */
  socket.on('auth:request-otp', async ({ email }) => {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return socket.emit('auth:error', { message: 'Некорректный email' });
    }

    // Генерируем 6-значный код
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 10 * 60 * 1000; // 10 минут

    pendingOTPs.set(email.toLowerCase(), { code: otp, expires });

    try {
      await sendOtpEmail(email, otp);
      console.log(`[OTP] Отправлен код на ${email}`);
      socket.emit('auth:otp-sent', { email });
    } catch (err) {
      console.error('[OTP] Ошибка отправки:', err.message);
      socket.emit('auth:error', { message: 'Не удалось отправить письмо. Попробуйте позже.' });
    }
  });

  /**
   * Шаг 2: Пользователь вводит OTP-код → верифицируем и создаём сессию
   * Принимает: { email: string, code: string }
   * Отправляет: 'auth:success' | 'auth:error'
   */
  socket.on('auth:verify-otp', ({ email, code }) => {
    const normalEmail = email?.toLowerCase();
    const pending = pendingOTPs.get(normalEmail);

    if (!pending) {
      return socket.emit('auth:error', { message: 'Код не найден. Запросите новый.' });
    }
    if (Date.now() > pending.expires) {
      pendingOTPs.delete(normalEmail);
      return socket.emit('auth:error', { message: 'Код истёк. Запросите новый.' });
    }
    if (pending.code !== String(code).trim()) {
      return socket.emit('auth:error', { message: 'Неверный код. Попробуйте снова.' });
    }

    // Код верный — создаём или восстанавливаем сессию
    pendingOTPs.delete(normalEmail);

    // Ищем существующую сессию по email (если пользователь перезагрузил страницу)
    let sessionId = null;
    for (const [id, session] of sessions.entries()) {
      if (session.email === normalEmail) {
        sessionId = id;
        session.socketId = socket.id; // обновляем socket
        break;
      }
    }

    // Если сессии нет — создаём новую
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        email:    normalEmail,
        socketId: socket.id,
        messages: [],
        createdAt: Date.now(),
      });
    }

    socket.sessionId = sessionId;
    socket.userEmail = normalEmail;
    socket.join(`session:${sessionId}`); // Комната для этой сессии

    const session = sessions.get(sessionId);
    socket.emit('auth:success', {
      sessionId,
      email: normalEmail,
      history: session.messages, // Восстанавливаем историю сообщений
    });

    // Уведомляем всех админов о новом/активном пользователе
    io.to('admins').emit('admin:user-online', {
      sessionId,
      email: normalEmail,
      messageCount: session.messages.length,
    });

    console.log(`[Auth] Пользователь ${normalEmail} вошёл, сессия: ${sessionId}`);
  });

  // ── СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЯ ──────────────────

  /**
   * Пользователь отправляет сообщение
   * Принимает: { sessionId: string, text: string }
   */
  socket.on('user:message', ({ sessionId, text }) => {
    if (!sessionId || !text?.trim()) return;

    const session = sessions.get(sessionId);
    if (!session) return socket.emit('error', { message: 'Сессия не найдена' });

    const message = {
      id:        crypto.randomUUID(),
      from:      'user',
      email:     session.email,
      text:      text.trim(),
      timestamp: Date.now(),
    };

    session.messages.push(message);

    // Отправляем пользователю (эхо для подтверждения)
    socket.emit('chat:message', message);

    // Отправляем всем админам — с email пользователя для идентификации
    io.to('admins').emit('admin:message', { ...message, sessionId });

    console.log(`[Chat] ${session.email}: ${text.trim().substring(0, 60)}`);
  });

  // ── АВТОРИЗАЦИЯ АДМИНИСТРАТОРА ──────────────

  /**
   * Админ входит с токеном
   * Принимает: { token: string, name: string }
   * Отправляет: 'admin:auth-success' | 'admin:auth-error'
   */
  socket.on('admin:login', ({ token, name }) => {
    if (token !== process.env.ADMIN_TOKEN) {
      return socket.emit('admin:auth-error', { message: 'Неверный токен доступа' });
    }

    const adminName = (name?.trim() || `Модератор`).substring(0, 30);
    socket.join('admins');
    socket.isAdmin  = true;
    socket.adminName = adminName;
    admins.set(socket.id, { name: adminName });

    // Отправляем список всех активных сессий
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

    socket.emit('admin:auth-success', {
      name: adminName,
      sessions: activeSessions,
    });

    // Уведомляем других админов
    socket.to('admins').emit('admin:colleague-joined', { name: adminName });
    console.log(`[Admin] Вошёл администратор: ${adminName}`);
  });

  /**
   * Запрос истории конкретной сессии
   * Принимает: { sessionId: string }
   */
  socket.on('admin:get-history', ({ sessionId }) => {
    if (!socket.isAdmin) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    socket.emit('admin:history', {
      sessionId,
      email:    session.email,
      messages: session.messages,
    });
  });

  /**
   * Администратор отправляет ответ пользователю
   * Принимает: { sessionId: string, text: string }
   */
  socket.on('admin:reply', ({ sessionId, text }) => {
    if (!socket.isAdmin || !text?.trim()) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    // Сообщение для хранения в истории — с именем конкретного админа
    const storedMessage = {
      id:        crypto.randomUUID(),
      from:      'admin',
      adminName: socket.adminName, // имя видно только в истории (для других админов)
      text:      text.trim(),
      timestamp: Date.now(),
    };

    session.messages.push(storedMessage);

    // ── ПОЛНАЯ АНОНИМНОСТЬ: пользователь видит только "Поддержка KiriPilot" ──
    const messageForUser = {
      id:        storedMessage.id,
      from:      'admin',
      isAdmin:   true,             // системный флаг — никаких имён!
      text:      storedMessage.text,
      timestamp: storedMessage.timestamp,
    };

    // Отправляем пользователю без имени админа
    io.to(`session:${sessionId}`).emit('chat:message', messageForUser);

    // Отправляем всем админам — с именем отправителя (чтобы видели друг друга)
    io.to('admins').emit('admin:message', {
      ...storedMessage,
      sessionId,
    });

    console.log(`[Admin] ${socket.adminName} → ${session.email}: ${text.trim().substring(0, 60)}`);
  });

  // ── ОТКЛЮЧЕНИЕ ──────────────────────────────

  socket.on('disconnect', () => {
    if (socket.isAdmin) {
      admins.delete(socket.id);
      socket.to('admins').emit('admin:colleague-left', { name: socket.adminName });
      console.log(`[Admin] Отключился: ${socket.adminName}`);
    }
    console.log(`[Socket] Отключён: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────
// Запуск сервера
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 KiriPilot Support Server запущен на порту ${PORT}`);
  console.log(`   Виджет:     http://localhost:${PORT}`);
  console.log(`   Админ-панель: http://localhost:${PORT}/kiri-admin\n`);
});
