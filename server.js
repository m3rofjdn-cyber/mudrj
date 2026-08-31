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

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

if (!process.env.DATABASE_URL) {
  console.error("FATAL ERROR: DATABASE_URL is not defined!");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50),
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255),
        google_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY,
        teacher_id INT REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        class_id INT REFERENCES classes(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Database initialized successfully!");
  } catch (err) {
    console.error("Database initialization error:", err.message);
  }
};
initDb();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'غير مصرح.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'الجلسة انتهت، أعد تسجيل الدخول.' });
    req.user = user;
    next();
  });
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Google Auth API
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'التوكن مطلوب' });

  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email, given_name: firstName, family_name: lastName } = payload;
    const username = email.split('@')[0];

    let result = await pool.query('SELECT * FROM users WHERE username = $1 OR google_id = $2', [username, googleId]);
    let user;

    if (result.rows.length === 0) {
      const newUser = await pool.query(
        `INSERT INTO users (first_name, last_name, username, google_id) VALUES ($1, $2, $3, $4) RETURNING *`,
        [firstName || 'User', lastName || '', username, googleId]
      );
      user = newUser.rows[0];
    } else {
      user = result.rows[0];
    }

    const jwtToken = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token: jwtToken, user: { firstName: user.first_name, username: user.username } });
  } catch (err) {
    res.status(401).json({ success: false, message: 'فشل التوثيق عبر Google.' });
  }
});

// التسجيل والدخول
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, username, password } = req.body;
  if (!firstName || !lastName || !username || !password) return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة.' });

  try {
    const checkUser = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (checkUser.rows.length > 0) return res.status(400).json({ success: false, message: 'اسم المستخدم مسجل مسبقاً.' });

    await pool.query(`INSERT INTO users (first_name, last_name, username, password) VALUES ($1, $2, $3, $4)`, [firstName, lastName, username, password]);
    res.json({ success: true, message: 'تم إنشاء الحساب بنجاح!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'يرجى إدخال البيانات.' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
    if (result.rows.length === 0) return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { username: user.username, firstName: user.first_name } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تسجيل الدخول.' });
  }
});

// إدارة الفصول والطلاب
app.get('/api/classes', authenticateToken, async (req, res) => {
  try {
    const classesRes = await pool.query('SELECT * FROM classes WHERE teacher_id = $1 ORDER BY id DESC', [req.user.userId]);
    const classes = await Promise.all(classesRes.rows.map(async (cls) => {
      const studentsRes = await pool.query('SELECT * FROM students WHERE class_id = $1 ORDER BY score DESC, id ASC', [cls.id]);
      return { ...cls, students: studentsRes.rows };
    }));
    res.json({ success: true, classes });
  } catch (err) { res.status(500).json({ success: false, message: 'خطأ أثناء جلب البيانات.' }); }
});

app.post('/api/classes', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'اسم الفصل مطلوب.' });

  try {
    const newClass = await pool.query('INSERT INTO classes (teacher_id, name) VALUES ($1, $2) RETURNING *', [req.user.userId, name]);
    res.json({ success: true, class: newClass.rows[0] });
  } catch (err) { 
    res.status(500).json({ success: false, message: 'خطأ أثناء إضافة الفصل.' }); 
  }
});

app.post('/api/students', authenticateToken, async (req, res) => {
  const { classId, name } = req.body;
  if (!classId || !name) return res.status(400).json({ success: false, message: 'بيانات غير مكتملة.' });

  try {
    const newStudent = await pool.query('INSERT INTO students (class_id, name, score) VALUES ($1, $2, 0) RETURNING *', [classId, name]);
    res.json({ success: true, student: newStudent.rows[0] });
  } catch (err) { 
    res.status(500).json({ success: false, message: 'خطأ أثناء إضافة الطالب.' }); 
  }
});

app.post('/api/students/score', authenticateToken, async (req, res) => {
  const { studentId, points } = req.body;
  if (!studentId || points === undefined) return res.status(400).json({ success: false, message: 'البيانات غير مكتملة.' });

  try {
    const updated = await pool.query('UPDATE students SET score = score + $1 WHERE id = $2 RETURNING *', [points, studentId]);
    res.json({ success: true, student: updated.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: 'خطأ تحديث الدرجة.' }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));