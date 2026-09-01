# مُدرَج — تسجيل الدخول

## التشغيل محليًا
```
npm install
cp .env.example .env
# عدّل .env: حط DATABASE_URL و JWT_SECRET
npm start
```
افتح `http://localhost:3000`

## النشر على Render
1. ارفع هذي الملفات لمستودع GitHub.
2. أنشئ **Web Service** جديد على Render واربطه بالمستودع.
3. Build Command: `npm install` — Start Command: `npm start`
4. من تبويب **Environment** بالخدمة، أضف:
   - `DATABASE_URL` = رابط قاعدة بيانات PostgreSQL (أنشئها من Render أو أي مزوّد ثاني)
   - `JWT_SECRET` = قيمة عشوائية طويلة (السيرفر يرفض يشتغل بدونها عمدًا)
   - `GOOGLE_CLIENT_ID` = (اختياري، فيه قيمة افتراضية مطابقة للواجهة أصلاً)
5. من [Google Cloud Console](https://console.cloud.google.com/auth/clients) لنفس الـ OAuth Client، تأكد إن رابط Render مضاف تحت **Authorized JavaScript origins** (مثال: `https://mudrj.onrender.com` بدون أي شيء بعده).

## البنية
- `public/index.html` — صفحة تسجيل الدخول / إنشاء حساب (اسم مستخدم فقط، بدون بريد إلكتروني) + زر Google
- `public/dashboard.html` — صفحة ترحيب بسيطة بعد الدخول، تتأكد إن الجلسة (JWT) شغالة فعليًا
- `server.js` — كل نقاط النهاية: `/api/register`, `/api/login`, `/api/auth/google`, `/api/me`

## ملاحظة أمنية
غيّرت الكود عشان **JWT_SECRET ما يكون له قيمة افتراضية بالكود** — لازم تحطه بمتغيرات البيئة، وإلا السيرفر يرفض يشتغل. هذا يمنع مشكلة أمنية كانت موجودة بالنسخة القديمة (سر معروف مكتوب صراحة بالكود).
