require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'modaraj_secret_key_123';
const GOOGLE_CLIENT_ID = '821921990770-822776a7seho4i8les9lbqjsnut2lv23.apps.googleusercontent.com';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

if (!process.env.DATABASE_URL) {
  console.error("FATAL ERROR: DATABASE_URL is not defined in Environment Variables!");
  process.exit(1);
}

// الاتصال بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// تهيئة الجدول
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50),
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255),
        google_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Database initialized successfully!");
  } catch (err) {
    console.error("Database connection error:", err.message);
  }
};
initDb();

// ------------------- المسارات (Routes) -------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. تسجيل الدخول عبر Google
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'التوكن مطلوب' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { sub: googleId, email, given_name: firstName, family_name: lastName } = payload;

    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;

    if (result.rows.length === 0) {
      const username = email.split('@')[0] + '_' + Math.floor(Math.random() * 1000);
      const newUser = await pool.query(
        `INSERT INTO users (first_name, last_name, username, email, google_id) 
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [firstName || 'User', lastName || '', username, email, googleId]
      );
      user = newUser.rows[0];
    } else {
      user = result.rows[0];
    }

    const jwtToken = jwt.sign(
      { userId: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح عبر Google',
      token: jwtToken,
      user: { firstName: user.first_name, lastName: user.last_name, email: user.email }
    });

  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(401).json({ success: false, message: 'فشل التوثيق من Google.' });
  }
});

// 2. إنشاء حساب عادي
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, username, email, password } = req.body;

  if (!firstName || !lastName || !username || !email || !password) {
    return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة.' });
  }

  try {
    const checkUser = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'اسم الحساب أو البريد الإلكتروني مُسجل مسبقاً.' });
    }

    await pool.query(
      `INSERT INTO users (first_name, last_name, username, email, password) 
       VALUES ($1, $2, $3, $4, $5)`,
      [firstName, lastName, username, email, password]
    );

    res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك الآن تسجيل الدخول.' });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم.' });
  }
});

// 3. تسجيل الدخول العادي
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال البيانات كاملة.' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE (email = $1 OR username = $1) AND password = $2',
      [identifier, password]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });
    }

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: { username: user.username, firstName: user.first_name, email: user.email }
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تسجيل الدخول.' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));