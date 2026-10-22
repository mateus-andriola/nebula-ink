/**
 * Modelo Geométrico Vetorial, Conversão de Coordenadas, Índice Espacial (Grade Uniforme)
 * e Algoritmo de Borracha por Traço Inteiro.
 */

export const DEFAULT_PAGE_WIDTH = 1000.0;
export const DEFAULT_PAGE_HEIGHT = 1414.2135; // Proporção ISO A4 (1 : sqrt(2))
export const DEFAULT_SPATIAL_CELL_SIZE = 50.0;

export type StrokeToolType = 'pen';

export interface StrokePoint {
  /** Coordenada X lógica (0..pageWidth) */
  x: number;
  /** Coordenada Y lógica (0..pageHeight) */
  y: number;
  /** Pressão normalizada da S Pen [0.0 .. 1.0] */
  pressure: number;
  /** Inclinação no eixo X (graus ou radianos, opcional) */
  tiltX?: number;
  /** Inclinação no eixo Y (graus ou radianos, opcional) */
  tiltY?: number;
  /** Orientação azimutal da caneta (opcional) */
  orientation?: number;
  /** Timestamp relativo ao início do traço em milissegundos */
  t: number;
}

export interface Stroke {
  id: string;
  pageId: string;
  notebookId: string;
  color: string;
  baseWidth: number;
  toolType: StrokeToolType;
  points: StrokePoint[];
  createdAt: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewportTransform {
  scale: number;
  panX: number;
  panY: number;
  minScale: number;
  maxScale: number;
}

export function createDefaultViewport(): ViewportTransform {
  return {
    scale: 1.0,
    panX: 0.0,
    panY: 0.0,
    minScale: 0.25,
    maxScale: 5.0,
  };
}

/**
 * Converte coordenadas de tela (pixels) para coordenadas lógicas da página.
 * O zoom e o deslocamento nunca alteram a geometria original dos traços.
 */
export function screenToLogical(
  screenX: number,
  screenY: number,
  viewport: ViewportTransform
): { x: number; y: number } {
  const safeScale = viewport.scale > 0.0001 ? viewport.scale : 1.0;
  return {
    x: (screenX - viewport.panX) / safeScale,
    y: (screenY - viewport.panY) / safeScale,
  };
}

/**
 * Converte coordenadas lógicas da página para coordenadas de tela (pixels).
 */
export function logicalToScreen(
  logicalX: number,
  logicalY: number,
  viewport: ViewportTransform
): { x: number; y: number } {
  return {
    x: logicalX * viewport.scale + viewport.panX,
    y: logicalY * viewport.scale + viewport.panY,
  };
}

/**
 * Aplica zoom ancorado em um ponto focal de tela (ex: centro da pinça de dois dedos)
 * sem alterar as coordenadas lógicas do conteúdo.
 */
export function applyPinchZoom(
  viewport: ViewportTransform,
  scaleFactor: number,
  focalScreenX: number,
  focalScreenY: number,
  panDeltaX = 0,
  panDeltaY = 0
): ViewportTransform {
  const unclampedScale = viewport.scale * scaleFactor;
  const newScale = Math.max(
    viewport.minScale,
    Math.min(viewport.maxScale, unclampedScale)
  );
  // Ponto lógico sob o centro focal antes do zoom deve permanecer sob o centro focal após o zoom
  const logicalFocal = screenToLogical(focalScreenX, focalScreenY, viewport);
  const newPanX = focalScreenX - logicalFocal.x * newScale + panDeltaX;
  const newPanY = focalScreenY - logicalFocal.y * newScale + panDeltaY;

  return {
    ...viewport,
    scale: newScale,
    panX: newPanX,
    panY: newPanY,
  };
}

/**
 * Calcula a espessura efetiva de renderização e colisão em um ponto com base na pressão da S Pen.
 */
export function computePointWidth(baseWidth: number, pressure: number): number {
  const clampedPressure = Math.max(0.0, Math.min(1.0, Number.isFinite(pressure) ? pressure : 0.5));
  return Math.max(0.5, baseWidth * (0.35 + 0.9 * clampedPressure));
}

/**
 * Calcula a BoundingBox de um traço expandida pela sua espessura máxima.
 */
export function computeStrokeBoundingBox(stroke: Stroke): BoundingBox {
  if (stroke.points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  const first = stroke.points[0]!;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  let maxHalfWidth = computePointWidth(stroke.baseWidth, first.pressure) / 2;

  for (let i = 1; i < stroke.points.length; i++) {
    const pt = stroke.points[i]!;
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
    const hw = computePointWidth(stroke.baseWidth, pt.pressure) / 2;
    if (hw > maxHalfWidth) maxHalfWidth = hw;
  }

  return {
    minX: minX - maxHalfWidth,
    minY: minY - maxHalfWidth,
    maxX: maxX + maxHalfWidth,
    maxY: maxY + maxHalfWidth,
  };
}

/**
 * Calcula a menor distância euclidiana entre um ponto P(px, py) e um segmento AB(ax, ay -> bx, by).
 */
export function distancePointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq <= 1e-9) {
    return Math.hypot(px - ax, py - ay);
  }

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0.0, Math.min(1.0, t));

  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(px - projX, py - projY);
}

/**
 * Calcula a menor distância entre dois segmentos de reta P1->P2 e Q1->Q2.
 * Isso garante que mesmo movimentos muito rápidos da borracha não "pulem" sobre um traço fino.
 */
export function distanceSegmentToSegment(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  q1x: number,
  q1y: number,
  q2x: number,
  q2y: number
): number {
  // Verifica se os segmentos se cruzam diretamente
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

  const d1 = ccw(p1x, p1y, p2x, p2y, q1x, q1y);
  const d2 = ccw(p1x, p1y, p2x, p2y, q2x, q2y);
  const d3 = ccw(q1x, q1y, q2x, q2y, p1x, p1y);
  const d4 = ccw(q1x, q1y, q2x, q2y, p2x, p2y);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return 0.0;
  }

  return Math.min(
    distancePointToSegment(p1x, p1y, q1x, q1y, q2x, q2y),
    distancePointToSegment(p2x, p2y, q1x, q1y, q2x, q2y),
    distancePointToSegment(q1x, q1y, p1x, p1y, p2x, p2y),
    distancePointToSegment(q2x, q2y, p1x, p1y, p2x, p2y)
  );
}

/**
 * Verifica se o círculo/segmento da borracha de raio `eraserRadius` (indo de `ex1,ey1` até `ex2,ey2`)
 * intersecta qualquer parte da geometria vetorial do `stroke`, levando em consideração a espessura original
 * modulada por pressão em cada segmento do traço.
 */
export function doesEraserSegmentIntersectStroke(
  ex1: number,
  ey1: number,
  ex2: number,
  ey2: number,
  eraserRadius: number,
  stroke: Stroke
): boolean {
  const pts = stroke.points;
  if (pts.length === 0) return false;

  if (pts.length === 1) {
    const p0 = pts[0]!;
    const halfWidth = computePointWidth(stroke.baseWidth, p0.pressure) / 2;
    const dist = distancePointToSegment(p0.x, p0.y, ex1, ey1, ex2, ey2);
    return dist <= eraserRadius + halfWidth;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const avgPressure = (a.pressure + b.pressure) * 0.5;
    const halfSegmentWidth = computePointWidth(stroke.baseWidth, avgPressure) * 0.5;
    const threshold = eraserRadius + halfSegmentWidth;

    const dist = distanceSegmentToSegment(ex1, ey1, ex2, ey2, a.x, a.y, b.x, b.y);
    if (dist <= threshold) {
      return true;
    }
  }

  return false;
}

/**
 * Grade Espacial Uniforme (SpatialGridIndex) para consulta rápida de traços candidatos
 * em páginas extensas.
 */
export class SpatialGridIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Set<string>>();
  private readonly strokesById = new Map<string, Stroke>();
  private readonly bboxesById = new Map<string, BoundingBox>();

  constructor(cellSize: number = DEFAULT_SPATIAL_CELL_SIZE) {
    this.cellSize = Math.max(10, cellSize);
  }

  private cellKey(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  public clear(): void {
    this.cells.clear();
    this.strokesById.clear();
    this.bboxesById.clear();
  }

  public insert(stroke: Stroke): void {
    this.remove(stroke.id);
    const bbox = computeStrokeBoundingBox(stroke);
    this.strokesById.set(stroke.id, stroke);
    this.bboxesById.set(stroke.id, bbox);

    const minCellX = Math.floor(bbox.minX / this.cellSize);
    const maxCellX = Math.floor(bbox.maxX / this.cellSize);
    const minCellY = Math.floor(bbox.minY / this.cellSize);
    const maxCellY = Math.floor(bbox.maxY / this.cellSize);

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const key = this.cellKey(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = new Set<string>();
          this.cells.set(key, bucket);
        }
        bucket.add(stroke.id);
      }
    }
  }

  public remove(strokeId: string): Stroke | undefined {
    const existing = this.strokesById.get(strokeId);
    const bbox = this.bboxesById.get(strokeId);
    if (!existing || !bbox) {
      return undefined;
    }

    const minCellX = Math.floor(bbox.minX / this.cellSize);
    const maxCellX = Math.floor(bbox.maxX / this.cellSize);
    const minCellY = Math.floor(bbox.minY / this.cellSize);
    const maxCellY = Math.floor(bbox.maxY / this.cellSize);

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const key = this.cellKey(cx, cy);
        const bucket = this.cells.get(key);
        if (bucket) {
          bucket.delete(strokeId);
          if (bucket.size === 0) {
            this.cells.delete(key);
          }
        }
      }
    }

    this.strokesById.delete(strokeId);
    this.bboxesById.delete(strokeId);
    return existing;
  }

  public getStroke(strokeId: string): Stroke | undefined {
    return this.strokesById.get(strokeId);
  }

  public getAllStrokes(): Stroke[] {
    return Array.from(this.strokesById.values());
  }

  /**
   * Retorna os traços candidatos cujas células e bounding boxes intersectam a área varrida pela borracha.
   */
  public queryCandidates(
    ex1: number,
    ey1: number,
    ex2: number,
    ey2: number,
    eraserRadius: number
  ): Stroke[] {
    const queryMinX = Math.min(ex1, ex2) - eraserRadius;
    const queryMaxX = Math.max(ex1, ex2) + eraserRadius;
    const queryMinY = Math.min(ey1, ey2) - eraserRadius;
    const queryMaxY = Math.max(ey1, ey2) + eraserRadius;

    const minCellX = Math.floor(queryMinX / this.cellSize);
    const maxCellX = Math.floor(queryMaxX / this.cellSize);
    const minCellY = Math.floor(queryMinY / this.cellSize);
    const maxCellY = Math.floor(queryMaxY / this.cellSize);

    const candidateIds = new Set<string>();
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const bucket = this.cells.get(this.cellKey(cx, cy));
        if (bucket) {
          for (const id of bucket) {
            candidateIds.add(id);
          }
        }
      }
    }

    const candidates: Stroke[] = [];
    for (const id of candidateIds) {
      const bbox = this.bboxesById.get(id);
      const stroke = this.strokesById.get(id);
      if (!bbox || !stroke) continue;

      if (
        bbox.maxX >= queryMinX &&
        bbox.minX <= queryMaxX &&
        bbox.maxY >= queryMinY &&
        bbox.minY <= queryMaxY
      ) {
        candidates.push(stroke);
      }
    }
    return candidates;
  }
}

/**
 * Gerenciador de sessão da borracha por traço inteiro.
 * Garante que o mesmo traço não gere operações duplicadas durante uma única passagem
 * e remove o traço inteiro assim que qualquer segmento é intersectado.
 */
export class WholeStrokeEraserSession {
  private readonly spatialIndex: SpatialGridIndex;
  private eraserRadius: number;
  private readonly erasedInCurrentPass = new Set<string>();
  private lastPoint: { x: number; y: number } | null = null;

  constructor(spatialIndex: SpatialGridIndex, eraserRadius = 12.0) {
    this.spatialIndex = spatialIndex;
    this.eraserRadius = Math.max(1.0, eraserRadius);
  }

  public setEraserRadius(radius: number): void {
    this.eraserRadius = Math.max(1.0, radius);
  }

  public getEraserRadius(): number {
    return this.eraserRadius;
  }

  public beginPass(x: number, y: number): Stroke[] {
    this.erasedInCurrentPass.clear();
    this.lastPoint = { x, y };
    return this.stepTo(x, y);
  }

  public stepTo(x: number, y: number): Stroke[] {
    const prev = this.lastPoint ?? { x, y };
    this.lastPoint = { x, y };

    const candidates = this.spatialIndex.queryCandidates(
      prev.x,
      prev.y,
      x,
      y,
      this.eraserRadius
    );

    const newlyErased: Stroke[] = [];
    for (const stroke of candidates) {
      if (this.erasedInCurrentPass.has(stroke.id)) {
        continue;
      }
      if (
        doesEraserSegmentIntersectStroke(
          prev.x,
          prev.y,
          x,
          y,
          this.eraserRadius,
          stroke
        )
      ) {
        this.erasedInCurrentPass.add(stroke.id);
        const removed = this.spatialIndex.remove(stroke.id);
        if (removed) {
          newlyErased.push(removed);
        }
      }
    }

    return newlyErased;
  }

  public endPass(): void {
    this.lastPoint = null;
    this.erasedInCurrentPass.clear();
  }
}
