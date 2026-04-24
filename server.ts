import express from "express";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const isVercel = process.env.VERCEL === '1';
const DATA_FILE = isVercel ? '/tmp/database.json' : path.join(process.cwd(), 'database.json');

// Ensure DB file exists lazily before use
async function ensureDb() {
  try {
    await fs.access(DATA_FILE);
  } catch (e) {
    try {
      await fs.writeFile(DATA_FILE, JSON.stringify({ ideas: {} }));
    } catch (err: any) {
      console.warn("No default write access for DB, may be running in read-only mode:", err.message);
    }
  }
}

// Use increased limit to allow potentially large inputs just in case
app.use(express.json({ limit: '10mb' }));

app.post("/api/proxy", async (req, res) => {
  try {
    const { url, headers, body } = req.body;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
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
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: { message: error instanceof Error ? error.message : "Proxy fetch failed" } });
  }
});

// --- Ideas Sharing API ---
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to share idea' });
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
  } catch (e) {
    res.status(500).json({ error: 'Failed to get idea' });
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
  } catch (e) {
    res.status(500).json({ error: 'Failed to vote' });
  }
});
// -----------------------

async function setupVite() {
  if (process.env.NODE_ENV !== "production" && !isVercel) {
    // Development mode: integration with Vite
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production mode: serving index.html
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

setupVite().then(() => {
  if (!isVercel) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
});

export default app;
