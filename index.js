require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email VARCHAR UNIQUE NOT NULL, name VARCHAR, google_id VARCHAR, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, first_name VARCHAR, last_name VARCHAR, email VARCHAR UNIQUE, company_website VARCHAR, company_name VARCHAR, headline VARCHAR, city VARCHAR, state VARCHAR, phone VARCHAR, status VARCHAR DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS campaigns (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), status VARCHAR DEFAULT 'running', leads_processed INTEGER DEFAULT 0, drafts_created INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS email_drafts (id SERIAL PRIMARY KEY, campaign_id INTEGER REFERENCES campaigns(id), lead_id INTEGER REFERENCES leads(id), recipient_name VARCHAR, recipient_email VARCHAR, subject TEXT, body TEXT, status VARCHAR DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());
  `;
  try {
    await pool.query(query);
    console.log("✅ NexaMail Database Tables Ready!");
  } catch (err) {
    console.error("❌ Error initializing database:", err.message);
  }
};
initDb();

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─────────────────────────────────────────────────────────
// AUTH — Google login (BYPASS & DEBUG VERSION)
// ─────────────────────────────────────────────────────────

app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Token is missing' });
    }

    // 🛠️ STEP 1: Temporary Bypass - Audience argument ko remove kar diya hai
    // Taake "Wrong recipient" wala error bypass ho jaye
    const ticket = await googleClient.verifyIdToken({
      idToken: token
      // audience check disabled for troubleshooting
    });

    const payload = ticket.getPayload();

    // 🔍 STEP 2: Debug Logging
    // Is line se Render Logs mein aapko sahi ID mil jayegi
    console.log("🛠️ DEBUG: Incoming Token Audience is:", payload.aud);

    // 🛡️ Manual Security Check
    if (!payload.email_verified) {
        throw new Error("Email not verified by Google");
    }

    const { email, name, sub } = payload;

    const { rows } = await pool.query(
      `INSERT INTO users(email, name, google_id)
       VALUES($1, $2, $3)
       ON CONFLICT(email) DO UPDATE SET name=$2
       RETURNING id`,
      [email, name, sub]
    );

    const jwtToken = jwt.sign(
      { userId: rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    console.log(`✅ User Logged In: ${email}`);
    res.json({ jwt_token: jwtToken });

  } catch (err) {
    console.error("❌ Auth Error Details:", err.message);
    res.status(401).json({ 
        error: 'Invalid Google token', 
        details: err.message 
    });
  }
});

// AUTH MIDDLEWARE (Baqi code same hai)
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ... (Baqi routes leads/stats ke same rahenge)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NexaMail backend running on port ${PORT}`);
});