import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, Plugin } from 'vite';
import { DigitalNotebookLocalServer } from './server/wsServer.ts';

function ensureAdbReverseTunnel(port: number): void {
  const localAppData = process.env.LOCALAPPDATA ?? 'C:\\Users\\mateu\\AppData\\Local';
  const adbPath = path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  const cmd = fs.existsSync(adbPath) ? adbPath : 'adb';
  execFile(cmd, ['reverse', `tcp:${port}`, `tcp:${port}`], () => {});
}

const globalState = globalThis as unknown as {
  __dnLocalServer?: DigitalNotebookLocalServer;
  __dnAdbTimer?: ReturnType<typeof setInterval>;
};

async function stopActiveBackendServer(onlyIfInstance?: DigitalNotebookLocalServer): Promise<void> {
  if (onlyIfInstance && globalState.__dnLocalServer !== onlyIfInstance) {
    return;
  }
  if (globalState.__dnAdbTimer) {
    clearInterval(globalState.__dnAdbTimer);
    globalState.__dnAdbTimer = undefined;
  }
  if (globalState.__dnLocalServer) {
    const prev = globalState.__dnLocalServer;
    globalState.__dnLocalServer = undefined;
    try {
      await prev.stop();
    } catch {
      // Ignora erro caso já esteja fechado
    }
    try {
      prev.db.close();
    } catch {
      // Ignora erro caso o banco já esteja fechado
    }
  }
}

async function startOnFixedPortWithRetry(
  srv: DigitalNotebookLocalServer,
  port: number,
  host: string
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await srv.start(port, host);
      return;
    } catch (err) {
      if (attempt === 14) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function nebulaInkBackendPlugin(): Plugin {
  let pluginServerInstance: DigitalNotebookLocalServer | null = null;

  return {
    name: 'nebula-ink-local-server',
    async configureServer() {
      try {
        // Sempre encerra a instância anterior antes de subir a nova ao recarregar código de server/
        await stopActiveBackendServer();

        const dbPath = path.resolve(process.cwd(), 'digital_notebook.sqlite');
        const srv = new DigitalNotebookLocalServer({
          dbFilePath: dbPath,
          requireExplicitApproval: false,
        });
        await startOnFixedPortWithRetry(srv, 8765, '0.0.0.0');

        pluginServerInstance = srv;
        globalState.__dnLocalServer = srv;
        const boundPort = srv.getPort();
        console.log(`[NebulaInk Server] Backend WebSocket/SQLite ativo na porta ${boundPort}`);
        ensureAdbReverseTunnel(boundPort);
        globalState.__dnAdbTimer = setInterval(() => {
          ensureAdbReverseTunnel(boundPort);
        }, 4000);
      } catch (err) {
        console.error('[NebulaInk Server] Erro ao reiniciar servidor backend:', err);
      }
    },
    async closeBundle() {
      if (pluginServerInstance) {
        await stopActiveBackendServer(pluginServerInstance);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), nebulaInkBackendPlugin()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
