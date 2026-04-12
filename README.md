Single-server mode (recommended)

1. Install and run:
- `npm install`
- `npm run start`

2. Open the app directly from Express on port 3000:
- `http://127.0.0.1:3000/index.html`
- `http://127.0.0.1:3000/Admin.html`
- `http://127.0.0.1:3000/Login.html`
- `http://127.0.0.1:3000/good-samaritan-board.html`

3. API and frontend are served by the same server:
- `GET /api/items`
- `POST /api/items`
- other `/api/*` routes

4. Share publicly with one ngrok tunnel:
- `ngrok http 3000`

Notes:
- Express logs startup as: `[server] Running at http://localhost:3000`
- Frontend pages use same-origin API calls when served from port 3000.
- Optional override still works: `?apiBase=https://<your-backend-url>`
