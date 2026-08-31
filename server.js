require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'modaraj_secret_key_123';

app.use(cors());
app.use(express.json());

// الاتصال بـ Postgres على Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// إنشاء الجدول تلقائياً
const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(50),
      last_name VARCHAR(50),
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      birth_date DATE,
      password VARCHAR(255) NOT NULL,
      otp_code VARCHAR(6),
      is_verified BOOLEAN DEFAULT FALSE
    );
  `);
};
initDb();

// 1. مسار إنشاء الحساب وتوليد الرمز
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, username, email, birthDate, password } = req.body;
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // رمز من 6 أرقام
    
    await pool.query(
      `INSERT INTO users (first_name, last_name, username, email, birth_date, password, otp_code) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [firstName, lastName, username, email, birthDate, password, otp]
    );

    // ملاحظة: هنا يتم دمج Nodemailer لإرسال الرمز للبريد
    console.log(`[OTP Sent to ${email}]: ${otp}`); 

    res.json({ success: true, message: 'تم إنشاء الحساب! ادخل رمز التحقق.', email });
  } catch (err) {
    res.status(400).json({ success: false, message: 'اسم الحساب أو البريد مستخدم بالفعل.' });
  }
});

// 2. مسار التحقق من الرمز OTP
app.post('/api/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1 AND otp_code = $2', [email, otp]);

  if (result.rows.length > 0) {
    await pool.query('UPDATE users SET is_verified = TRUE, otp_code = NULL WHERE email = $1', [email]);
    res.json({ success: true, message: 'تم تفعيل الحساب بنجاح!' });
  } else {
    res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح.' });
  }
});

// 3. مسار تسجيل الدخول
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  const result = await pool.query(
    'SELECT * FROM users WHERE (email = $1 OR username = $1) AND password = $2', 
    [identifier, password]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });
  }

  const user = result.rows[0];
  if (!user.is_verified) {
    return res.status(403).json({ success: false, message: 'يرجى تفعيل الحساب أولاً عبر رمز OTP.' });
  }

  // إنشاء Token للحفظ في المتصفح
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
  res.json({ success: true, message: 'نجحت في تسجيل الدخول', token, user: { username: user.username, firstName: user.first_name } });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));