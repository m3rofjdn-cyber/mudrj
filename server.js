require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '821921990770-822776a7seho4i8les9lbqjsnut2lv23.apps.googleusercontent.com';

// لازم يكون JWT_SECRET موجود بمتغيرات البيئة — بدونه ما نشغل السيرفر
if (!JWT_SECRET) {
  console.error('خطأ فادح: متغير البيئة JWT_SECRET غير موجود. أضِفه بإعدادات Render (Environment) قبل التشغيل.');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255),
        google_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('تم تجهيز قاعدة البيانات بنجاح.');
  } catch (err) {
    console.error('خطأ بتجهيز قاعدة البيانات:', err.message);
  }
}
initDB();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'غير مصرح لك، يرجى تسجيل الدخول' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'الجلسة انتهت، يرجى إعادة الدخول' });
    req.user = decoded;
    next();
  });
};

// ===== إنشاء حساب (اسم مستخدم فقط، بدون بريد إلكتروني) =====
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, username, password } = req.body;

  if (!firstName || !username || !password) {
    return res.status(400).json({ success: false, message: 'الاسم الأول واسم المستخدم وكلمة المرور مطلوبة' });
  }
  if (username.trim().length < 3) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم لازم يكون ٣ أحرف على الأقل' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'كلمة المرور لازم تكون ٦ أحرف على الأقل' });
  }

  try {
    const userExist = await pool.query('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم مأخوذ بالفعل' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (first_name, last_name, username, password) VALUES ($1, $2, $3, $4)',
      [firstName.trim(), (lastName || '').trim(), username.trim(), hashedPassword]
    );

    res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك الدخول الآن' });
  } catch (err) {
    console.error('خطأ بإنشاء الحساب:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر، حاول مرة أخرى' });
  }
});

// ===== تسجيل الدخول (اسم مستخدم + كلمة مرور) =====
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبة' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const user = result.rows[0];
    if (!user.password) {
      return res.status(400).json({ success: false, message: 'هذا الحساب مسجل عبر قوقل، سجّل الدخول من زر قوقل' });
    }

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      user: { firstName: user.first_name, lastName: user.last_name, username: user.username }
    });
  } catch (err) {
    console.error('خطأ بتسجيل الدخول:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر، حاول مرة أخرى' });
  }
});

// ===== تسجيل الدخول بقوقل =====
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'التوكن مفقود' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload['sub'];
    const email = payload['email'] || '';
    const firstName = payload['given_name'] || 'مستخدم';
    const lastName = payload['family_name'] || '';
    const baseUsername = email ? email.split('@')[0] : 'user' + googleId.slice(-6);

    let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    let user;

    if (result.rows.length === 0) {
      // تأكد إن اسم المستخدم المشتق من الإيميل مو مستخدم، لو مستخدم أضف رقم
      let username = baseUsername;
      let suffix = 1;
      while ((await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows.length > 0) {
        username = baseUsername + suffix;
        suffix++;
      }

      const newUser = await pool.query(
        'INSERT INTO users (first_name, last_name, username, google_id) VALUES ($1, $2, $3, $4) RETURNING *',
        [firstName, lastName, username, googleId]
      );
      user = newUser.rows[0];
    } else {
      user = result.rows[0];
    }

    const jwtToken = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token: jwtToken,
      user: { firstName: user.first_name, lastName: user.last_name, username: user.username }
    });
  } catch (err) {
    console.error('خطأ بتوثيق قوقل:', err.message);
    res.status(401).json({ success: false, message: 'فشل التوثيق عبر قوقل: ' + err.message });
  }
});

// ===== نموذج لصفحة محمية للتأكد إن الجلسة شغالة =====
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, first_name, last_name, username FROM users WHERE id = $1', [req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

app.listen(PORT, () => {
  console.log(`السيرفر شغال على المنفذ ${PORT}`);
});
