require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jwt-simple');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mudraj_secret_key_123';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '821921990770-822776a7seho4i8les9lbqjsnut2lv23.apps.googleusercontent.com';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// الاتصال بقاعدة البيانات PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// إنشاء الجداول في حال عدم وجودها
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        username VARCHAR(50) UNIQUE,
        password VARCHAR(255),
        google_id VARCHAR(255)
      );

      CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        score INTEGER DEFAULT 0,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE
      );
    `);
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Database Init Error:", err);
  }
}
initDB();

// Middleware للتحقق من التوكن
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'غير مصرح لك، يرجى تسجيل الدخول' });

  try {
    const decoded = jwt.decode(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'الجلسة انتهت، يرجى إعادة الدخول' });
  }
};

// 1. تسجيل عادي
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });

  try {
    const userExist = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم مأخوذ بالفعل' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (first_name, last_name, username, password) VALUES ($1, $2, $3, $4)',
      [firstName, lastName, username, hashedPassword]
    );

    res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك الدخول الآن' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. دخول عادي
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ success: false, message: 'المستخدم غير موجود' });

    const user = result.rows[0];
    const validPass = await bcrypt.compare(password, user.password || '');
    if (!validPass) return res.status(400).json({ success: false, message: 'كلمة المرور خاطئة' });

    const token = jwt.encode({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ success: true, token, user: { firstName: user.first_name, username: user.username } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. توثيق قوقل
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
    const email = payload['email'];
    const firstName = payload['given_name'] || 'معلم';
    const lastName = payload['family_name'] || '';
    const username = email.split('@')[0];

    let result = await pool.query('SELECT * FROM users WHERE google_id = $1 OR username = $2', [googleId, username]);
    let user;

    if (result.rows.length === 0) {
      const newUser = await pool.query(
        'INSERT INTO users (first_name, last_name, username, google_id) VALUES ($1, $2, $3, $4) RETURNING *',
        [firstName, lastName, username, googleId]
      );
      user = newUser.rows[0];
    } else {
      user = result.rows[0];
    }

    const jwtToken = jwt.encode({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ success: true, token: jwtToken, user: { firstName: user.first_name, username: user.username } });
  } catch (err) {
    res.status(401).json({ success: false, message: `فشل التوثيق عبر قوقل: ${err.message}` });
  }
});

// 4. جلب الفصول والطلاب
app.get('/api/classes', authenticateToken, async (req, res) => {
  try {
    const classesRes = await pool.query('SELECT * FROM classes WHERE user_id = $1 ORDER BY id DESC', [req.user.userId]);
    const classes = classesRes.rows;

    for (let cls of classes) {
      const studentsRes = await pool.query('SELECT * FROM students WHERE class_id = $1 ORDER BY id ASC', [cls.id]);
      cls.students = studentsRes.rows;
    }

    res.json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. إضافة فصل جديد
app.post('/api/classes', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'اسم الفصل مطلوب' });

  try {
    const newClass = await pool.query(
      'INSERT INTO classes (name, user_id) VALUES ($1, $2) RETURNING *',
      [name, req.user.userId]
    );
    res.json({ success: true, class: { ...newClass.rows[0], students: [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. إضافة طالب
app.post('/api/students', authenticateToken, async (req, res) => {
  const { classId, name } = req.body;
  if (!classId || !name) return res.status(400).json({ success: false, message: 'جميع البيانات مطلوبة' });

  try {
    const newStudent = await pool.query(
      'INSERT INTO students (name, class_id, score) VALUES ($1, $2, 0) RETURNING *',
      [name, classId]
    );
    res.json({ success: true, student: newStudent.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. تحديث درجات الطالب
app.post('/api/students/score', authenticateToken, async (req, res) => {
  const { studentId, points } = req.body;
  try {
    const updated = await pool.query(
      'UPDATE students SET score = score + $1 WHERE id = $2 RETURNING *',
      [points, studentId]
    );
    res.json({ success: true, student: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});