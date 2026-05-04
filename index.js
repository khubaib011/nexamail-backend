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

// ─────────────────────────────────────────────────────────
// DATABASE INITIALIZATION — Auto-create tables on startup
// ─────────────────────────────────────────────────────────
const initDb = async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, 
      email VARCHAR UNIQUE NOT NULL, 
      name VARCHAR, 
      google_id VARCHAR, 
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY, 
      first_name VARCHAR, 
      last_name VARCHAR, 
      email VARCHAR UNIQUE, 
      company_website VARCHAR, 
      company_name VARCHAR, 
      headline VARCHAR, 
      city VARCHAR, 
      state VARCHAR, 
      phone VARCHAR, 
      status VARCHAR DEFAULT 'pending', 
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY, 
      user_id INTEGER REFERENCES users(id), 
      status VARCHAR DEFAULT 'running', 
      leads_processed INTEGER DEFAULT 0, 
      drafts_created INTEGER DEFAULT 0, 
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS email_drafts (
      id SERIAL PRIMARY KEY, 
      campaign_id INTEGER REFERENCES campaigns(id), 
      lead_id INTEGER REFERENCES leads(id), 
      recipient_name VARCHAR, 
      recipient_email VARCHAR, 
      subject TEXT, 
      body TEXT, 
      status VARCHAR DEFAULT 'pending', 
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;
  try {
    await pool.query(query);
    console.log("✅ NexaMail Database Tables Ready!");
  } catch (err) {
    console.error("❌ Error initializing database:", err.message);
  }
};

// Run DB Init
initDb();

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─────────────────────────────────────────────────────────
// AUTH — Google login
// ─────────────────────────────────────────────────────────

app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;

    // Verify the Google token is real
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const { email, name, sub } = ticket.getPayload();

    // Save user to PostgreSQL (or update if exists)
    const { rows } = await pool.query(
      `INSERT INTO users(email, name, google_id)
       VALUES($1, $2, $3)
       ON CONFLICT(email) DO UPDATE SET name=$2
       RETURNING id`,
      [email, name, sub]
    );

    // Create a JWT token for Flutter to use in future requests
    const jwtToken = jwt.sign(
      { userId: rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ jwt_token: jwtToken });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// ─────────────────────────────────────────────────────────
// AUTH MIDDLEWARE — protects all routes below
// ─────────────────────────────────────────────────────────

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
// LEADS
// ─────────────────────────────────────────────────────────

// Get all leads
app.get('/api/leads', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM leads ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add single lead
app.post('/api/leads', auth, async (req, res) => {
  try {
    const { first_name, last_name, email, company_website,
            company_name, headline, city, state, phone } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO leads(first_name, last_name, email, company_website,
        company_name, headline, city, state, phone)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(email) DO NOTHING
       RETURNING *`,
      [first_name, last_name, email, company_website,
       company_name, headline, city, state, phone]
    );
    res.json(rows[0] || { message: 'Lead already exists' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import leads from CSV (bulk)
app.post('/api/leads/import', auth, async (req, res) => {
  try {
    const { leads } = req.body;
    let imported = 0;
    for (const lead of leads) {
      await pool.query(
        `INSERT INTO leads(first_name, last_name, email, company_website,
          company_name, headline, city, state, phone)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(email) DO NOTHING`,
        [lead.first_name, lead.last_name, lead.email,
         lead.company_website, lead.company_name, lead.headline,
         lead.city, lead.state, lead.phone]
      );
      imported++;
    }
    res.json({ success: true, imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a lead
app.delete('/api/leads/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// CAMPAIGNS — this triggers your n8n workflow
// ─────────────────────────────────────────────────────────

// Run a new campaign (Flutter calls this)
app.post('/api/campaigns/run', auth, async (req, res) => {
  try {
    // 1. Create campaign record in DB with status "running"
    const { rows } = await pool.query(
      `INSERT INTO campaigns(user_id, status)
       VALUES($1, 'running') RETURNING *`,
      [req.user.userId]
    );
    const campaign = rows[0];

    // 2. Trigger your n8n webhook — fire and forget
    axios.post(process.env.N8N_WEBHOOK_URL, {
      campaign_id: campaign.id,
      callback_url: `${process.env.BACKEND_URL}/api/campaigns/${campaign.id}/complete`
    }).catch(err => console.error('n8n trigger error:', err.message));

    // 3. Return campaign immediately to Flutter
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get campaign status (Flutter polls this every 5 seconds)
app.get('/api/campaigns/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM campaigns WHERE id=$1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all campaigns history
app.get('/api/campaigns', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 20'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// n8n calls this endpoint when the workflow finishes
app.post('/api/campaigns/:id/complete', async (req, res) => {
  try {
    const { drafts_created, leads_processed, drafts } = req.body;
    const campaignId = req.params.id;

    // Update campaign as completed
    await pool.query(
      `UPDATE campaigns
       SET status='completed', drafts_created=$1, leads_processed=$2
       WHERE id=$3`,
      [drafts_created || 0, leads_processed || 0, campaignId]
    );

    // Save each email draft n8n generated
    if (drafts && Array.isArray(drafts)) {
      for (const d of drafts) {
        await pool.query(
          `INSERT INTO email_draft_drafts
            (campaign_id, lead_id, recipient_name, recipient_email, subject, body, status)
           VALUES($1,$2,$3,$4,$5,$6,'pending')`,
          [campaignId, d.lead_id || null,
           d.recipient_name, d.recipient_email,
           d.subject, d.body]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// EMAIL DRAFTS
// ─────────────────────────────────────────────────────────

// Get all drafts
app.get('/api/drafts', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM email_drafts ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve a draft
app.post('/api/drafts/:id/approve', auth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE email_drafts SET status='approved' WHERE id=$1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a draft
app.put('/api/drafts/:id', auth, async (req, res) => {
  try {
    const { subject, body } = req.body;
    await pool.query(
      'UPDATE email_drafts SET subject=$1, body=$2 WHERE id=$3',
      [subject, body, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a draft
app.delete('/api/drafts/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM email_drafts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// STATS — for Dashboard and Analytics screens
// ─────────────────────────────────────────────────────────

app.get('/api/stats', auth, async (req, res) => {
  try {
    const [leads, pending, campaigns, sent, recent] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM leads'),
      pool.query("SELECT COUNT(*) FROM email_drafts WHERE status='pending'"),
      pool.query('SELECT COUNT(*) FROM campaigns'),
      pool.query("SELECT COUNT(*) FROM email_drafts WHERE status='approved'"),
      pool.query(
        'SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 10'
      ),
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

// ─────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NexaMail backend running on port ${PORT}`);
});