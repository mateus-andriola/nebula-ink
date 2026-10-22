/**
 * Bridge de Comunicação do Aplicativo Desktop com o Servidor Local SQLite + WebSocket.
 */

import QRCode from 'qrcode';
import {
  type GridSettings,
  type NotebookSummary,
  type PageStateSnapshot,
  type PairingQrPayload,
  type Stroke,
  type StrokePoint,
} from '../../../protocol/src/index.ts';

export interface ServerStatusInfo {
  port: number;
  preferredHost: string;
  candidateHosts: string[];
  activeNotebookId: string;
  activePageId: string;
  connectedMobileCount: number;
  requireExplicitApproval: boolean;
  pendingApprovals: Array<{
    deviceId: string;
    deviceName: string;
    requestedAt: number;
  }>;
  pairedDevices: Array<{
    deviceId: string;
    deviceName: string;
    approved: boolean;
    pairedAt: number;
    lastSeenAt: number;
  }>;
}

export type DesktopServerEvent =
  | {
      event: 'desktop.init';
      status: ServerStatusInfo;
      notebooks: NotebookSummary[];
      activePage: PageStateSnapshot | null;
    }
  | {
      event: 'status.updated';
      status: ServerStatusInfo;
    }
  | {
      event: 'stroke.begin';
      stroke: Stroke;
    }
  | {
      event: 'stroke.points';
      strokeId: string;
      pageId: string;
      seq: number;
      points: StrokePoint[];
    }
  | {
      event: 'stroke.cancelled';
      strokeId: string;
      pageId: string;
    }
  | {
      event: 'page.updated';
      pageId: string;
      snapshot: PageStateSnapshot | null;
    }
  | {
      event: 'page.selected';
      notebookId: string;
      pageId: string;
      notebooks: NotebookSummary[];
      snapshot: PageStateSnapshot | null;
    };

const DEFAULT_API_BASE = 'http://127.0.0.1:8765';
const DEFAULT_WS_URL = 'ws://127.0.0.1:8765?client=desktop-ui';

export class DesktopBackendBridge {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private readonly listeners = new Set<(ev: DesktopServerEvent) => void>();

  public connectRealtime(onEvent: (ev: DesktopServerEvent) => void): () => void {
    this.listeners.add(onEvent);
    if (!this.ws) {
      this.openWebSocket();
    }
    return () => {
      this.listeners.delete(onEvent);
      if (this.listeners.size === 0) {
        this.closeWebSocket();
      }
    };
  }

  private openWebSocket(): void {
    try {
      const ws = new WebSocket(DEFAULT_WS_URL);
      this.ws = ws;

      ws.onmessage = (msgEv) => {
        try {
          const parsed = JSON.parse(String(msgEv.data)) as DesktopServerEvent;
          for (const listener of this.listeners) {
            listener(parsed);
          }
        } catch {
          // Ignore malformed UI event
        }
      };

      ws.onclose = () => {
        this.ws = null;
        if (this.listeners.size > 0 && this.reconnectTimer === null) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.openWebSocket();
          }, 1500);
        }
      };
    } catch {
      // Fallback
    }
  }

  private closeWebSocket(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public async fetchState(): Promise<{
    status: ServerStatusInfo;
    notebooks: NotebookSummary[];
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/state`);
    if (!res.ok) throw new Error('Failed to load desktop server state');
    return (await res.json()) as {
      status: ServerStatusInfo;
      notebooks: NotebookSummary[];
      activePage: PageStateSnapshot | null;
    };
  }

  public async generatePairingQr(options?: {
    host?: string;
    requireExplicitApproval?: boolean;
  }): Promise<{
    qr: PairingQrPayload;
    qrDataUrl: string;
    status: ServerStatusInfo;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pairing/qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    });
    if (!res.ok) throw new Error('Failed to generate pairing QR');
    const data = (await res.json()) as { qr: PairingQrPayload; status: ServerStatusInfo };
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(data.qr), {
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return {
      qr: data.qr,
      qrDataUrl,
      status: data.status,
    };
  }

  public async approveDevice(deviceId: string, approve: boolean): Promise<ServerStatusInfo> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pairing/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, approve }),
    });
    const data = (await res.json()) as { status: ServerStatusInfo };
    return data.status;
  }

  public async createNotebook(title: string): Promise<{
    notebooks: NotebookSummary[];
    activeNotebookId: string;
    activePageId: string;
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/notebooks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return (await res.json()) as {
      notebooks: NotebookSummary[];
      activeNotebookId: string;
      activePageId: string;
      activePage: PageStateSnapshot | null;
    };
  }

  public async deleteNotebook(notebookId: string): Promise<{
    notebooks: NotebookSummary[];
    activeNotebookId: string;
    activePageId: string;
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/notebooks/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebookId }),
    });
    return (await res.json()) as {
      notebooks: NotebookSummary[];
      activeNotebookId: string;
      activePageId: string;
      activePage: PageStateSnapshot | null;
    };
  }

  public async createPage(notebookId: string, title?: string): Promise<{
    notebooks: NotebookSummary[];
    activeNotebookId: string;
    activePageId: string;
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pages/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebookId, title }),
    });
    return (await res.json()) as {
      notebooks: NotebookSummary[];
      activeNotebookId: string;
      activePageId: string;
      activePage: PageStateSnapshot | null;
    };
  }

  public async deletePage(pageId: string): Promise<{
    notebooks: NotebookSummary[];
    activeNotebookId: string;
    activePageId: string;
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pages/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId }),
    });
    return (await res.json()) as {
      notebooks: NotebookSummary[];
      activeNotebookId: string;
      activePageId: string;
      activePage: PageStateSnapshot | null;
    };
  }

  public async selectPage(notebookId: string, pageId: string): Promise<{
    notebooks: NotebookSummary[];
    activeNotebookId: string;
    activePageId: string;
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pages/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebookId, pageId }),
    });
    return (await res.json()) as {
      notebooks: NotebookSummary[];
      activeNotebookId: string;
      activePageId: string;
      activePage: PageStateSnapshot | null;
    };
  }

  public async updatePageOrientation(
    pageId: string,
    width: number,
    height: number
  ): Promise<{
    notebooks: NotebookSummary[];
    activePage: PageStateSnapshot | null;
  }> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pages/orientation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, width, height }),
    });
    return (await res.json()) as {
      notebooks: NotebookSummary[];
      activePage: PageStateSnapshot | null;
    };
  }

  public async updateGrid(
    pageId: string,
    grid: GridSettings,
    backgroundColor?: string
  ): Promise<PageStateSnapshot | null> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/pages/grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, grid, backgroundColor }),
    });
    const data = (await res.json()) as { activePage: PageStateSnapshot | null };
    return data.activePage;
  }

  public async undo(notebookId: string, pageId: string): Promise<PageStateSnapshot | null> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/operations/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebookId, pageId }),
    });
    const data = (await res.json()) as { activePage: PageStateSnapshot | null };
    return data.activePage;
  }

  public async redo(notebookId: string, pageId: string): Promise<PageStateSnapshot | null> {
    const res = await fetch(`${DEFAULT_API_BASE}/api/operations/redo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebookId, pageId }),
    });
    const data = (await res.json()) as { activePage: PageStateSnapshot | null };
    return data.activePage;
  }

  public async fetchNotebookPagesForExport(notebookId: string): Promise<PageStateSnapshot[]> {
    const res = await fetch(
      `${DEFAULT_API_BASE}/api/notebooks/export-data?notebookId=${encodeURIComponent(notebookId)}`
    );
    const data = (await res.json()) as { pages: PageStateSnapshot[] };
    return data.pages ?? [];
  }
}

export const desktopBridge = new DesktopBackendBridge();
