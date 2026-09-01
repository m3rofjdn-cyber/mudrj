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
app.use(express.static(__dirname));

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
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS stars INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS corrects INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS wrongs INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS homeworks INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

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

app.listen(PORT, () => {
  console.log(`السيرفر شغال على المنفذ ${PORT}`);
});
