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

// Connect to PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Render
});

// DATABASE INITIALIZATION
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
// AUTH — Google login (FIXED AUDIENCE)
// ─────────────────────────────────────────────────────────

app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;

    // ✅ FIX: Audience ko array bana diya hai taake Android aur Web dono IDs verify ho sakein
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: [
        process.env.GOOGLE_CLIENT_ID,      // Web Client ID
        process.env.ANDROID_CLIENT_ID      // Android Client ID
      ],
    });

    const { email, name, sub } = ticket.getPayload();

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

    res.json({ jwt_token: jwtToken });
  } catch (err) {
    console.error("Auth Error:", err.message);
    res.status(401).json({ error: 'Invalid Google token', details: err.message });
  }
});

// AUTH MIDDLEWARE
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─────────────────────────────────────────────────────────
// LEADS & CAMPAIGNS (Baqi saara code wahi rahega)
// ─────────────────────────────────────────────────────────

app.get('/api/leads', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads', auth, async (req, res) => {
  try {
    const { first_name, last_name, email, company_website, company_name, headline, city, state, phone } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO leads(first_name, last_name, email, company_website, company_name, headline, city, state, phone)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(email) DO NOTHING RETURNING *`,
      [first_name, last_name, email, company_website, company_name, headline, city, state, phone]
    );
    res.json(rows[0] || { message: 'Lead already exists' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/run', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`INSERT INTO campaigns(user_id, status) VALUES($1, 'running') RETURNING *`, [req.user.userId]);
    const campaign = rows[0];
    axios.post(process.env.N8N_WEBHOOK_URL, {
      campaign_id: campaign.id,
      callback_url: `${process.env.BACKEND_URL}/api/campaigns/${campaign.id}/complete`
    }).catch(err => console.error('n8n trigger error:', err.message));
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', auth, async (req, res) => {
  try {
    const [leads, pending, campaigns, sent, recent] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM leads'),
      pool.query("SELECT COUNT(*) FROM email_drafts WHERE status='pending'"),
      pool.query('SELECT COUNT(*) FROM campaigns'),
      pool.query("SELECT COUNT(*) FROM email_drafts WHERE status='approved'"),
      pool.query('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 10'),
    ]);
    res.json({
      total_leads: parseInt(leads.rows[0].count),
      pending_drafts: parseInt(pending.rows[0].count),
      campaigns_count: parseInt(campaigns.rows[0].count),
      emails_sent: parseInt(sent.rows[0].count),
      recent_campaigns: recent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NexaMail backend running on port ${PORT}`);
});