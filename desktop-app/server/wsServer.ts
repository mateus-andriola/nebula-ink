/**
 * Servidor Local WebSocket + HTTP Bridge para Pareamento via QR Code,
 * Sincronização em Tempo Real com o Samsung Galaxy S24 Ultra e Persistência SQLite.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import {
  type GridSettings,
  MAX_MESSAGE_BYTES,
  type NotebookSummary,
  type PageMetadata,
  type PageStateSnapshot,
  type PairingQrPayload,
  type ProtocolMessage,
  type SessionErrorCode,
  type Stroke,
  type StrokePoint,
  parseAndValidateProtocolMessage,
  serializeProtocolMessage,
} from '../../protocol/src/index.ts';
import { NotebookDatabase, type PairedDeviceRecord } from './db.ts';

export interface ActivePairingToken {
  token: string;
  expiresAt: number;
  used: boolean;
}

export interface PendingDeviceApproval {
  deviceId: string;
  deviceName: string;
  sessionId: string;
  sessionResumeToken: string;
  requestedAt: number;
  socket: WebSocket;
}

export interface ServerStatusSnapshot {
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
  pairedDevices: PairedDeviceRecord[];
}

interface MobileClientContext {
  authenticated: boolean;
  approved: boolean;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  strokeSeqTracker: Map<string, number>;
}

/**
 * Descobre os endereços IPv4 da máquina priorizando redes Wi-Fi / LAN privadas (192.168.x.x, 10.x.x.x)
 * em vez de adaptadores virtuais (ex.: Hamachi 25.x.x.x ou vEthernet 172.18.x.x).
 */
export function discoverLanIPv4Candidates(): { preferred: string; candidates: string[] } {
  const interfaces = os.networkInterfaces();
  const wifiAndLan: string[] = [];
  const otherIps: string[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const lowerName = name.toLowerCase();
    const isVirtualAdapter =
      lowerName.includes('hamachi') ||
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('docker') ||
      lowerName.includes('vbox') ||
      lowerName.includes('vmware');

    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        if (
          !isVirtualAdapter &&
          (addr.address.startsWith('192.168.') || addr.address.startsWith('10.'))
        ) {
          wifiAndLan.push(addr.address);
        } else {
          otherIps.push(addr.address);
        }
      }
    }
  }

  const candidates = [...wifiAndLan, ...otherIps];
  if (candidates.length === 0) {
    candidates.push('127.0.0.1');
  }

  return {
    preferred: candidates[0]!,
    candidates,
  };
}

export class DigitalNotebookLocalServer {
  public readonly db: NotebookDatabase;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private selectedHost: string;
  private requireExplicitApproval = false;

  private activeNotebookId = 'nb_default';
  private activePageId = 'page_default_1';

  private currentPairingToken: ActivePairingToken | null = null;
  private readonly pairingTokens = new Map<string, ActivePairingToken>();
  private readonly mobileClients = new Map<WebSocket, MobileClientContext>();
  private readonly desktopUiClients = new Set<WebSocket>();
  private readonly pendingApprovals = new Map<string, PendingDeviceApproval>();
  private readonly activeProvisionalStrokes = new Map<string, Stroke>();

  constructor(options?: {
    dbFilePath?: string;
    requireExplicitApproval?: boolean;
  }) {
    this.db = new NotebookDatabase(options?.dbFilePath ?? ':memory:');
    this.requireExplicitApproval = options?.requireExplicitApproval ?? false;
    const { preferred } = discoverLanIPv4Candidates();
    this.selectedHost = preferred;

    const notebooks = this.db.listNotebooks();
    if (notebooks.length > 0) {
      const nb = notebooks[0]!;
      this.activeNotebookId = nb.id;
      if (nb.pages.length > 0) {
        this.activePageId = nb.pages[0]!.id;
      }
    }
  }

  public async start(requestedPort = 0, bindHost = '0.0.0.0'): Promise<number> {
    if (this.httpServer && this.port > 0) {
      return this.port;
    }

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'Internal server error',
          })
        );
      });
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: MAX_MESSAGE_BYTES * 2, // Deixa o validador emitir PAYLOAD_TOO_LARGE estruturado até 1MB
    });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.get('client') === 'desktop-ui') {
        this.desktopUiClients.add(ws);
        ws.on('close', () => {
          this.desktopUiClients.delete(ws);
        });
        ws.send(
          JSON.stringify({
            event: 'desktop.init',
            status: this.getStatusSnapshot(),
            notebooks: this.db.listNotebooks(),
            activePage: this.db.getPageSnapshot(this.activePageId),
          })
        );
        return;
      }

      // Conexão de dispositivo móvel (Samsung Galaxy S24 Ultra)
      const ctx: MobileClientContext = {
        authenticated: false,
        approved: false,
        sessionId: '',
        deviceId: '',
        deviceName: '',
        strokeSeqTracker: new Map(),
      };
      this.mobileClients.set(ws, ctx);

      ws.on('message', (data) => {
        const rawBuf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
        this.handleMobileMessage(ws, ctx, rawBuf);
      });

      ws.on('close', () => {
        this.mobileClients.delete(ws);
        if (ctx.deviceId) {
          this.pendingApprovals.delete(ctx.deviceId);
        }
        this.broadcastDesktopEvent({
          event: 'status.updated',
          status: this.getStatusSnapshot(),
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(requestedPort, bindHost, () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });

    return this.port;
  }

  public async stop(): Promise<void> {
    for (const ws of this.mobileClients.keys()) {
      ws.terminate();
    }
    for (const ws of this.desktopUiClients) {
      ws.terminate();
    }
    this.mobileClients.clear();
    this.desktopUiClients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.httpServer) {
      if (typeof this.httpServer.closeAllConnections === 'function') {
        this.httpServer.closeAllConnections();
      }
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    this.port = 0;
  }

  public getPort(): number {
    return this.port;
  }

  public setSelectedHost(host: string): void {
    this.selectedHost = host;
  }

  public setRequireExplicitApproval(requireApproval: boolean): void {
    this.requireExplicitApproval = requireApproval;
    this.broadcastDesktopEvent({
      event: 'status.updated',
      status: this.getStatusSnapshot(),
    });
  }

  /**
   * Gera um novo QR Code de pareamento com token temporário (validade de 5 minutos, uso único).
   */
  public generatePairingQrPayload(ttlMs = 5 * 60 * 1000): PairingQrPayload {
    const token = `tkn_${randomBytes(12).toString('hex')}`;
    const expiresAt = Date.now() + ttlMs;
    const entry: ActivePairingToken = {
      token,
      expiresAt,
      used: false,
    };
    this.currentPairingToken = entry;
    this.pairingTokens.set(token, entry);

    const { candidates } = discoverLanIPv4Candidates();
    return {
      v: 1,
      host: this.selectedHost,
      candidates,
      port: this.port,
      protocol: 'ws',
      pairingToken: token,
      expiresAt,
    };
  }

  public approvePendingDevice(deviceId: string, approve: boolean): boolean {
    const pending = this.pendingApprovals.get(deviceId);
    if (!pending) return false;
    this.pendingApprovals.delete(deviceId);

    if (!approve) {
      this.db.setDeviceApproval(deviceId, false);
      this.sendSessionError(
        pending.socket,
        'DEVICE_REJECTED',
        'O pareamento foi recusado pelo usuário no Desktop.',
        null,
        true
      );
      pending.socket.close(4003, 'Rejected by user');
      this.broadcastDesktopEvent({
        event: 'status.updated',
        status: this.getStatusSnapshot(),
      });
      return true;
    }

    this.db.upsertPairedDevice(
      pending.deviceId,
      pending.deviceName,
      pending.sessionResumeToken,
      true
    );

    const ctx = this.mobileClients.get(pending.socket);
    if (ctx) {
      ctx.authenticated = true;
      ctx.approved = true;
    }

    this.sendSessionStartSuccess(
      pending.socket,
      pending.sessionId,
      pending.sessionResumeToken
    );

    this.broadcastDesktopEvent({
      event: 'status.updated',
      status: this.getStatusSnapshot(),
    });
    return true;
  }

  public getStatusSnapshot(): ServerStatusSnapshot {
    const { candidates } = discoverLanIPv4Candidates();
    let connectedMobileCount = 0;
    for (const ctx of this.mobileClients.values()) {
      if (ctx.authenticated && ctx.approved) {
        connectedMobileCount += 1;
      }
    }

    return {
      port: this.port,
      preferredHost: this.selectedHost,
      candidateHosts: candidates,
      activeNotebookId: this.activeNotebookId,
      activePageId: this.activePageId,
      connectedMobileCount,
      requireExplicitApproval: this.requireExplicitApproval,
      pendingApprovals: Array.from(this.pendingApprovals.values()).map((p) => ({
        deviceId: p.deviceId,
        deviceName: p.deviceName,
        requestedAt: p.requestedAt,
      })),
      pairedDevices: this.db.listPairedDevices(),
    };
  }

  // ==========================================================================
  // Processamento do Protocolo WebSocket
  // ==========================================================================

  private handleMobileMessage(
    ws: WebSocket,
    ctx: MobileClientContext,
    rawBuf: Buffer
  ): void {
    const validation = parseAndValidateProtocolMessage(rawBuf);
    if (!validation.valid || !validation.message) {
      this.sendSessionError(
        ws,
        validation.errorCode ?? 'INVALID_MESSAGE_FORMAT',
        validation.errorReason ?? 'Invalid message.',
        null,
        validation.errorCode === 'PAYLOAD_TOO_LARGE'
      );
      return;
    }

    const msg = validation.message;

    // 1. Handshake de pareamento inicial (session.start)
    if (msg.type === 'session.start') {
      if (msg.payload.role !== 'client') {
        this.sendSessionError(ws, 'INVALID_MESSAGE_FORMAT', 'Expected client role.', null, true);
        return;
      }

      const { pairingToken, deviceId, deviceName } = msg.payload;
      const now = Date.now();

      const isAutoLanAllowed =
        pairingToken === 'auto_lan' &&
        (!this.requireExplicitApproval || deviceId === 's24u_live_surface');

      if (!isAutoLanAllowed) {
        const tokenEntry =
          this.pairingTokens.get(pairingToken) ??
          (this.currentPairingToken?.token === pairingToken ? this.currentPairingToken : null);

        if (!tokenEntry) {
          this.sendSessionError(
            ws,
            'INVALID_TOKEN',
            'Token de pareamento inválido.',
            null,
            true
          );
          return;
        }

        if (tokenEntry.used || now > tokenEntry.expiresAt) {
          this.sendSessionError(
            ws,
            'PAIRING_TIMEOUT',
            'Token de pareamento expirado ou já utilizado.',
            null,
            true
          );
          return;
        }

        // Consome o token de uso único
        tokenEntry.used = true;
      }

      const sessionId = `sess_${randomBytes(8).toString('hex')}`;
      const sessionResumeToken = `res_${randomBytes(16).toString('hex')}`;

      ctx.sessionId = sessionId;
      ctx.deviceId = deviceId;
      ctx.deviceName = deviceName;

      if (this.requireExplicitApproval) {
        ctx.authenticated = true;
        ctx.approved = false;
        this.pendingApprovals.set(deviceId, {
          deviceId,
          deviceName,
          sessionId,
          sessionResumeToken,
          requestedAt: now,
          socket: ws,
        });
        const pendingReply: ProtocolMessage = {
          type: 'session.start',
          timestamp: now,
          payload: {
            role: 'server',
            sessionId,
            sessionResumeToken,
            approved: false,
            activeNotebookId: this.activeNotebookId,
            activePageId: this.activePageId,
            notebooks: [],
            activePage: this.db.getPageSnapshot(this.activePageId)!,
          },
        };
        ws.send(serializeProtocolMessage(pendingReply));
        this.broadcastDesktopEvent({
          event: 'status.updated',
          status: this.getStatusSnapshot(),
        });
        return;
      }

      ctx.authenticated = true;
      ctx.approved = true;
      this.db.upsertPairedDevice(deviceId, deviceName, sessionResumeToken, true);
      this.sendSessionStartSuccess(ws, sessionId, sessionResumeToken);
      this.broadcastDesktopEvent({
        event: 'status.updated',
        status: this.getStatusSnapshot(),
      });
      return;
    }

    // 2. Retomada de sessão após reconexão Wi-Fi (session.resume)
    if (msg.type === 'session.resume') {
      const { sessionId, sessionResumeToken, deviceId } = msg.payload;
      const isValid = this.db.verifyResumeToken(deviceId, sessionResumeToken);
      if (!isValid && this.requireExplicitApproval) {
        this.sendSessionError(
          ws,
          'UNAUTHORIZED',
          'Sessão expirada ou dispositivo não autorizado.',
          null,
          true
        );
        return;
      }
      if (!isValid) {
        this.db.upsertPairedDevice(deviceId, 'Samsung Galaxy S24 Ultra', sessionResumeToken, true);
      }

      ctx.authenticated = true;
      ctx.approved = true;
      ctx.sessionId = sessionId;
      ctx.deviceId = deviceId;
      this.sendSessionStartSuccess(ws, sessionId, sessionResumeToken);
      this.broadcastDesktopEvent({
        event: 'status.updated',
        status: this.getStatusSnapshot(),
      });
      return;
    }

    // 3. Rejeitar qualquer comando se a sessão não estiver autenticada e aprovada
    if (!ctx.authenticated || !ctx.approved) {
      this.sendSessionError(
        ws,
        'UNAUTHORIZED',
        'Dispositivo não autenticado ou aguardando aprovação.',
        null,
        true
      );
      return;
    }

    // 4. Processar mensagens de escrita, borracha, desfazer/refazer e navegação de página
    switch (msg.type) {
      case 'stroke.begin': {
        const p = msg.payload;
        this.db.ensurePageExists(p.notebookId, p.pageId);
        if (this.activeNotebookId !== p.notebookId || this.activePageId !== p.pageId) {
          this.activeNotebookId = p.notebookId;
          this.activePageId = p.pageId;
          this.broadcastDesktopEvent({
            event: 'page.selected',
            notebookId: p.notebookId,
            pageId: p.pageId,
            notebooks: this.db.listNotebooks(),
            snapshot: this.db.getPageSnapshot(p.pageId),
          });
        }

        const provisional: Stroke = {
          id: p.strokeId,
          pageId: p.pageId,
          notebookId: p.notebookId,
          color: p.color,
          baseWidth: p.baseWidth,
          toolType: p.toolType,
          points: [p.startPoint],
          createdAt: msg.timestamp,
        };
        this.activeProvisionalStrokes.set(p.strokeId, provisional);
        ctx.strokeSeqTracker.set(p.strokeId, 0);

        this.broadcastDesktopEvent({
          event: 'stroke.begin',
          stroke: provisional,
        });
        break;
      }

      case 'stroke.points': {
        const p = msg.payload;
        const lastSeq = ctx.strokeSeqTracker.get(p.strokeId) ?? 0;
        if (p.seq <= lastSeq) {
          // Ignora lote fora de ordem ou duplicado
          return;
        }
        ctx.strokeSeqTracker.set(p.strokeId, p.seq);

        const provisional = this.activeProvisionalStrokes.get(p.strokeId);
        if (provisional) {
          provisional.points.push(...p.points);
        }

        this.broadcastDesktopEvent({
          event: 'stroke.points',
          strokeId: p.strokeId,
          pageId: p.pageId,
          seq: p.seq,
          points: p.points,
        });
        break;
      }

      case 'stroke.end': {
        const p = msg.payload;
        this.activeProvisionalStrokes.delete(p.stroke.id);
        ctx.strokeSeqTracker.delete(p.stroke.id);

        if (p.cancelled) {
          this.broadcastDesktopEvent({
            event: 'stroke.cancelled',
            strokeId: p.stroke.id,
            pageId: p.pageId,
          });
          this.sendOperationAck(ws, p.operationId, p.pageId, 'cancelled', false);
          return;
        }

        // Persistir em transação SQLite ANTES de enviar operation.ack
        try {
          const result = this.db.commitStrokeEnd(p.operationId, p.stroke);
          this.activeNotebookId = p.notebookId;
          this.activePageId = p.pageId;
          this.sendOperationAck(
            ws,
            p.operationId,
            p.pageId,
            'committed',
            result.duplicate,
            result.canUndo,
            result.canRedo
          );
          if (!result.duplicate) {
            this.broadcastDesktopEvent({
              event: 'page.updated',
              pageId: p.pageId,
              snapshot: this.db.getPageSnapshot(p.pageId),
            });
            this.broadcastMobileStateSync(ws);
          }
        } catch (err) {
          this.sendSessionError(
            ws,
            'INTERNAL_DB_ERROR',
            err instanceof Error ? err.message : 'Failed to commit stroke',
            p.operationId,
            false
          );
        }
        break;
      }

      case 'strokes.erase': {
        const p = msg.payload;
        try {
          const result = this.db.commitStrokesErase(
            p.operationId,
            p.notebookId,
            p.pageId,
            p.targetStrokeIds,
            p.removedStrokes
          );
          this.sendOperationAck(
            ws,
            p.operationId,
            p.pageId,
            'committed',
            result.duplicate,
            result.canUndo,
            result.canRedo
          );
          if (!result.duplicate) {
            this.broadcastDesktopEvent({
              event: 'page.updated',
              pageId: p.pageId,
              snapshot: this.db.getPageSnapshot(p.pageId),
            });
            this.broadcastMobileStateSync(ws);
          }
        } catch (err) {
          this.sendSessionError(
            ws,
            'INTERNAL_DB_ERROR',
            err instanceof Error ? err.message : 'Failed to commit erase',
            p.operationId,
            false
          );
        }
        break;
      }

      case 'operation.undo': {
        const p = msg.payload;
        try {
          const result = this.db.commitUndo(
            p.operationId,
            p.notebookId,
            p.pageId,
            p.targetOperationId
          );
          this.sendOperationAck(
            ws,
            p.operationId,
            p.pageId,
            'committed',
            result.duplicate,
            result.canUndo,
            result.canRedo
          );
          if (!result.duplicate) {
            this.broadcastDesktopEvent({
              event: 'page.updated',
              pageId: p.pageId,
              snapshot: this.db.getPageSnapshot(p.pageId),
            });
            this.broadcastMobileStateSync(ws);
          }
        } catch (err) {
          this.sendSessionError(
            ws,
            'INTERNAL_DB_ERROR',
            err instanceof Error ? err.message : 'Failed to commit undo',
            p.operationId,
            false
          );
        }
        break;
      }

      case 'operation.redo': {
        const p = msg.payload;
        try {
          const result = this.db.commitRedo(
            p.operationId,
            p.notebookId,
            p.pageId,
            p.targetOperationId
          );
          this.sendOperationAck(
            ws,
            p.operationId,
            p.pageId,
            'committed',
            result.duplicate,
            result.canUndo,
            result.canRedo
          );
          if (!result.duplicate) {
            this.broadcastDesktopEvent({
              event: 'page.updated',
              pageId: p.pageId,
              snapshot: this.db.getPageSnapshot(p.pageId),
            });
            this.broadcastMobileStateSync(ws);
          }
        } catch (err) {
          this.sendSessionError(
            ws,
            'INTERNAL_DB_ERROR',
            err instanceof Error ? err.message : 'Failed to commit redo',
            p.operationId,
            false
          );
        }
        break;
      }

      case 'page.select': {
        const p = msg.payload;
        this.db.ensurePageExists(p.notebookId, p.pageId);
        this.activeNotebookId = p.notebookId;
        this.activePageId = p.pageId;
        this.sendOperationAck(ws, p.operationId, p.pageId, 'committed', false);

        const snapshot = this.db.getPageSnapshot(p.pageId);
        this.broadcastDesktopEvent({
          event: 'page.selected',
          notebookId: p.notebookId,
          pageId: p.pageId,
          notebooks: this.db.listNotebooks(),
          snapshot,
        });
        this.broadcastMobileStateSync(ws);
        break;
      }
    }
  }

  private sendSessionStartSuccess(
    ws: WebSocket,
    sessionId: string,
    sessionResumeToken: string
  ): void {
    const notebooks = this.db.listNotebooks();
    const activePage =
      this.db.getPageSnapshot(this.activePageId) ??
      this.db.getPageSnapshot(notebooks[0]!.pages[0]!.id)!;

    const reply: ProtocolMessage = {
      type: 'session.start',
      timestamp: Date.now(),
      payload: {
        role: 'server',
        sessionId,
        sessionResumeToken,
        approved: true,
        activeNotebookId: this.activeNotebookId,
        activePageId: this.activePageId,
        notebooks,
        activePage,
      },
    };
    ws.send(serializeProtocolMessage(reply));
  }

  private sendOperationAck(
    ws: WebSocket,
    operationId: string,
    pageId: string,
    status: 'committed' | 'cancelled',
    duplicate: boolean,
    canUndo?: boolean,
    canRedo?: boolean
  ): void {
    const ack: ProtocolMessage = {
      type: 'operation.ack',
      timestamp: Date.now(),
      payload: {
        operationId,
        pageId,
        status,
        duplicate,
        serverTimestamp: Date.now(),
        ...(canUndo !== undefined ? { canUndo } : {}),
        ...(canRedo !== undefined ? { canRedo } : {}),
      },
    };
    ws.send(serializeProtocolMessage(ack));
  }

  private sendSessionError(
    ws: WebSocket,
    code: SessionErrorCode,
    message: string,
    relatedOperationId: string | null,
    fatal: boolean
  ): void {
    const errMsg: ProtocolMessage = {
      type: 'session.error',
      timestamp: Date.now(),
      payload: {
        code,
        message,
        relatedOperationId,
        fatal,
      },
    };
    ws.send(serializeProtocolMessage(errMsg));
  }

  private broadcastDesktopEvent(data: Record<string, unknown>): void {
    const serialized = JSON.stringify(data);
    for (const client of this.desktopUiClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  private broadcastMobileStateSync(excludeWs?: WebSocket): void {
    for (const [ws, ctx] of this.mobileClients.entries()) {
      if (ws === excludeWs) continue;
      if (ctx.authenticated && ctx.approved && ws.readyState === WebSocket.OPEN) {
        this.sendSessionStartSuccess(ws, ctx.sessionId, 'sync_update');
      }
    }
  }

  // ==========================================================================
  // API HTTP Local para Comandos do Desktop UI
  // ==========================================================================

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    const readJsonBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    };

    if (req.method === 'GET' && pathname === '/api/state') {
      sendJson(200, {
        status: this.getStatusSnapshot(),
        notebooks: this.db.listNotebooks(),
        activePage: this.db.getPageSnapshot(this.activePageId),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pairing/qr') {
      const body = await readJsonBody();
      if (typeof body.host === 'string' && body.host.length > 0) {
        this.selectedHost = body.host;
      }
      if (typeof body.requireExplicitApproval === 'boolean') {
        this.requireExplicitApproval = body.requireExplicitApproval;
      }
      const qr = this.generatePairingQrPayload();
      sendJson(200, { qr, status: this.getStatusSnapshot() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pairing/approve') {
      const body = await readJsonBody();
      const deviceId = String(body.deviceId ?? '');
      const approve = Boolean(body.approve);
      const ok = this.approvePendingDevice(deviceId, approve);
      sendJson(200, { ok, status: this.getStatusSnapshot() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/notebooks/create') {
      const body = await readJsonBody();
      const title = String(body.title ?? 'Novo Caderno');
      const id = typeof body.notebookId === 'string' && body.notebookId.length > 0 ? body.notebookId : `nb_${Date.now()}`;
      const nb = this.db.createNotebook(id, title);
      this.activeNotebookId = nb.id;
      this.activePageId = nb.pages[0]!.id;
      const allNotebooks = this.db.listNotebooks();
      const snapshot = this.db.getPageSnapshot(this.activePageId);
      this.broadcastDesktopEvent({
        event: 'page.selected',
        notebookId: this.activeNotebookId,
        pageId: this.activePageId,
        notebooks: allNotebooks,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, {
        notebooks: allNotebooks,
        activeNotebookId: this.activeNotebookId,
        activePageId: this.activePageId,
        activePage: snapshot,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/notebooks/delete') {
      const body = await readJsonBody();
      const notebookId = String(body.notebookId ?? '');
      this.db.deleteNotebook(notebookId);
      const allNotebooks = this.db.listNotebooks();
      const currentNb =
        allNotebooks.find((n) => n.id === this.activeNotebookId) ?? allNotebooks[0]!;
      this.activeNotebookId = currentNb.id;
      this.activePageId = currentNb.pages[0]!.id;
      const snapshot = this.db.getPageSnapshot(this.activePageId);
      this.broadcastDesktopEvent({
        event: 'page.selected',
        notebookId: this.activeNotebookId,
        pageId: this.activePageId,
        notebooks: allNotebooks,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, {
        notebooks: allNotebooks,
        activeNotebookId: this.activeNotebookId,
        activePageId: this.activePageId,
        activePage: snapshot,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pages/create') {
      const body = await readJsonBody();
      const notebookId = String(body.notebookId ?? this.activeNotebookId);
      const title = typeof body.title === 'string' ? body.title : undefined;
      const pageId = typeof body.pageId === 'string' && body.pageId.length > 0 ? body.pageId : `page_${Date.now()}`;
      const page = this.db.createPage(notebookId, pageId, title);
      this.activeNotebookId = notebookId;
      this.activePageId = page.id;
      const allNotebooks = this.db.listNotebooks();
      const snapshot = this.db.getPageSnapshot(this.activePageId);
      this.broadcastDesktopEvent({
        event: 'page.selected',
        notebookId: this.activeNotebookId,
        pageId: this.activePageId,
        notebooks: allNotebooks,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, {
        notebooks: allNotebooks,
        activeNotebookId: this.activeNotebookId,
        activePageId: this.activePageId,
        activePage: snapshot,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pages/delete') {
      const body = await readJsonBody();
      const pageId = String(body.pageId ?? '');
      this.db.deletePage(pageId);
      const allNotebooks = this.db.listNotebooks();
      const currentNb =
        allNotebooks.find((n) => n.id === this.activeNotebookId) ?? allNotebooks[0]!;
      this.activeNotebookId = currentNb.id;
      const pageStillExists = currentNb.pages.some((p) => p.id === this.activePageId);
      if (!pageStillExists) {
        this.activePageId = currentNb.pages[0]!.id;
      }
      const snapshot = this.db.getPageSnapshot(this.activePageId);
      this.broadcastDesktopEvent({
        event: 'page.selected',
        notebookId: this.activeNotebookId,
        pageId: this.activePageId,
        notebooks: allNotebooks,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, {
        notebooks: allNotebooks,
        activeNotebookId: this.activeNotebookId,
        activePageId: this.activePageId,
        activePage: snapshot,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pages/select') {
      const body = await readJsonBody();
      const notebookId = String(body.notebookId ?? this.activeNotebookId);
      const pageId = String(body.pageId ?? this.activePageId);
      this.db.ensurePageExists(notebookId, pageId);
      this.activeNotebookId = notebookId;
      this.activePageId = pageId;
      const allNotebooks = this.db.listNotebooks();
      const snapshot = this.db.getPageSnapshot(this.activePageId);
      this.broadcastDesktopEvent({
        event: 'page.selected',
        notebookId: this.activeNotebookId,
        pageId: this.activePageId,
        notebooks: allNotebooks,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, {
        notebooks: allNotebooks,
        activeNotebookId: this.activeNotebookId,
        activePageId: this.activePageId,
        activePage: snapshot,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pages/orientation') {
      const body = await readJsonBody();
      const pageId = String(body.pageId ?? this.activePageId);
      const width = Number(body.width ?? 1414.2135);
      const height = Number(body.height ?? 1000.0);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 100 && height > 100) {
        this.db.updatePageDimensions(pageId, width, height);
      }
      const allNotebooks = this.db.listNotebooks();
      const snapshot = this.db.getPageSnapshot(pageId);
      this.broadcastDesktopEvent({
        event: 'page.selected',
        notebookId: this.activeNotebookId,
        pageId,
        notebooks: allNotebooks,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, {
        notebooks: allNotebooks,
        activePage: snapshot,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pages/grid') {
      const body = await readJsonBody();
      const pageId = String(body.pageId ?? this.activePageId);
      const grid = body.grid as GridSettings;
      const bg = typeof body.backgroundColor === 'string' ? body.backgroundColor : undefined;
      this.db.updatePageGrid(pageId, grid, bg);
      const snapshot = this.db.getPageSnapshot(pageId);
      this.broadcastDesktopEvent({
        event: 'page.updated',
        pageId,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, { activePage: snapshot });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/operations/undo') {
      const body = await readJsonBody();
      const pageId = String(body.pageId ?? this.activePageId);
      const notebookId = String(body.notebookId ?? this.activeNotebookId);
      const opId = `op_desk_undo_${Date.now()}`;
      this.db.commitUndo(opId, notebookId, pageId);
      const snapshot = this.db.getPageSnapshot(pageId);
      this.broadcastDesktopEvent({
        event: 'page.updated',
        pageId,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, { activePage: snapshot });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/operations/redo') {
      const body = await readJsonBody();
      const pageId = String(body.pageId ?? this.activePageId);
      const notebookId = String(body.notebookId ?? this.activeNotebookId);
      const opId = `op_desk_redo_${Date.now()}`;
      this.db.commitRedo(opId, notebookId, pageId);
      const snapshot = this.db.getPageSnapshot(pageId);
      this.broadcastDesktopEvent({
        event: 'page.updated',
        pageId,
        snapshot,
      });
      this.broadcastMobileStateSync();
      sendJson(200, { activePage: snapshot });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/notebooks/export-data') {
      const notebookId = url.searchParams.get('notebookId') ?? this.activeNotebookId;
      const pagesMeta = this.db.listPagesForNotebook(notebookId);
      const pagesSnapshots: PageStateSnapshot[] = [];
      for (const pm of pagesMeta) {
        const snap = this.db.getPageSnapshot(pm.id);
        if (snap) pagesSnapshots.push(snap);
      }
      sendJson(200, { pages: pagesSnapshots });
      return;
    }

    sendJson(404, { error: 'Not found' });
  }
}
