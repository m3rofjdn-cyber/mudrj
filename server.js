require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'modaraj_secret_key_123';

// إعدادات البريد الإلكتروني
const EMAIL_USER = process.env.EMAIL_USER || 'your-email@gmail.com'; 
const EMAIL_PASS = process.env.EMAIL_PASS || 'xxxx xxxx xxxx xxxx'; 

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

// إعداد خدمة Nodemailer لإرسال الإيميلات
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

// إنشاء الجدول تلقائياً في قاعدة البيانات
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50) NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        birth_date DATE NOT NULL,
        password VARCHAR(255) NOT NULL,
        otp_code VARCHAR(6),
        is_verified BOOLEAN DEFAULT FALSE,
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

// 1. عرض واجهة المستخدم index.html عند فتح الرابط الرئيسي
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. مسار إنشاء الحساب وتوليد وإرسال الرمز OTP (معدّل للتعامل مع الحسابات غير المفعّلة)
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, username, email, birthDate, password } = req.body;

  if (!firstName || !lastName || !username || !email || !birthDate || !password) {
    return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة.' });
  }

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // التحقق هل الحساب أو الإيميل موجود مسبقاً
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];

      // إذا كان الحساب موجوداً ومفعّلاً بالفعل
      if (user.is_verified) {
        return res.status(400).json({ success: false, message: 'اسم الحساب أو البريد الإلكتروني مُسجل ومفعّل مسبقاً.' });
      }

      // إذا كان الحساب موجوداً ولكن غير مفعّل، يتم تحديث بياناته وإعادة إرسال الرمز الجديد
      await pool.query(
        `UPDATE users 
         SET first_name = $1, last_name = $2, username = $3, birth_date = $4, password = $5, otp_code = $6 
         WHERE email = $7 OR username = $3`,
        [firstName, lastName, username, birthDate, password, otp, email]
      );
    } else {
      // إدخال حساب جديد تماماً
      await pool.query(
        `INSERT INTO users (first_name, last_name, username, email, birth_date, password, otp_code) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [firstName, lastName, username, email, birthDate, password, otp]
      );
    }

    // تجهيز وإرسال الإيميل
    const mailOptions = {
      from: `"منصة مُدرج" <${EMAIL_USER}>`,
      to: email,
      subject: 'رمز التحقق الخاص بك - منصة مُدرج',
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 20px; background-color: #0f172a; color: #ffffff; border-radius: 12px;">
          <h2 style="color: #3b82f6; margin-bottom: 10px;">مرحباً بك في منصة مُدرج</h2>
          <p style="font-size: 14px; color: #cbd5e1;">رمز التحقق الخاص بتفعيل حسابك هو:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #10b981; background: #1e293b; padding: 15px; text-align: center; border-radius: 8px; margin: 20px 0;">
            ${otp}
          </div>
          <p style="color: #64748b; font-size: 12px;">إذا لم تقم بطلب هذا الرمز، يمكنك تجاهل هذه الرسالة بأمان.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`[OTP Email Sent Successfully to ${email}]`);

    res.json({ 
      success: true, 
      message: 'تم إرسال رمز التحقق إلى بريدك الإلكتروني بنجاح.', 
      email 
    });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء إنشاء الحساب.' });
  }
});

// 3. مسار التحقق من رمز OTP وتفعيل الحساب
app.post('/api/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'البريد الإلكتروني ورمز التحقق مطلوبان.' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND otp_code = $2',
      [email, otp]
    );

    if (result.rows.length > 0) {
      await pool.query(
        'UPDATE users SET is_verified = TRUE, otp_code = NULL WHERE email = $1',
        [email]
      );
      res.json({ success: true, message: 'تم تفعيل الحساب بنجاح! يمكنك الآن تسجيل الدخول.' });
    } else {
      res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح.' });
    }
  } catch (err) {
    console.error("Verify OTP Error:", err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء التأكد من الرمز.' });
  }
});

// 4. مسار تسجيل الدخول
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال اسم الحساب/البريد وكلمة المرور.' });
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

    if (!user.is_verified) {
      return res.status(403).json({ success: false, message: 'يرجى تفعيل الحساب أولاً بواسطة رمز التحقق.' });
    }

    // إنشاء JWT Token لتثبيت الجلسة
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'نجحت في تسجيل الدخول',
      token,
      user: {
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email
      }
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تسجيل الدخول.' });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});