const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HOST = '127.0.0.1';
const UI_PORT = 3000;
const ENGINE_PORT = 3001;
const WORKER_PORT = 3002;

let mainWindow;
let staticServer;
let engineServer;
let workerServer;
let shuttingDown = false;

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.woff2': 'font/woff2'
  })[ext] || 'application/octet-stream';
}

function safeStaticPath(root, requestUrl) {
  const rawPath = decodeURIComponent((requestUrl || '/').split('?')[0]);
  const normalized = path.normalize(rawPath).replace(/^([.][.][/\\])+/, '');
  const relative = normalized === '/' || normalized === '.' ? 'index.html' : normalized.replace(/^[/\\]+/, '');
  const candidate = path.join(root, relative);
  return candidate.startsWith(root) ? candidate : path.join(root, 'index.html');
}

async function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = safeStaticPath(root, req.url);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(root, 'index.html');
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('WubLabz Studio failed to load its UI.');
          return;
        }
        res.writeHead(200, {
          'content-type': contentType(filePath),
          'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
        });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(UI_PORT, HOST, () => resolve(server));
  });
}

async function startLocalServices() {
  const appRoot = app.getAppPath();
  const dataRoot = app.getPath('userData');
  const workDir = path.join(dataRoot, 'flip-prep');
  const cacheDir = path.join(dataRoot, 'flip-cache');

  process.env.FLIP_WORKER_HOST = HOST;
  process.env.FLIP_WORKER_PORT = String(WORKER_PORT);
  process.env.FLIP_WORKER_URL = `http://${HOST}:${WORKER_PORT}`;
  process.env.FLIP_PREP_WORK_DIR = workDir;
  process.env.FLIP_PREP_CACHE_DIR = cacheDir;
  process.env.WUBLABZ_PORT = String(ENGINE_PORT);

  const workerModuleUrl = pathToFileURL(path.join(appRoot, 'dist/flip-worker/server.js')).href;
  const engineModuleUrl = pathToFileURL(path.join(appRoot, 'dist/wublabz/server.js')).href;

  const [{ createFlipPrepWorker }, { createWubLabzServer }] = await Promise.all([
    import(workerModuleUrl),
    import(engineModuleUrl)
  ]);

  workerServer = await createFlipPrepWorker({ logger: true });
  await workerServer.listen({ port: WORKER_PORT, host: HOST });

  engineServer = await createWubLabzServer({
    logger: false,
    flipPrepWorkerUrl: `http://${HOST}:${WORKER_PORT}`
  });
  await engineServer.listen({ port: ENGINE_PORT, host: HOST });

  staticServer = await startStaticServer(path.join(appRoot, 'dist/app'));
}

async function stopLocalServices() {
  if (shuttingDown) return;
  shuttingDown = true;

  const closers = [];
  if (engineServer) closers.push(engineServer.close().catch(() => undefined));
  if (workerServer) closers.push(workerServer.close().catch(() => undefined));
  if (staticServer) {
    closers.push(new Promise((resolve) => staticServer.close(() => resolve())));
  }

  await Promise.allSettled(closers);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#07090d',
    title: 'WubLabz Studio',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  void mainWindow.loadURL(`http://${HOST}:${UI_PORT}`);
}

app.whenReady().then(async () => {
  try {
    await startLocalServices();
    createWindow();
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    dialog.showErrorBox(
      'WubLabz Studio could not start',
      `The local WubLabz services failed to start.\n\n${detail}\n\nClose any older WubLabz process and launch the app again.`
    );
    await stopLocalServices();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && staticServer) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  void stopLocalServices().finally(() => {
    app.exit(0);
  });
});
