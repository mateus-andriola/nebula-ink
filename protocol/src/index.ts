/**
 * Contratos do Protocolo WebSocket, Validação de Mensagens, Serialização
 * e Máquina de Estado de Operações Idempotentes + Desfazer/Refazer.
 */

export * from './geometry.ts';
export * from './inputModel.ts';

import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  SpatialGridIndex,
  type Stroke,
  type StrokePoint,
} from './geometry.ts';

export const MAX_MESSAGE_BYTES = 512 * 1024; // 512 KB
export const MAX_POINTS_PER_BATCH = 500;
export const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export interface GridSettings {
  enabled: boolean;
  spacing: number;
  color: string;
  opacity: number;
}

export const DEFAULT_GRID_SETTINGS: GridSettings = {
  enabled: true,
  spacing: 25,
  color: '#94A3B8',
  opacity: 0.45,
};

export interface PageMetadata {
  id: string;
  notebookId: string;
  pageIndex: number;
  title: string;
  width: number;
  height: number;
  backgroundColor: string;
  grid: GridSettings;
  createdAt: number;
  updatedAt: number;
}

export interface NotebookSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pages: PageMetadata[];
}

export interface PageStateSnapshot {
  metadata: PageMetadata;
  strokes: Stroke[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface PairingQrPayload {
  v: 1;
  host: string;
  candidates: string[];
  port: number;
  protocol: 'ws' | 'wss';
  pairingToken: string;
  expiresAt: number;
  certFingerprint?: string;
}

// ============================================================================
// Contratos Tipados das Mensagens do Protocolo
// ============================================================================

export type ProtocolMessageType =
  | 'session.start'
  | 'session.resume'
  | 'stroke.begin'
  | 'stroke.points'
  | 'stroke.end'
  | 'strokes.erase'
  | 'operation.undo'
  | 'operation.redo'
  | 'page.select'
  | 'operation.ack'
  | 'session.error';

export interface SessionStartClientPayload {
  role: 'client';
  pairingToken: string;
  deviceId: string;
  deviceName: string;
  clientVersion: string;
}

export interface SessionStartServerPayload {
  role: 'server';
  sessionId: string;
  sessionResumeToken: string;
  approved: boolean;
  activeNotebookId: string;
  activePageId: string;
  notebooks: NotebookSummary[];
  activePage: PageStateSnapshot;
}

export type SessionStartPayload = SessionStartClientPayload | SessionStartServerPayload;

export interface SessionResumePayload {
  sessionId: string;
  sessionResumeToken: string;
  deviceId: string;
  lastAckedOperationId?: string | null;
}

export interface StrokeBeginPayload {
  operationId: string;
  strokeId: string;
  notebookId: string;
  pageId: string;
  color: string;
  baseWidth: number;
  toolType: 'pen';
  startPoint: StrokePoint;
}

export interface StrokePointsPayload {
  strokeId: string;
  pageId: string;
  seq: number;
  points: StrokePoint[];
}

export interface StrokeEndPayload {
  operationId: string;
  notebookId: string;
  pageId: string;
  cancelled?: boolean;
  stroke: Stroke;
}

export interface StrokesErasePayload {
  operationId: string;
  notebookId: string;
  pageId: string;
  targetStrokeIds: string[];
  removedStrokes: Stroke[];
}

export interface OperationUndoPayload {
  operationId: string;
  notebookId: string;
  pageId: string;
  targetOperationId?: string;
}

export interface OperationRedoPayload {
  operationId: string;
  notebookId: string;
  pageId: string;
  targetOperationId?: string;
}

export interface PageSelectPayload {
  operationId: string;
  notebookId: string;
  pageId: string;
  pageSnapshot?: PageStateSnapshot;
}

export interface OperationAckPayload {
  operationId: string;
  pageId: string;
  status: 'committed' | 'cancelled';
  duplicate: boolean;
  serverTimestamp: number;
  canUndo?: boolean;
  canRedo?: boolean;
}

export type SessionErrorCode =
  | 'INVALID_MESSAGE_FORMAT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHORIZED'
  | 'INVALID_TOKEN'
  | 'PAIRING_TIMEOUT'
  | 'DEVICE_REJECTED'
  | 'INVALID_REFERENCE'
  | 'INTERNAL_DB_ERROR';

export interface SessionErrorPayload {
  code: SessionErrorCode;
  message: string;
  relatedOperationId?: string | null;
  fatal: boolean;
}

export type ProtocolMessage =
  | { type: 'session.start'; timestamp: number; payload: SessionStartPayload }
  | { type: 'session.resume'; timestamp: number; payload: SessionResumePayload }
  | { type: 'stroke.begin'; timestamp: number; payload: StrokeBeginPayload }
  | { type: 'stroke.points'; timestamp: number; payload: StrokePointsPayload }
  | { type: 'stroke.end'; timestamp: number; payload: StrokeEndPayload }
  | { type: 'strokes.erase'; timestamp: number; payload: StrokesErasePayload }
  | { type: 'operation.undo'; timestamp: number; payload: OperationUndoPayload }
  | { type: 'operation.redo'; timestamp: number; payload: OperationRedoPayload }
  | { type: 'page.select'; timestamp: number; payload: PageSelectPayload }
  | { type: 'operation.ack'; timestamp: number; payload: OperationAckPayload }
  | { type: 'session.error'; timestamp: number; payload: SessionErrorPayload };

// ============================================================================
// Validação e Serialização Segura
// ============================================================================

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isValidStrokePoint(pt: unknown): pt is StrokePoint {
  if (!pt || typeof pt !== 'object') return false;
  const p = pt as Record<string, unknown>;
  return (
    typeof p.x === 'number' &&
    Number.isFinite(p.x) &&
    typeof p.y === 'number' &&
    Number.isFinite(p.y) &&
    typeof p.pressure === 'number' &&
    Number.isFinite(p.pressure) &&
    p.pressure >= 0 &&
    p.pressure <= 1 &&
    typeof p.t === 'number' &&
    Number.isFinite(p.t) &&
    p.t >= 0
  );
}

export function isValidStroke(stroke: unknown): stroke is Stroke {
  if (!stroke || typeof stroke !== 'object') return false;
  const s = stroke as Record<string, unknown>;
  if (
    !isValidId(s.id) ||
    !isValidId(s.pageId) ||
    !isValidId(s.notebookId) ||
    typeof s.color !== 'string' ||
    !HEX_COLOR_PATTERN.test(s.color) ||
    typeof s.baseWidth !== 'number' ||
    !Number.isFinite(s.baseWidth) ||
    s.baseWidth <= 0 ||
    s.baseWidth > 200 ||
    s.toolType !== 'pen' ||
    !Array.isArray(s.points) ||
    s.points.length === 0
  ) {
    return false;
  }
  return s.points.every(isValidStrokePoint);
}

export interface ValidationResult {
  valid: boolean;
  message?: ProtocolMessage;
  errorCode?: SessionErrorCode;
  errorReason?: string;
}

export function serializeProtocolMessage(msg: ProtocolMessage): string {
  return JSON.stringify(msg);
}

export function parseAndValidateProtocolMessage(raw: string | Buffer): ValidationResult {
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (byteLength > MAX_MESSAGE_BYTES) {
    return {
      valid: false,
      errorCode: 'PAYLOAD_TOO_LARGE',
      errorReason: `Message size (${byteLength} bytes) exceeds limit (${MAX_MESSAGE_BYTES} bytes).`,
    };
  }

  let parsed: unknown;
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    return {
      valid: false,
      errorCode: 'INVALID_MESSAGE_FORMAT',
      errorReason: 'Invalid JSON syntax.',
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      valid: false,
      errorCode: 'INVALID_MESSAGE_FORMAT',
      errorReason: 'Message root must be an object.',
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string' || typeof obj.timestamp !== 'number' || !Number.isFinite(obj.timestamp)) {
    return {
      valid: false,
      errorCode: 'INVALID_MESSAGE_FORMAT',
      errorReason: 'Missing or invalid type or timestamp.',
    };
  }

  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') {
    return {
      valid: false,
      errorCode: 'INVALID_MESSAGE_FORMAT',
      errorReason: 'Missing payload object.',
    };
  }

  switch (obj.type) {
    case 'session.start': {
      if (payload.role === 'client') {
        if (
          typeof payload.pairingToken !== 'string' ||
          payload.pairingToken.length < 4 ||
          !isValidId(payload.deviceId) ||
          typeof payload.deviceName !== 'string'
        ) {
          return {
            valid: false,
            errorCode: 'INVALID_MESSAGE_FORMAT',
            errorReason: 'Invalid session.start client payload.',
          };
        }
      } else if (payload.role === 'server') {
        if (!isValidId(payload.sessionId) || typeof payload.sessionResumeToken !== 'string') {
          return {
            valid: false,
            errorCode: 'INVALID_MESSAGE_FORMAT',
            errorReason: 'Invalid session.start server payload.',
          };
        }
      } else {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'session.start payload requires role ("client" | "server").',
        };
      }
      break;
    }

    case 'session.resume': {
      if (
        !isValidId(payload.sessionId) ||
        typeof payload.sessionResumeToken !== 'string' ||
        !isValidId(payload.deviceId)
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid session.resume payload.',
        };
      }
      break;
    }

    case 'stroke.begin': {
      if (
        !isValidId(payload.operationId) ||
        !isValidId(payload.strokeId) ||
        !isValidId(payload.notebookId) ||
        !isValidId(payload.pageId) ||
        typeof payload.color !== 'string' ||
        !HEX_COLOR_PATTERN.test(payload.color) ||
        typeof payload.baseWidth !== 'number' ||
        payload.baseWidth <= 0 ||
        !isValidStrokePoint(payload.startPoint)
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid stroke.begin payload.',
        };
      }
      break;
    }

    case 'stroke.points': {
      if (
        !isValidId(payload.strokeId) ||
        !isValidId(payload.pageId) ||
        typeof payload.seq !== 'number' ||
        !Number.isInteger(payload.seq) ||
        payload.seq < 0 ||
        !Array.isArray(payload.points) ||
        payload.points.length === 0 ||
        payload.points.length > MAX_POINTS_PER_BATCH ||
        !payload.points.every(isValidStrokePoint)
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid stroke.points payload.',
        };
      }
      break;
    }

    case 'stroke.end': {
      if (
        !isValidId(payload.operationId) ||
        !isValidId(payload.notebookId) ||
        !isValidId(payload.pageId) ||
        !isValidStroke(payload.stroke)
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid stroke.end payload.',
        };
      }
      break;
    }

    case 'strokes.erase': {
      if (
        !isValidId(payload.operationId) ||
        !isValidId(payload.notebookId) ||
        !isValidId(payload.pageId) ||
        !Array.isArray(payload.targetStrokeIds) ||
        payload.targetStrokeIds.length === 0 ||
        !payload.targetStrokeIds.every(isValidId) ||
        !Array.isArray(payload.removedStrokes) ||
        !payload.removedStrokes.every(isValidStroke)
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid strokes.erase payload.',
        };
      }
      break;
    }

    case 'operation.undo':
    case 'operation.redo': {
      if (
        !isValidId(payload.operationId) ||
        !isValidId(payload.notebookId) ||
        !isValidId(payload.pageId) ||
        (payload.targetOperationId !== undefined && !isValidId(payload.targetOperationId))
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: `Invalid ${obj.type} payload.`,
        };
      }
      break;
    }

    case 'page.select': {
      if (
        !isValidId(payload.operationId) ||
        !isValidId(payload.notebookId) ||
        !isValidId(payload.pageId)
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid page.select payload.',
        };
      }
      break;
    }

    case 'operation.ack': {
      if (
        !isValidId(payload.operationId) ||
        !isValidId(payload.pageId) ||
        (payload.status !== 'committed' && payload.status !== 'cancelled') ||
        typeof payload.duplicate !== 'boolean'
      ) {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid operation.ack payload.',
        };
      }
      break;
    }

    case 'session.error': {
      if (typeof payload.code !== 'string' || typeof payload.message !== 'string') {
        return {
          valid: false,
          errorCode: 'INVALID_MESSAGE_FORMAT',
          errorReason: 'Invalid session.error payload.',
        };
      }
      break;
    }

    default:
      return {
        valid: false,
        errorCode: 'INVALID_MESSAGE_FORMAT',
        errorReason: `Unsupported message type: ${String(obj.type)}`,
      };
  }

  return {
    valid: true,
    message: obj as unknown as ProtocolMessage,
  };
}

// ============================================================================
// Gerenciador de Estado de Página, Idempotência e Histórico Desfazer/Refazer
// ============================================================================

export type ReversibleAction =
  | {
      kind: 'add_stroke';
      operationId: string;
      stroke: Stroke;
    }
  | {
      kind: 'erase_strokes';
      operationId: string;
      targetStrokeIds: string[];
      removedStrokes: Stroke[];
    };

/**
 * Mantém o modelo em memória de uma página (com índice espacial, pilha de undo/redo
 * e deduplicação idempotente de operationId).
 */
export class PageDocumentEngine {
  public readonly metadata: PageMetadata;
  public readonly spatialIndex = new SpatialGridIndex();
  private readonly strokesOrder: string[] = [];
  private readonly strokesMap = new Map<string, Stroke>();
  private readonly processedOperationIds = new Set<string>();
  private readonly undoStack: ReversibleAction[] = [];
  private readonly redoStack: ReversibleAction[] = [];

  constructor(metadata?: Partial<PageMetadata>) {
    const now = Date.now();
    this.metadata = {
      id: metadata?.id ?? 'page_default_1',
      notebookId: metadata?.notebookId ?? 'nb_default',
      pageIndex: metadata?.pageIndex ?? 0,
      title: metadata?.title ?? 'Página 1',
      width: metadata?.width ?? DEFAULT_PAGE_WIDTH,
      height: metadata?.height ?? DEFAULT_PAGE_HEIGHT,
      backgroundColor: metadata?.backgroundColor ?? '#FFFFFF',
      grid: metadata?.grid ?? { ...DEFAULT_GRID_SETTINGS },
      createdAt: metadata?.createdAt ?? now,
      updatedAt: metadata?.updatedAt ?? now,
    };
  }

  public hasProcessed(operationId: string): boolean {
    return this.processedOperationIds.has(operationId);
  }

  public applyAddStroke(operationId: string, stroke: Stroke): { applied: boolean; duplicate: boolean } {
    if (this.processedOperationIds.has(operationId)) {
      return { applied: false, duplicate: true };
    }
    this.processedOperationIds.add(operationId);

    this.insertStrokeInternal(stroke);
    this.undoStack.push({
      kind: 'add_stroke',
      operationId,
      stroke,
    });
    this.redoStack.length = 0;
    return { applied: true, duplicate: false };
  }

  public applyEraseStrokes(
    operationId: string,
    targetStrokeIds: string[],
    removedStrokesFallback: Stroke[] = []
  ): { applied: boolean; duplicate: boolean; removed: Stroke[] } {
    if (this.processedOperationIds.has(operationId)) {
      return { applied: false, duplicate: true, removed: [] };
    }
    this.processedOperationIds.add(operationId);

    const removed: Stroke[] = [];
    const fallbackMap = new Map(removedStrokesFallback.map((s) => [s.id, s]));

    for (const strokeId of targetStrokeIds) {
      const existing = this.strokesMap.get(strokeId) ?? fallbackMap.get(strokeId);
      if (existing) {
        removed.push(existing);
      }
      this.removeStrokeInternal(strokeId);
    }

    if (removed.length > 0) {
      this.undoStack.push({
        kind: 'erase_strokes',
        operationId,
        targetStrokeIds: [...targetStrokeIds],
        removedStrokes: removed,
      });
      this.redoStack.length = 0;
    }

    return { applied: true, duplicate: false, removed };
  }

  public applyUndo(
    operationId: string,
    targetOperationId?: string
  ): { applied: boolean; duplicate: boolean; undoneAction?: ReversibleAction } {
    if (this.processedOperationIds.has(operationId)) {
      return { applied: false, duplicate: true };
    }
    this.processedOperationIds.add(operationId);

    if (this.undoStack.length === 0) {
      return { applied: false, duplicate: false };
    }

    let actionIndex = this.undoStack.length - 1;
    if (targetOperationId) {
      const foundIdx = this.undoStack.findIndex((a) => a.operationId === targetOperationId);
      if (foundIdx === -1) {
        return { applied: false, duplicate: false };
      }
      actionIndex = foundIdx;
    }

    const [action] = this.undoStack.splice(actionIndex, 1);
    if (!action) {
      return { applied: false, duplicate: false };
    }

    if (action.kind === 'add_stroke') {
      this.removeStrokeInternal(action.stroke.id);
    } else if (action.kind === 'erase_strokes') {
      for (const stroke of action.removedStrokes) {
        this.insertStrokeInternal(stroke);
      }
    }

    this.redoStack.push(action);
    return { applied: true, duplicate: false, undoneAction: action };
  }

  public applyRedo(
    operationId: string,
    targetOperationId?: string
  ): { applied: boolean; duplicate: boolean; redoneAction?: ReversibleAction } {
    if (this.processedOperationIds.has(operationId)) {
      return { applied: false, duplicate: true };
    }
    this.processedOperationIds.add(operationId);

    if (this.redoStack.length === 0) {
      return { applied: false, duplicate: false };
    }

    let actionIndex = this.redoStack.length - 1;
    if (targetOperationId) {
      const foundIdx = this.redoStack.findIndex((a) => a.operationId === targetOperationId);
      if (foundIdx === -1) {
        return { applied: false, duplicate: false };
      }
      actionIndex = foundIdx;
    }

    const [action] = this.redoStack.splice(actionIndex, 1);
    if (!action) {
      return { applied: false, duplicate: false };
    }

    if (action.kind === 'add_stroke') {
      this.insertStrokeInternal(action.stroke);
    } else if (action.kind === 'erase_strokes') {
      for (const id of action.targetStrokeIds) {
        this.removeStrokeInternal(id);
      }
    }

    this.undoStack.push(action);
    return { applied: true, duplicate: false, redoneAction: action };
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public getStrokes(): Stroke[] {
    const result: Stroke[] = [];
    for (const id of this.strokesOrder) {
      const s = this.strokesMap.get(id);
      if (s) result.push(s);
    }
    return result;
  }

  public getSnapshot(): PageStateSnapshot {
    return {
      metadata: { ...this.metadata, grid: { ...this.metadata.grid } },
      strokes: this.getStrokes(),
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }

  private insertStrokeInternal(stroke: Stroke): void {
    if (!this.strokesMap.has(stroke.id)) {
      this.strokesOrder.push(stroke.id);
    }
    this.strokesMap.set(stroke.id, stroke);
    this.spatialIndex.insert(stroke);
  }

  private removeStrokeInternal(strokeId: string): void {
    this.strokesMap.delete(strokeId);
    const idx = this.strokesOrder.indexOf(strokeId);
    if (idx !== -1) {
      this.strokesOrder.splice(idx, 1);
    }
    this.spatialIndex.remove(strokeId);
  }
}
