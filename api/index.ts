import express from 'express';
import crypto from 'crypto';
import { createClient } from 'redis';

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Redis Client Setup
const redis = createClient({
  url: process.env.KV_URL || process.env.REDIS_URL
});

redis.on('error', err => console.error('Redis Client Error', err));

async function getRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }
  return redis;
}

app.get('/api/ping', (req, res) => res.json({ ok: true, storage: 'redis' }));

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
    const client = await getRedis();
    const { idea } = req.body;
    const id = crypto.randomUUID();
    
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    const ideasArray = Array.isArray(idea) ? idea : [idea];
    const newEntry = {
      idea: ideasArray,
      votes: ideasArray.map(() => 0),
      createdAt: Date.now()
    };
    
    await client.set(`idea:${id}`, JSON.stringify(newEntry));
    res.json({ id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ideas/:id", async (req, res) => {
  try {
    const client = await getRedis();
    const id = req.params.id;
    const dataString = await client.get(`idea:${id}`);
    
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    if (dataString) {
      const data = JSON.parse(dataString);
      res.json(data);
    } else {
      res.status(404).json({ error: 'Idea not found' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ideas/:id/vote/:ideaIndex", async (req, res) => {
  try {
    const client = await getRedis();
    const { id, ideaIndex } = req.params;
    const idx = parseInt(ideaIndex, 10);
    
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    const dataString = await client.get(`idea:${id}`);
    
    if (dataString) {
      const data = JSON.parse(dataString);
      
      if (!Array.isArray(data.votes)) {
          const ideasArray = Array.isArray(data.idea) ? data.idea : [data.idea];
          data.votes = ideasArray.map(() => 0);
      }
      
      if (data.votes[idx] !== undefined) {
           data.votes[idx] += 1;
           await client.set(`idea:${id}`, JSON.stringify(data));
           res.json({ votes: data.votes });
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
