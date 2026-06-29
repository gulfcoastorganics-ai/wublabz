# Local Development Connection Guide

To connect WubPad to the WubLabz backend locally, follow these steps:

## 1. Start the WubLabz Backend
In this repository, run:
```bash
npm install
npm run server
```
The server will start on `http://localhost:3001` and expose a WebSocket at `ws://localhost:3001`.

## 2. Configure WubPad
Ensure WubPad has the following environment variables (usually in a `.env.local` file):
```env
VITE_WUBLABZ_HTTP_URL=http://localhost:3001
VITE_WUBLABZ_WS_URL=ws://localhost:3001
```

## 3. Start WubPad
In the WubPad repository, run:
```bash
npm run dev
```

## 4. Verify Connection
Open WubPad in your browser. The `EngineMonitor` component should show:
- **Socket Status:** OPEN
- **Health Check:** OK
- **Engine Ready:** YES
