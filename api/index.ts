import express from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const DATA_FILE = '/tmp/database.json';

async function ensureDb() {
  try {
    await fs.access(DATA_FILE);
  } catch (e) {
    try {
      await fs.writeFile(DATA_FILE, JSON.stringify({ ideas: {} }));
    } catch (err: any) {
      console.warn("DB init warning:", err.message);
    }
  }
}

app.get('/api/ping', (req, res) => res.json({ ok: true, version: 2 }));

app.post('/api/proxy', async (req, res) => {
  try {
    const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { url, headers, body } = reqBody;
    
    if (!url) {
      return res.status(400).json({ error: { message: "Invalid request: 'url' missing" } });
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: headers || {},
      body: JSON.stringify(body || {})
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      let errObj;
      try {
        errObj = JSON.parse(errorText);
      } catch (e) {
        errObj = { error: { message: `Gateway Error (${response.status}): ${errorText.substring(0, 200)}` } };
      }
      return res.status(response.status).json(errObj);
    }
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    res.status(500).json({ error: { message: `Proxy Error: ${error.message}` } });
  }
});

app.post("/api/ideas/share", async (req, res) => {
  try {
    await ensureDb();
    const { idea } = req.body;
    const id = crypto.randomUUID();
    const rawData = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(rawData);
    
    const ideasArray = Array.isArray(idea) ? idea : [idea];
    db.ideas[id] = {
      idea: ideasArray,
      votes: ideasArray.map(() => 0),
      createdAt: Date.now()
    };
    
    await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
    res.json({ id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ideas/:id", async (req, res) => {
  try {
    await ensureDb();
    const id = req.params.id;
    const rawData = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(rawData);
    
    if (db.ideas[id]) {
      res.json(db.ideas[id]);
    } else {
      res.status(404).json({ error: 'Idea not found' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ideas/:id/vote/:ideaIndex", async (req, res) => {
  try {
    await ensureDb();
    const { id, ideaIndex } = req.params;
    const idx = parseInt(ideaIndex, 10);
    const rawData = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(rawData);
    
    if (db.ideas[id]) {
      if (!Array.isArray(db.ideas[id].votes)) {
          const ideasArray = Array.isArray(db.ideas[id].idea) ? db.ideas[id].idea : [db.ideas[id].idea];
          db.ideas[id].votes = ideasArray.map(() => 0);
      }
      
      if (db.ideas[id].votes[idx] !== undefined) {
           db.ideas[id].votes[idx] += 1;
           await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
           res.json({ votes: db.ideas[id].votes });
      } else {
           res.status(404).json({ error: 'Idea index not found' });
      }
    } else {
      res.status(404).json({ error: 'Idea generation not found' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default app;
