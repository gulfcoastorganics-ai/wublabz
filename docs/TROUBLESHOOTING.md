# Troubleshooting Connections

## 1. "/health" Request Fails
- Ensure WubLabz backend is running: `npm run server`.
- Check if port 3001 is blocked by a firewall.
- Verify `VITE_WUBLABZ_HTTP_URL` is correct in your frontend environment.

## 2. WebSocket Connection Fails
- Ensure the server logs show "WubLabz Backend running".
- Verify `VITE_WUBLABZ_WS_URL` is correct.
- If using HTTPS for the frontend, you MUST use `wss:` for the WebSocket.

## 3. High Latency
- Check the "Latency" value in `EngineMonitor`.
- Latency > 100ms indicates network congestion or high server load.
- If running in Google AI Studio, ensure your local backend is reachable via a tunnel (e.g., ngrok) if the preview cannot reach `localhost`.

## 4. AI Studio Preview Issues
The Google AI Studio preview runs in a sandboxed browser. It may not be able to reach `http://localhost:3001` directly if it's on a different virtual network.
- **Solution A:** Use a tunnel (ngrok) and set `VITE_WUBLABZ_HTTP_URL` to the public tunnel URL.
- **Solution B:** Run the frontend locally alongside the backend instead of using the AI Studio preview for real-time testing.
- **Solution C:** Use `VITE_WUBLABZ_MOCK=true` to test the UI logic without a real backend.

## 5. Emergency Stop Active
If the `EngineMonitor` shows `E-Stop: STOPPED`, the server has received an `EMERGENCY_STOP` event. Refresh the connection or restart the backend to clear this state if no "Clear Stop" event is implemented.
