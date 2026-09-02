require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '821921990770-cf1p9jkm95hsi6cvr0tatjeo4ohgum9h.apps.googleusercontent.com';

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

    // ترحيل: يصلح جدول users لو كان موجود من قبل بشكل مختلف (مثلاً فيه عمود email إجباري وناقص google_id)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

    const emailColumn = await pool.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'email';
    `);
    if (emailColumn.rows.length > 0 && emailColumn.rows[0].is_nullable === 'NO') {
      await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL;`);
      console.log('تم إلغاء إجبارية عمود email القديم.');
    }

    const passwordColumn = await pool.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'password';
    `);
    if (passwordColumn.rows.length > 0 && passwordColumn.rows[0].is_nullable === 'NO') {
      await pool.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL;`);
      console.log('تم إلغاء إجبارية عمود password (لدعم دخول قوقل بدون كلمة مرور).');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        stage VARCHAR(20),
        grade SMALLINT,
        section SMALLINT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS stage VARCHAR(20);`);
    await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS grade SMALLINT;`);
    await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS section SMALLINT;`);
    await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

    const userIdColumn = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'classes' AND column_name = 'user_id';
    `);
    if (userIdColumn.rows.length === 0) {
      await pool.query(`ALTER TABLE classes ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
      console.log('تم إضافة عمود user_id الناقص لجدول classes.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        score INTEGER DEFAULT 0,
        stars INTEGER DEFAULT 0,
        corrects INTEGER DEFAULT 0,
        wrongs INTEGER DEFAULT 0,
        homeworks INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS stars INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS corrects INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS wrongs INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS homeworks INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

    const classIdColumn = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'students' AND column_name = 'class_id';
    `);
    if (classIdColumn.rows.length === 0) {
      await pool.query(`ALTER TABLE students ADD COLUMN class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE;`);
      console.log('تم إضافة عمود class_id الناقص لجدول students.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        status VARCHAR(10) NOT NULL,
        UNIQUE(student_id, date)
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
  const usernamePattern = /^[A-Za-z0-9_\u0600-\u06FF]{3,30}$/;
  if (!usernamePattern.test(username.trim())) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم يقبل بس حروف وأرقام و_ فقط، بدون مسافات أو رموز' });
  }
  if (!/^[A-Za-z0-9_\u0600-\u064A]{3,20}$/.test(username.trim())) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم يسمح فيه بس بحروف وأرقام و "_"، بدون مسافات أو رموز' });
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

// ===== أدوات مساعدة =====
const GRADE_NAMES = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'];
const STAGE_LABELS = { 'ابتدائي': 'ابتدائي', 'متوسط': 'متوسط', 'ثانوي': 'ثانوي' };
const STAGE_MAX_GRADE = { 'ابتدائي': 6, 'متوسط': 3, 'ثانوي': 3 };

function buildClassName(stage, grade, section) {
  const gradeName = GRADE_NAMES[grade - 1] || grade;
  return `${gradeName} ${STAGE_LABELS[stage] || stage} - شعبة ${section}`;
}

async function classBelongsToUser(classId, userId) {
  const result = await pool.query('SELECT id FROM classes WHERE id = $1 AND user_id = $2', [classId, userId]);
  return result.rows.length > 0;
}

const POINTS = { star: 3, correct: 1, wrong: -1, homework: 2 };
const COUNTER_COLUMN = { star: 'stars', correct: 'corrects', wrong: 'wrongs', homework: 'homeworks' };

// ===== الفصول =====
app.get('/api/classes', authenticateToken, async (req, res) => {
  try {
    const classesRes = await pool.query(
      'SELECT * FROM classes WHERE user_id = $1 ORDER BY stage, grade, section',
      [req.user.userId]
    );
    const classes = classesRes.rows;

    for (const cls of classes) {
      const studentsRes = await pool.query(
        'SELECT id, name, score FROM students WHERE class_id = $1 ORDER BY id ASC',
        [cls.id]
      );
      cls.students = studentsRes.rows;
      cls.studentCount = studentsRes.rows.length;
    }

    res.json({ success: true, classes });
  } catch (err) {
    console.error('خطأ بجلب الفصول:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

app.post('/api/classes', authenticateToken, async (req, res) => {
  const { stage, grade, section } = req.body;
  if (!stage || !grade || !section) {
    return res.status(400).json({ success: false, message: 'المرحلة والصف والشعبة مطلوبة' });
  }
  if (!STAGE_MAX_GRADE[stage]) {
    return res.status(400).json({ success: false, message: 'مرحلة غير صحيحة' });
  }
  if (grade < 1 || grade > STAGE_MAX_GRADE[stage]) {
    return res.status(400).json({ success: false, message: 'رقم الصف غير صحيح لهذي المرحلة' });
  }
  if (section < 1 || section > 8) {
    return res.status(400).json({ success: false, message: 'رقم الشعبة لازم يكون بين ١ و ٨' });
  }

  try {
    const name = buildClassName(stage, grade, section);
    const newClass = await pool.query(
      'INSERT INTO classes (name, stage, grade, section, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, stage, grade, section, req.user.userId]
    );
    res.json({ success: true, class: { ...newClass.rows[0], students: [], studentCount: 0 } });
  } catch (err) {
    console.error('خطأ بإنشاء فصل:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

app.delete('/api/classes/:id', authenticateToken, async (req, res) => {
  try {
    const owns = await classBelongsToUser(req.params.id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'هذا الفصل مو تابع لك' });

    await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

app.get('/api/classes/:id', authenticateToken, async (req, res) => {
  try {
    const owns = await classBelongsToUser(req.params.id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'هذا الفصل مو تابع لك' });

    const classRes = await pool.query('SELECT * FROM classes WHERE id = $1', [req.params.id]);
    const studentsRes = await pool.query(
      'SELECT * FROM students WHERE class_id = $1 ORDER BY name ASC',
      [req.params.id]
    );
    const cls = classRes.rows[0];
    cls.students = studentsRes.rows;
    res.json({ success: true, class: cls });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

// ===== الطلاب =====
app.post('/api/students', authenticateToken, async (req, res) => {
  const { classId, name } = req.body;
  if (!classId || !name) return res.status(400).json({ success: false, message: 'جميع البيانات مطلوبة' });

  try {
    const owns = await classBelongsToUser(classId, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'هذا الفصل مو تابع لك' });

    const newStudent = await pool.query(
      'INSERT INTO students (name, class_id, score) VALUES ($1, $2, 0) RETURNING *',
      [name.trim(), classId]
    );
    res.json({ success: true, student: newStudent.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

app.delete('/api/students/:id', authenticateToken, async (req, res) => {
  try {
    const studentRes = await pool.query('SELECT class_id FROM students WHERE id = $1', [req.params.id]);
    if (studentRes.rows.length === 0) return res.status(404).json({ success: false, message: 'الطالب غير موجود' });

    const owns = await classBelongsToUser(studentRes.rows[0].class_id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'غير مصرح' });

    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

// ===== التقييم (نجمة / صح / خطأ / واجب) =====
app.post('/api/students/:id/rate', authenticateToken, async (req, res) => {
  const { type } = req.body;
  if (!POINTS.hasOwnProperty(type)) {
    return res.status(400).json({ success: false, message: 'نوع تقييم غير معروف' });
  }

  try {
    const studentRes = await pool.query('SELECT class_id FROM students WHERE id = $1', [req.params.id]);
    if (studentRes.rows.length === 0) return res.status(404).json({ success: false, message: 'الطالب غير موجود' });

    const owns = await classBelongsToUser(studentRes.rows[0].class_id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'غير مصرح' });

    const column = COUNTER_COLUMN[type];
    const updated = await pool.query(
      `UPDATE students SET score = score + $1, ${column} = ${column} + 1 WHERE id = $2 RETURNING *`,
      [POINTS[type], req.params.id]
    );
    res.json({ success: true, student: updated.rows[0] });
  } catch (err) {
    console.error('خطأ بالتقييم:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

// ===== سحب وسام (عكس التقييم) =====
app.post('/api/students/:id/unrate', authenticateToken, async (req, res) => {
  const { type } = req.body;
  if (!POINTS.hasOwnProperty(type)) {
    return res.status(400).json({ success: false, message: 'نوع تقييم غير معروف' });
  }

  try {
    const studentRes = await pool.query('SELECT class_id FROM students WHERE id = $1', [req.params.id]);
    if (studentRes.rows.length === 0) return res.status(404).json({ success: false, message: 'الطالب غير موجود' });

    const owns = await classBelongsToUser(studentRes.rows[0].class_id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'غير مصرح' });

    const column = COUNTER_COLUMN[type];
    const updated = await pool.query(
      `UPDATE students SET score = score - $1, ${column} = GREATEST(${column} - 1, 0) WHERE id = $2 RETURNING *`,
      [POINTS[type], req.params.id]
    );
    res.json({ success: true, student: updated.rows[0] });
  } catch (err) {
    console.error('خطأ بسحب الوسام:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

// ===== الترتيب العام (كل فصول المعلم) =====
app.get('/api/leaderboard', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.name, s.score, c.name AS class_name
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE c.user_id = $1
      ORDER BY s.score DESC
      LIMIT 50
    `, [req.user.userId]);
    res.json({ success: true, leaderboard: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

// ===== التحضير =====
app.get('/api/classes/:id/attendance', authenticateToken, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ success: false, message: 'التاريخ مطلوب' });

  try {
    const owns = await classBelongsToUser(req.params.id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'غير مصرح' });

    const result = await pool.query(
      'SELECT student_id, status FROM attendance WHERE class_id = $1 AND date = $2',
      [req.params.id, date]
    );
    res.json({ success: true, records: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

app.post('/api/classes/:id/attendance', authenticateToken, async (req, res) => {
  const { date, records } = req.body;
  if (!date || !Array.isArray(records)) {
    return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
  }

  try {
    const owns = await classBelongsToUser(req.params.id, req.user.userId);
    if (!owns) return res.status(403).json({ success: false, message: 'غير مصرح' });

    for (const rec of records) {
      await pool.query(
        `INSERT INTO attendance (student_id, class_id, date, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (student_id, date) DO UPDATE SET status = $4`,
        [rec.studentId, req.params.id, date, rec.status]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('خطأ بحفظ التحضير:', err.message);
    res.status(500).json({ success: false, message: 'خطأ بالسيرفر' });
  }
});

// ===== استيراد من نور: تحليل الملف (بدون حفظ) =====
function looksLikeArabicName(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (trimmed.length < 4) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return false;
  const arabicRatio = (trimmed.match(/[\u0600-\u06FF]/g) || []).length / trimmed.length;
  return arabicRatio > 0.6;
}

function parseExcelBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const results = [];

  wb.SheetNames.forEach(sheetName => {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    if (rows.length < 2) return;

    const headerRow = rows[0].map(h => (typeof h === 'string' ? h : ''));
    let nameColIndex = headerRow.findIndex(h => /اسم/.test(h));

    if (nameColIndex === -1) {
      let bestScore = -1;
      for (let c = 0; c < Math.max(headerRow.length, 5); c++) {
        let score = 0;
        for (let r = 1; r < rows.length; r++) {
          if (looksLikeArabicName(rows[r][c])) score++;
        }
        if (score > bestScore) { bestScore = score; nameColIndex = c; }
      }
    }

    const names = [...new Set(
      rows.slice(1)
        .map(r => (r[nameColIndex] || '').toString().trim())
        .filter(v => v.length > 1)
    )];

    if (names.length > 0) {
      results.push({ suggestedClassName: sheetName, students: names });
    }
  });

  return results;
}

function parsePdfText(text) {
  // نستخرج الأسطر اللي تبدو أسماء عربية كاملة (كلمتين فأكثر) كتخمين أولي
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const names = [...new Set(lines.filter(looksLikeArabicName))];
  return [{ suggestedClassName: 'من ملف PDF (راجع القائمة)', students: names }];
}

app.post('/api/import/parse', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'ما فيه ملف مرفوع' });

  try {
    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    let groups = [];

    if (ext === 'xlsx' || ext === 'xls') {
      groups = parseExcelBuffer(req.file.buffer);
    } else if (ext === 'pdf') {
      const data = await pdfParse(req.file.buffer);
      groups = parsePdfText(data.text);
    } else {
      return res.status(400).json({ success: false, message: 'الصيغة المدعومة: Excel (.xlsx) أو PDF فقط' });
    }

    if (groups.length === 0 || groups.every(g => g.students.length === 0)) {
      return res.status(400).json({ success: false, message: 'ما قدرت ألقى أسماء طلاب واضحة بالملف، جرّب تصدير الملف بصيغة ثانية من نور أو أضف الطلاب يدويًا' });
    }

    res.json({ success: true, groups });
  } catch (err) {
    console.error('خطأ بتحليل ملف نور:', err.message);
    res.status(500).json({ success: false, message: 'تعذر قراءة الملف، تأكد إنه مو تالف' });
  }
});

// ===== استيراد من نور: التأكيد والحفظ الفعلي بقاعدة البيانات =====
app.post('/api/import/confirm', authenticateToken, async (req, res) => {
  const { classes } = req.body;
  if (!Array.isArray(classes) || classes.length === 0) {
    return res.status(400).json({ success: false, message: 'ما فيه بيانات للاستيراد' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let importedClasses = 0, importedStudents = 0;

    for (const cls of classes) {
      const name = (cls.name || '').trim();
      const students = Array.isArray(cls.students) ? cls.students.map(s => s.trim()).filter(Boolean) : [];
      if (!name || students.length === 0) continue;

      const newClass = await client.query(
        'INSERT INTO classes (name, stage, grade, section, user_id) VALUES ($1, NULL, NULL, NULL, $2) RETURNING id',
        [name, req.user.userId]
      );
      const classId = newClass.rows[0].id;
      importedClasses++;

      for (const studentName of students) {
        await client.query(
          'INSERT INTO students (name, class_id, score) VALUES ($1, $2, 0)',
          [studentName, classId]
        );
        importedStudents++;
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, importedClasses, importedStudents });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('خطأ بحفظ الاستيراد:', err.message);
    res.status(500).json({ success: false, message: 'تعذر حفظ البيانات' });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log(`السيرفر شغال على المنفذ ${PORT}`);
});
