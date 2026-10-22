/**
 * Modelo de Entrada, Roteador de MotionEvent, Classificador de Ferramenta,
 * Política de Rejeição de Palma e Coordenador de Gestos (S Pen vs. Dedo).
 */

import {
  SpatialGridIndex,
  type Stroke,
  type StrokePoint,
  type ViewportTransform,
  WholeStrokeEraserSession,
  applyPinchZoom,
  createDefaultViewport,
  screenToLogical,
} from './geometry.ts';

export type FingerMode = 'both' | 'vertical' | 'horizontal' | 'none';
export type ScrollMode = 'free' | 'axisLocked';
export type ActiveUiTool = 'pen' | 'eraser';

export interface InputPreferences {
  fingerMode: FingerMode;
  scrollMode: ScrollMode;
  palmRejection: boolean;
  pinchZoom: boolean;
}

export const DEFAULT_INPUT_PREFERENCES: InputPreferences = {
  fingerMode: 'both',
  scrollMode: 'free',
  palmRejection: true,
  pinchZoom: true,
};

export type NativeToolType = 'stylus' | 'eraser' | 'finger' | 'unknown';
export type ResolvedInputRole = 'stylus_pen' | 'stylus_eraser' | 'finger_gesture' | 'ignored';

export type MotionAction =
  | 'ACTION_DOWN'
  | 'ACTION_POINTER_DOWN'
  | 'ACTION_MOVE'
  | 'ACTION_POINTER_UP'
  | 'ACTION_UP'
  | 'ACTION_CANCEL'
  | 'ACTION_HOVER_MOVE';

export interface HistoricalSample {
  screenX: number;
  screenY: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  orientation?: number;
  eventTimeMs: number;
}

export interface PointerSample {
  pointerId: number;
  toolType: NativeToolType;
  screenX: number;
  screenY: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  orientation?: number;
  /** Botão físico lateral da S Pen (MotionEvent.BUTTON_STYLUS_PRIMARY) */
  stylusButtonPressed: boolean;
  historicalSamples?: HistoricalSample[];
}

export interface RawMotionEvent {
  action: MotionAction;
  actionPointerId?: number;
  eventTimeMs: number;
  downTimeMs: number;
  /** MotionEvent.FLAG_CANCELED */
  flagCanceled?: boolean;
  pointers: PointerSample[];
}

export interface EraseOperationRecord {
  operationId: string;
  notebookId: string;
  pageId: string;
  targetStrokeIds: string[];
  removedStrokes: Stroke[];
  timestamp: number;
}

export interface InputEngineCallbacks {
  onProvisionalStrokeBegin?: (stroke: Stroke) => void;
  onProvisionalStrokeUpdate?: (strokeId: string, newPoints: StrokePoint[]) => void;
  onProvisionalStrokeCancel?: (strokeId: string) => void;
  onStrokeCommit?: (stroke: Stroke, operationId: string) => void;
  onStrokesErased?: (eraseOp: EraseOperationRecord) => void;
  onViewportChanged?: (viewport: ViewportTransform) => void;
  onHoverToolPreview?: (role: ResolvedInputRole, logicalX: number, logicalY: number) => void;
}

/**
 * Classifica explicitamente a ferramenta de entrada antes de qualquer processamento.
 * Regra prioritária:
 * - Dedo ('finger') NUNCA desenha nem apaga.
 * - S Pen com botão lateral pressionado (stylusButtonPressed) ou toolType === 'eraser' -> 'stylus_eraser'.
 * - S Pen com botão solto -> 'stylus_pen' (ou 'stylus_eraser' se o usuário selecionou borracha na UI).
 */
export function classifyPointerRole(
  pointer: PointerSample,
  activeUiTool: ActiveUiTool
): ResolvedInputRole {
  if (pointer.toolType === 'finger') {
    return 'finger_gesture';
  }
  if (pointer.toolType === 'eraser') {
    return 'stylus_eraser';
  }
  if (pointer.toolType === 'stylus') {
    if (pointer.stylusButtonPressed || activeUiTool === 'eraser') {
      return 'stylus_eraser';
    }
    return 'stylus_pen';
  }
  return 'ignored';
}

/**
 * Coordenador completo de Entrada (S Pen, Borracha por Traço Inteiro, Rejeição de Palma e Gestos de Dedo).
 */
export class NotebookInputController {
  private preferences: InputPreferences = { ...DEFAULT_INPUT_PREFERENCES };
  private viewport: ViewportTransform = createDefaultViewport();
  private activeUiTool: ActiveUiTool = 'pen';
  private penColor = '#111827';
  private penBaseWidth = 3.5;
  private notebookId: string;
  private pageId: string;

  private readonly spatialIndex: SpatialGridIndex;
  private readonly eraserSession: WholeStrokeEraserSession;
  private readonly callbacks: InputEngineCallbacks;
  private idCounter = 0;

  // Estado provisório da S Pen (para rejeição de palma e cancelamento seguro)
  private activeStylusPointerId: number | null = null;
  private activeStylusRole: 'stylus_pen' | 'stylus_eraser' | null = null;
  private provisionalStroke: Stroke | null = null;
  private strokeDownTimeMs = 0;
  private lastHoverTimeMs = -10000;

  // Estado de gestos de dedo (Scroll 1 dedo e Pinça 2 dedos)
  private activeFingerPointers = new Map<number, { x: number; y: number }>();
  private initialFingerOrigin = new Map<number, { x: number; y: number }>();
  private lockedAxis: 'x' | 'y' | null = null;
  private lastPinchDistance: number | null = null;
  private lastPinchCenter: { x: number; y: number } | null = null;

  constructor(options: {
    notebookId: string;
    pageId: string;
    spatialIndex: SpatialGridIndex;
    eraserRadius?: number;
    preferences?: Partial<InputPreferences>;
    viewport?: ViewportTransform;
    callbacks?: InputEngineCallbacks;
  }) {
    this.notebookId = options.notebookId;
    this.pageId = options.pageId;
    this.spatialIndex = options.spatialIndex;
    this.eraserSession = new WholeStrokeEraserSession(
      this.spatialIndex,
      options.eraserRadius ?? 14.0
    );
    if (options.preferences) {
      this.preferences = { ...this.preferences, ...options.preferences };
    }
    if (options.viewport) {
      this.viewport = { ...options.viewport };
    }
    this.callbacks = options.callbacks ?? {};
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${Date.now()}_${this.idCounter}`;
  }

  public updatePreferences(newPrefs: Partial<InputPreferences>): void {
    this.preferences = { ...this.preferences, ...newPrefs };
    if (this.preferences.scrollMode === 'free') {
      this.lockedAxis = null;
    }
  }

  public getPreferences(): InputPreferences {
    return { ...this.preferences };
  }

  public setActiveUiTool(tool: ActiveUiTool): void {
    this.activeUiTool = tool;
  }

  public getActiveUiTool(): ActiveUiTool {
    return this.activeUiTool;
  }

  public setPenStyle(color: string, baseWidth: number): void {
    this.penColor = color;
    this.penBaseWidth = Math.max(0.5, baseWidth);
  }

  public setEraserRadius(radius: number): void {
    this.eraserSession.setEraserRadius(radius);
  }

  public setPageContext(notebookId: string, pageId: string): void {
    this.cancelAnyActiveInteractions();
    this.notebookId = notebookId;
    this.pageId = pageId;
  }

  public getViewport(): ViewportTransform {
    return { ...this.viewport };
  }

  public setViewport(viewport: ViewportTransform): void {
    this.viewport = { ...viewport };
    this.callbacks.onViewportChanged?.(this.getViewport());
  }

  public getProvisionalStroke(): Stroke | null {
    return this.provisionalStroke;
  }

  /**
   * Processa qualquer evento de entrada respeitando a separação estrita de ferramentas,
   * histórico de amostras e sinais de cancelamento (ACTION_CANCEL / FLAG_CANCELED).
   */
  public handleMotionEvent(event: RawMotionEvent): void {
    // 1. Verificar sinais de cancelamento do Android (Rejeição de Palma / Sistema)
    if (event.action === 'ACTION_CANCEL' || event.flagCanceled === true) {
      this.cancelAnyActiveInteractions();
      return;
    }

    // 2. Verificar se há um ponteiro de S Pen ou Borracha no evento
    const stylusPointer = event.pointers.find(
      (p) => p.toolType === 'stylus' || p.toolType === 'eraser'
    );

    if (event.action === 'ACTION_HOVER_MOVE' && stylusPointer) {
      this.lastHoverTimeMs = event.eventTimeMs;
      const role = classifyPointerRole(stylusPointer, this.activeUiTool);
      const logical = screenToLogical(stylusPointer.screenX, stylusPointer.screenY, this.viewport);
      this.callbacks.onHoverToolPreview?.(role, logical.x, logical.y);
      // Quando a S Pen entra em hover e palmRejection está ativo, interrompemos gestos de dedo em andamento
      if (this.preferences.palmRejection && this.activeFingerPointers.size > 0) {
        this.resetFingerGestureState();
      }
      return;
    }

    // Se a S Pen está presente, ela tem prioridade absoluta sobre toques de dedo (Rejeição de Palma)
    if (stylusPointer) {
      if (this.preferences.palmRejection && this.activeFingerPointers.size > 0) {
        this.resetFingerGestureState();
      }
      this.handleStylusEvent(event, stylusPointer);
      return;
    }

    // 3. Se um traço de S Pen já está ativo ou em hover recente (<150ms com palmRejection),
    // bloqueia gestos de dedo concorrentes (palma apoiada)
    if (
      this.activeStylusPointerId !== null ||
      (this.preferences.palmRejection && event.eventTimeMs - this.lastHoverTimeMs < 150)
    ) {
      return;
    }

    // 4. Processar gestos de dedo (Scroll / Zoom por pinça) — Dedo NUNCA desenha nem apaga
    this.handleFingerEvent(event);
  }

  private handleStylusEvent(event: RawMotionEvent, pointer: PointerSample): void {
    const currentRole = classifyPointerRole(pointer, this.activeUiTool);
    if (currentRole !== 'stylus_pen' && currentRole !== 'stylus_eraser') {
      return;
    }

    if (event.action === 'ACTION_DOWN' || event.action === 'ACTION_POINTER_DOWN') {
      this.activeStylusPointerId = pointer.pointerId;
      this.activeStylusRole = currentRole;
      this.strokeDownTimeMs = event.downTimeMs || event.eventTimeMs;

      if (currentRole === 'stylus_pen') {
        const startPt = this.toLogicalStrokePoint(
          pointer.screenX,
          pointer.screenY,
          pointer.pressure,
          pointer.tiltX,
          pointer.tiltY,
          pointer.orientation,
          event.eventTimeMs
        );
        const stroke: Stroke = {
          id: this.nextId('stk'),
          notebookId: this.notebookId,
          pageId: this.pageId,
          color: this.penColor,
          baseWidth: this.penBaseWidth,
          toolType: 'pen',
          points: [startPt],
          createdAt: event.eventTimeMs,
        };
        this.provisionalStroke = stroke;
        this.callbacks.onProvisionalStrokeBegin?.({
          ...stroke,
          points: [...stroke.points],
        });
      } else {
        // Modo borracha por traço inteiro (botão lateral da S Pen pressionado ou ferramenta borracha)
        const logical = screenToLogical(pointer.screenX, pointer.screenY, this.viewport);
        const removed = this.eraserSession.beginPass(logical.x, logical.y);
        this.emitErasedStrokes(removed, event.eventTimeMs);
      }
      return;
    }

    if (event.action === 'ACTION_MOVE') {
      // Se o botão lateral da S Pen foi pressionado no meio de um movimento ou solto:
      if (this.activeStylusRole === null) {
        this.activeStylusPointerId = pointer.pointerId;
        this.activeStylusRole = currentRole;
      }

      // Caso o usuário tenha pressionado o botão lateral durante um traço provisório,
      // descartamos o traço provisório e mudamos para borracha sem deixar tinta residual
      if (this.activeStylusRole === 'stylus_pen' && currentRole === 'stylus_eraser') {
        if (this.provisionalStroke) {
          const cancelledId = this.provisionalStroke.id;
          this.provisionalStroke = null;
          this.callbacks.onProvisionalStrokeCancel?.(cancelledId);
        }
        this.activeStylusRole = 'stylus_eraser';
        const logical = screenToLogical(pointer.screenX, pointer.screenY, this.viewport);
        const removed = this.eraserSession.beginPass(logical.x, logical.y);
        this.emitErasedStrokes(removed, event.eventTimeMs);
        return;
      }

      const samples: HistoricalSample[] = [
        ...(pointer.historicalSamples ?? []),
        {
          screenX: pointer.screenX,
          screenY: pointer.screenY,
          pressure: pointer.pressure,
          tiltX: pointer.tiltX,
          tiltY: pointer.tiltY,
          orientation: pointer.orientation,
          eventTimeMs: event.eventTimeMs,
        },
      ];

      if (this.activeStylusRole === 'stylus_pen' && this.provisionalStroke) {
        const addedPoints: StrokePoint[] = [];
        for (const s of samples) {
          const pt = this.toLogicalStrokePoint(
            s.screenX,
            s.screenY,
            s.pressure,
            s.tiltX,
            s.tiltY,
            s.orientation,
            s.eventTimeMs
          );
          this.provisionalStroke.points.push(pt);
          addedPoints.push(pt);
        }
        if (addedPoints.length > 0) {
          this.callbacks.onProvisionalStrokeUpdate?.(this.provisionalStroke.id, addedPoints);
        }
      } else if (this.activeStylusRole === 'stylus_eraser') {
        const newlyRemoved: Stroke[] = [];
        for (const s of samples) {
          const logical = screenToLogical(s.screenX, s.screenY, this.viewport);
          const erased = this.eraserSession.stepTo(logical.x, logical.y);
          if (erased.length > 0) {
            newlyRemoved.push(...erased);
          }
        }
        this.emitErasedStrokes(newlyRemoved, event.eventTimeMs);
      }
      return;
    }

    if (event.action === 'ACTION_UP' || event.action === 'ACTION_POINTER_UP') {
      if (this.activeStylusRole === 'stylus_pen' && this.provisionalStroke) {
        const pt = this.toLogicalStrokePoint(
          pointer.screenX,
          pointer.screenY,
          pointer.pressure,
          pointer.tiltX,
          pointer.tiltY,
          pointer.orientation,
          event.eventTimeMs
        );
        const lastPt = this.provisionalStroke.points[this.provisionalStroke.points.length - 1];
        if (!lastPt || Math.hypot(lastPt.x - pt.x, lastPt.y - pt.y) > 0.01) {
          this.provisionalStroke.points.push(pt);
        }
        const committedStroke: Stroke = {
          ...this.provisionalStroke,
          points: [...this.provisionalStroke.points],
        };
        this.provisionalStroke = null;
        this.spatialIndex.insert(committedStroke);
        const opId = this.nextId('op_stk');
        this.callbacks.onStrokeCommit?.(committedStroke, opId);
      } else if (this.activeStylusRole === 'stylus_eraser') {
        const logical = screenToLogical(pointer.screenX, pointer.screenY, this.viewport);
        const removed = this.eraserSession.stepTo(logical.x, logical.y);
        this.emitErasedStrokes(removed, event.eventTimeMs);
        this.eraserSession.endPass();
      }

      this.activeStylusPointerId = null;
      this.activeStylusRole = null;
    }
  }

  private handleFingerEvent(event: RawMotionEvent): void {
    const fingerPointers = event.pointers.filter((p) => p.toolType === 'finger');
    if (fingerPointers.length === 0) {
      return;
    }

    if (event.action === 'ACTION_DOWN' || event.action === 'ACTION_POINTER_DOWN') {
      for (const fp of fingerPointers) {
        this.activeFingerPointers.set(fp.pointerId, { x: fp.screenX, y: fp.screenY });
        if (!this.initialFingerOrigin.has(fp.pointerId)) {
          this.initialFingerOrigin.set(fp.pointerId, { x: fp.screenX, y: fp.screenY });
        }
      }
      this.lockedAxis = null;
      if (fingerPointers.length >= 2) {
        const p1 = fingerPointers[0]!;
        const p2 = fingerPointers[1]!;
        this.lastPinchDistance = Math.hypot(p2.screenX - p1.screenX, p2.screenY - p1.screenY);
        this.lastPinchCenter = {
          x: (p1.screenX + p2.screenX) * 0.5,
          y: (p1.screenY + p2.screenY) * 0.5,
        };
      }
      return;
    }

    if (event.action === 'ACTION_MOVE') {
      // Pinça com 2 dedos
      if (fingerPointers.length >= 2) {
        const p1 = fingerPointers[0]!;
        const p2 = fingerPointers[1]!;
        const currentDist = Math.hypot(p2.screenX - p1.screenX, p2.screenY - p1.screenY);
        const currentCenter = {
          x: (p1.screenX + p2.screenX) * 0.5,
          y: (p1.screenY + p2.screenY) * 0.5,
        };

        if (
          this.preferences.pinchZoom &&
          this.lastPinchDistance !== null &&
          this.lastPinchDistance > 5 &&
          this.lastPinchCenter !== null
        ) {
          const scaleFactor = currentDist / this.lastPinchDistance;
          const rawPanX = currentCenter.x - this.lastPinchCenter.x;
          const rawPanY = currentCenter.y - this.lastPinchCenter.y;
          const filteredPan = this.filterScrollDelta(rawPanX, rawPanY);

          this.viewport = applyPinchZoom(
            this.viewport,
            scaleFactor,
            currentCenter.x,
            currentCenter.y,
            filteredPan.dx,
            filteredPan.dy
          );
          this.callbacks.onViewportChanged?.(this.getViewport());
        }

        this.lastPinchDistance = currentDist;
        this.lastPinchCenter = currentCenter;
        for (const fp of fingerPointers) {
          this.activeFingerPointers.set(fp.pointerId, { x: fp.screenX, y: fp.screenY });
        }
        return;
      }

      // Scroll com 1 dedo
      const fp = fingerPointers[0]!;
      const prev = this.activeFingerPointers.get(fp.pointerId);
      this.activeFingerPointers.set(fp.pointerId, { x: fp.screenX, y: fp.screenY });

      if (!prev || this.preferences.fingerMode === 'none') {
        return;
      }

      const rawDx = fp.screenX - prev.x;
      const rawDy = fp.screenY - prev.y;

      // Determinar bloqueio de eixo se scrollMode === 'axisLocked'
      if (this.preferences.scrollMode === 'axisLocked' && this.lockedAxis === null) {
        const origin = this.initialFingerOrigin.get(fp.pointerId) ?? prev;
        const totalDx = Math.abs(fp.screenX - origin.x);
        const totalDy = Math.abs(fp.screenY - origin.y);
        if (totalDx > 6 || totalDy > 6) {
          this.lockedAxis = totalDx >= totalDy ? 'x' : 'y';
        }
      }

      const { dx, dy } = this.filterScrollDelta(rawDx, rawDy);
      if (dx !== 0 || dy !== 0) {
        this.viewport = {
          ...this.viewport,
          panX: this.viewport.panX + dx,
          panY: this.viewport.panY + dy,
        };
        this.callbacks.onViewportChanged?.(this.getViewport());
      }
      return;
    }

    if (event.action === 'ACTION_POINTER_UP' || event.action === 'ACTION_UP') {
      if (event.action === 'ACTION_UP') {
        this.resetFingerGestureState();
      } else if (event.actionPointerId !== undefined) {
        this.activeFingerPointers.delete(event.actionPointerId);
        this.initialFingerOrigin.delete(event.actionPointerId);
        this.lastPinchDistance = null;
        this.lastPinchCenter = null;
      }
    }
  }

  private filterScrollDelta(rawDx: number, rawDy: number): { dx: number; dy: number } {
    if (this.preferences.fingerMode === 'none') {
      return { dx: 0, dy: 0 };
    }

    let dx = rawDx;
    let dy = rawDy;

    if (this.preferences.fingerMode === 'horizontal') {
      dy = 0;
    } else if (this.preferences.fingerMode === 'vertical') {
      dx = 0;
    }

    if (this.preferences.scrollMode === 'axisLocked' && this.lockedAxis !== null) {
      if (this.lockedAxis === 'x') {
        dy = 0;
      } else {
        dx = 0;
      }
    }

    return { dx, dy };
  }

  private toLogicalStrokePoint(
    screenX: number,
    screenY: number,
    pressure: number,
    tiltX: number | undefined,
    tiltY: number | undefined,
    orientation: number | undefined,
    eventTimeMs: number
  ): StrokePoint {
    const logical = screenToLogical(screenX, screenY, this.viewport);
    const clampedPressure = Math.max(0.01, Math.min(1.0, Number.isFinite(pressure) ? pressure : 0.5));
    return {
      x: Number(logical.x.toFixed(3)),
      y: Number(logical.y.toFixed(3)),
      pressure: Number(clampedPressure.toFixed(4)),
      ...(tiltX !== undefined ? { tiltX } : {}),
      ...(tiltY !== undefined ? { tiltY } : {}),
      ...(orientation !== undefined ? { orientation } : {}),
      t: Math.max(0, Math.round(eventTimeMs - this.strokeDownTimeMs)),
    };
  }

  private emitErasedStrokes(removed: Stroke[], timestamp: number): void {
    if (removed.length === 0) return;
    const eraseOp: EraseOperationRecord = {
      operationId: this.nextId('op_erase'),
      notebookId: this.notebookId,
      pageId: this.pageId,
      targetStrokeIds: removed.map((s) => s.id),
      removedStrokes: removed,
      timestamp,
    };
    this.callbacks.onStrokesErased?.(eraseOp);
  }

  private cancelAnyActiveInteractions(): void {
    if (this.provisionalStroke) {
      const cancelledId = this.provisionalStroke.id;
      this.provisionalStroke = null;
      this.callbacks.onProvisionalStrokeCancel?.(cancelledId);
    }
    this.eraserSession.endPass();
    this.activeStylusPointerId = null;
    this.activeStylusRole = null;
    this.resetFingerGestureState();
  }

  private resetFingerGestureState(): void {
    this.activeFingerPointers.clear();
    this.initialFingerOrigin.clear();
    this.lockedAxis = null;
    this.lastPinchDistance = null;
    this.lastPinchCenter = null;
  }
}
