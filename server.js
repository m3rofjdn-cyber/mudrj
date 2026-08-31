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

// فحص وجود رابط قاعدة البيانات
if (!process.env.DATABASE_URL) {
  console.error("FATAL ERROR: DATABASE_URL is not defined in Environment Variables!");
  process.exit(1);
}

// الاتصال بـ PostgreSQL على Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// إنشاء الجدول في قاعدة البيانات لتخزين مستخدمي Google
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50),
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        google_id VARCHAR(255),
        is_verified BOOLEAN DEFAULT TRUE,
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

// 1. عرض الواجهة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. مسار التحقق وتسجيل الدخول بحساب Google
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, message: 'لم يتم استلام التوكن الخاص بجوجل.' });
  }

  try {
    // التحقق من صحة التوكن الصادر من سيرفرات جوجل
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { sub: googleId, email, given_name: firstName, family_name: lastName } = payload;

    // البحث عن المستخدم في قاعدة البيانات
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;

    if (result.rows.length === 0) {
      // إنشاء حساب جديد للمستخدم في أول عملية دخول
      const username = email.split('@')[0] + '_' + Math.floor(Math.random() * 1000);
      const newUser = await pool.query(
        `INSERT INTO users (first_name, last_name, username, email, google_id, is_verified) 
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
        [firstName || 'User', lastName || '', username, email, googleId]
      );
      user = newUser.rows[0];
    } else {
      user = result.rows[0];
    }

    // توليد JWT Token لتثبيت الجلسة للمستخدم
    const jwtToken = jwt.sign(
      { userId: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح عبر Google',
      token: jwtToken,
      user: {
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email
      }
    });

  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(401).json({ success: false, message: 'فشل تفعيل الجلسة بواسطة Google.' });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});