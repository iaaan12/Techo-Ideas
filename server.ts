import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

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

  if (process.env.NODE_ENV !== "production") {
    // Development mode: integration with Vite
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production mode: serving index.html
    const cwd = process.cwd();
    app.use(express.static(cwd));
    app.get('*', (req, res) => {
      res.sendFile(path.join(cwd, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
