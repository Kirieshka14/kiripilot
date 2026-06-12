# KiriPilot — Real-time Support Chat

Полная система чата поддержки: Node.js бэкенд + виджет для сайта + панель администратора.

---

## 📁 Структура файлов

```
kiripilot-chat/
├── server.js              ← Бэкенд (Express + Socket.io + Nodemailer)
├── package.json           ← Зависимости
├── .env                   ← Секреты (не коммитить в Git!)
├── .gitignore
└── public/
    ├── index.html         ← Ваш существующий сайт (index_2.html)
    ├── widget.html        ← Виджет чата для встраивания на сайт
    └── admin.html         ← Панель администратора (/kiri-admin)
```

---

## ⚙️ Установка

### 1. Клонируйте / создайте папку

```bash
mkdir kiripilot-chat && cd kiripilot-chat
```

### 2. Скопируйте файлы из этого репозитория

- `server.js` → в корень
- `package.json` → в корень
- `public/widget.html` → в папку `public/`
- `public/admin.html` → в папку `public/`
- Ваш `index_2.html` → переименуйте в `public/index.html`

### 3. Установите зависимости

```bash
npm install
```

### 4. Создайте файл `.env`

```bash
cp .env.example .env
```

Заполните `.env`:

```env
# Порт сервера
PORT=3000

# SMTP настройки для Nodemailer
# Для Gmail: включите "Пароли приложений" в Google Account
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Для Proton Mail Bridge (локальный клиент):
# SMTP_HOST=127.0.0.1
# SMTP_PORT=1025
# SMTP_SECURE=false
# SMTP_USER=your@proton.me
# SMTP_PASS=bridge-password

# Секретный токен для входа в админ-панель
# Придумайте сложный пароль!
ADMIN_TOKEN=замените-на-сложный-секрет-здесь
```

### 5. Добавьте `.gitignore`

```
node_modules/
.env
```

### 6. Запустите сервер

```bash
npm start
# или для разработки (автоперезапуск):
npm run dev
```

---

## 🌐 Адреса

| Что | URL |
|-----|-----|
| Главная страница | `http://localhost:3000` |
| Виджет (отдельная страница) | `http://localhost:3000/widget.html` |
| Панель администратора | `http://localhost:3000/kiri-admin` |

---

## 📦 Встраивание виджета на сайт

Вместо того чтобы использовать `widget.html` как отдельную страницу, вставьте код виджета прямо в ваш `index.html`.

Добавьте перед `</body>`:

```html
<!-- Замените URL на адрес вашего бэкенда -->
<script src="https://ваш-бэкенд.com/socket.io/socket.io.js"></script>
<script>
  // Вставьте сюда весь JavaScript из widget.html (блок <script>)
  // и поменяйте BACKEND_URL = 'https://ваш-бэкенд.com'
</script>

<!-- Добавьте CSS виджета в <head> -->
<!-- Скопируйте блок <style> из widget.html -->
```

Или создайте отдельные файлы:
- `public/widget.css` — стили виджета
- `public/widget-bundle.js` — JS виджета

---

## 🚀 Деплой на GitHub + Railway / Render

### Railway (рекомендуется)

1. Загрузите проект на GitHub
2. Зайдите на [railway.app](https://railway.app)
3. "New Project" → "Deploy from GitHub repo"
4. В настройках добавьте переменные окружения из `.env`
5. Railway автоматически определит `npm start` как команду запуска

### Render

1. Загрузите на GitHub
2. Зайдите на [render.com](https://render.com)
3. "New Web Service" → выберите репозиторий
4. Build command: `npm install`
5. Start command: `node server.js`
6. Добавьте переменные окружения

### После деплоя

Обновите в `widget.html` и `admin.html`:
```javascript
const BACKEND_URL = 'https://ваш-домен.railway.app'; // ← реальный URL
```

И обновите строку подключения Socket.io:
```html
<script src="https://ваш-домен.railway.app/socket.io/socket.io.js"></script>
```

---

## 📧 Настройка SMTP

### Gmail
1. Включите двухфакторную аутентификацию
2. Перейдите: Google Account → Безопасность → Пароли приложений
3. Создайте пароль для "Другое (название по своему выбору)"
4. Используйте этот пароль в `SMTP_PASS`

### Любой другой SMTP-провайдер
Укажите `SMTP_HOST`, `SMTP_PORT` и данные вашей почты.

---

## 🔐 Безопасность

- `ADMIN_TOKEN` в `.env` — единственная защита панели. Используйте длинный случайный токен.
- Никогда не коммитьте `.env` в Git.
- Для продакшн-деплоя рекомендуется добавить rate limiting на `/auth:request-otp`.

---

## 🏗️ Архитектура

```
Пользователь                Бэкенд (Node.js)           Администратор
    │                            │                            │
    │──── auth:request-otp ────► │                            │
    │                            │──── sendMail (OTP) ──►    📧
    │◄─── auth:otp-sent ─────── │                            │
    │                            │                            │
    │──── auth:verify-otp ─────► │                            │
    │◄─── auth:success ─────── │                            │
    │                            │──── admin:user-online ──► │
    │                            │                            │
    │──── user:message ────────► │──── admin:message ──────► │
    │                            │                            │
    │◄─── chat:message ─────── │◄─── admin:reply ─────────  │
         (isAdmin:true,          │     (имя скрыто от юзера)  │
         "Поддержка KiriPilot")  │                            │
```

Полная анонимность администраторов обеспечена на уровне сервера: имена операторов **никогда** не попадают в сокет-события, адресованные пользователям.
