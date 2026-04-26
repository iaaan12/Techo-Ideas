import express from "express";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const isVercel = process.env.VERCEL === '1';
const DATA_FILE = isVercel ? '/tmp/database.json' : path.join(process.cwd(), 'database.json');

// Store SSE clients
const sseClients = new Map<string, any[]>();

// Ensure DB file exists lazily before use
async function ensureDb() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(raw);
    let modified = false;
    if (!db.ideas) {
      db.ideas = {};
      modified = true;
    }
    if (!db.notifications) {
      db.notifications = {};
      modified = true;
    }
    if (modified) {
      await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
    }
  } catch (e) {
    try {
      await fs.writeFile(DATA_FILE, JSON.stringify({ ideas: {}, notifications: {} }, null, 2));
    } catch (err: any) {
      console.warn("No default write access for DB, may be running in read-only mode:", err.message);
    }
  }
}

// Use increased limit to allow potentially large inputs just in case
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get("/api/ping", (req, res) => res.json({ ok: true, isVercel }));

app.post("/api/proxy", async (req, res) => {
  try {
    const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { url, headers, body } = reqBody;
    
    if (!url) {
      return res.status(400).json({ error: { message: "Invalid request: 'url' parameter is missing. Body was: " + JSON.stringify(reqBody).substring(0, 50) } });
    }
    
    const cleanHeaders: Record<string, string> = {};
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === "string") {
          cleanHeaders[key] = value.replace(/[^\x20-\x7E]/g, "");
        } else {
          cleanHeaders[key] = String(value);
        }
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers: cleanHeaders,
      body: JSON.stringify(body || {}),
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
    
    // Copy headers from the downstream response
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      const push = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            res.write(value);
          }
        } catch (err: any) {
          console.error("Error streaming to client:", err);
          res.end();
        }
      };
      push();
    } else {
      res.end();
    }
  } catch (error: any) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: { message: `Proxy fetch failed: ${error.name} - ${error.message}` } });
  }
});

// --- Notifications API ---
app.get("/api/notifications/stream", (req, res) => {
  const authorId = req.query.authorId as string;
  if (!authorId) return res.status(400).send("authorId missing");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (!sseClients.has(authorId)) {
    sseClients.set(authorId, []);
  }
  sseClients.get(authorId)!.push(res);

  req.on("close", () => {
    if (sseClients.has(authorId)) {
      const clients = sseClients.get(authorId)!;
      sseClients.set(authorId, clients.filter(c => c !== res));
    }
  });
});

app.get("/api/notifications", async (req, res) => {
  try {
    await ensureDb();
    const authorId = req.query.authorId as string;
    if (!authorId) return res.json([]);
    const rawData = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(rawData);
    res.json(db.notifications?.[authorId] || []);
  } catch (e) {
    res.json([]);
  }
});

app.post("/api/notifications/read", async (req, res) => {
  try {
    await ensureDb();
    const { authorId } = req.body;
    if (!authorId) return res.json({ ok: false });
    const rawData = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(rawData);
    if (db.notifications?.[authorId]) {
      db.notifications[authorId].forEach((n: any) => n.read = true);
      await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// --- Ideas Sharing API ---
app.post("/api/ideas/share", async (req, res) => {
  try {
    await ensureDb();
    const { idea, authorId } = req.body;
    const id = crypto.randomUUID();
    const rawData = await fs.readFile(DATA_FILE, 'utf-8');
    const db = JSON.parse(rawData);
    
    const ideasArray = Array.isArray(idea) ? idea : [idea];
    db.ideas[id] = {
      idea: ideasArray,
      votes: ideasArray.map(() => 0),
      createdAt: Date.now(),
      authorId: authorId || null
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
           // Notification Logic
           const authorId = db.ideas[id].authorId;
           if (authorId) {
             const ideaObj = db.ideas[id].idea[idx];
             const ideaTitle = ideaObj && typeof ideaObj === 'object' && ideaObj.titulo ? ideaObj.titulo : `Idea #${idx + 1}`;
             const notif = {
               id: crypto.randomUUID(),
               message: `👍 ¡Alguien votó por tu idea "${ideaTitle}"!`,
               ideaId: id,
               ideaIndex: idx,
               timestamp: Date.now(),
               read: false
             };
             
             if (!db.notifications) db.notifications = {};
             if (!db.notifications[authorId]) db.notifications[authorId] = [];
             db.notifications[authorId].push(notif);
             
             // Notify via SSE
             if (sseClients.has(authorId)) {
               const clients = sseClients.get(authorId)!;
               const dataStr = `data: ${JSON.stringify(notif)}\n\n`;
               for (const client of clients) {
                 client.write(dataStr);
               }
             }
           }

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
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    app.use('*', async (req, res, next) => {
      try {
        let template = await fs.readFile(path.join(process.cwd(), 'index.html'), 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    // Production mode: serving index.html
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
        app.get('*', async (req, res) => {
      try {
        let html = await fs.readFile(path.join(distPath, 'index.html'), 'utf-8');
        res.send(html);
      } catch (e) {
        res.status(500).send("Error loading app");
      }
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
