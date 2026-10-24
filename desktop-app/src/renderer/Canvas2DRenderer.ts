/**
 * Renderizador Incremental Canvas 2D para o Aplicativo Desktop.
 *
 * Mantém um buffer offscreen para os traços confirmados e desenha de forma incremental
 * os lotes de pontos em tempo real (`stroke.begin` / `stroke.points`), garantindo baixa latência
 * sem redesenhar desnecessariamente toda a página a cada pacote WebSocket.
 */

import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type GridSettings,
  type Stroke,
  type ViewportTransform,
  computePointWidth,
} from '../../../protocol/src/index.ts';

export class Canvas2DRenderer {
  private committedLayer: HTMLCanvasElement | null = null;
  private committedCtx: CanvasRenderingContext2D | null = null;
  private committedDirty = true;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastScale = -1;
  private lastPanX = Number.NaN;
  private lastPanY = Number.NaN;
  private lastProjectionScaleX = Number.NaN;
  private lastProjectionScaleY = Number.NaN;
  private lastPageWidth = DEFAULT_PAGE_WIDTH;
  private lastPageHeight = DEFAULT_PAGE_HEIGHT;
  private lastStrokesRef: Stroke[] | null = null;

  public markCommittedDirty(): void {
    this.committedDirty = true;
  }

  public render(options: {
    canvas: HTMLCanvasElement;
    committedStrokes: Stroke[];
    provisionalStrokes: Map<string, Stroke>;
    grid: GridSettings;
    backgroundColor: string;
    viewport: ViewportTransform;
    pageWidth?: number;
    pageHeight?: number;
    viewportProjection?: { scaleX: number; scaleY: number };
    eraserPreview?: { x: number; y: number; radius: number } | null;
    transparent?: boolean;
  }): void {
    const {
      canvas,
      committedStrokes,
      provisionalStrokes,
      grid,
      backgroundColor,
      viewport,
      pageWidth = DEFAULT_PAGE_WIDTH,
      pageHeight = DEFAULT_PAGE_HEIGHT,
      viewportProjection = { scaleX: 1, scaleY: 1 },
      eraserPreview,
      transparent = false,
    } = options;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    if (width <= 0 || height <= 0) return;
    const applyViewport = (target: CanvasRenderingContext2D): void => {
      target.translate(
        viewport.panX * viewportProjection.scaleX,
        viewport.panY * viewportProjection.scaleY
      );
      target.scale(
        viewport.scale * viewportProjection.scaleX,
        viewport.scale * viewportProjection.scaleY
      );
    };

    if (!this.committedLayer || this.lastWidth !== width || this.lastHeight !== height) {
      this.committedLayer = document.createElement('canvas');
      this.committedLayer.width = width;
      this.committedLayer.height = height;
      this.committedCtx = this.committedLayer.getContext('2d');
      this.lastWidth = width;
      this.lastHeight = height;
      this.committedDirty = true;
    }

    if (
      this.lastScale !== viewport.scale ||
      this.lastPanX !== viewport.panX ||
      this.lastPanY !== viewport.panY ||
      this.lastProjectionScaleX !== viewportProjection.scaleX ||
      this.lastProjectionScaleY !== viewportProjection.scaleY ||
      this.lastPageWidth !== pageWidth ||
      this.lastPageHeight !== pageHeight ||
      this.lastStrokesRef !== committedStrokes
    ) {
      this.committedDirty = true;
      this.lastScale = viewport.scale;
      this.lastPanX = viewport.panX;
      this.lastPanY = viewport.panY;
      this.lastProjectionScaleX = viewportProjection.scaleX;
      this.lastProjectionScaleY = viewportProjection.scaleY;
      this.lastPageWidth = pageWidth;
      this.lastPageHeight = pageHeight;
      this.lastStrokesRef = committedStrokes;
    }

    // 1. Limpar área externa da viewport (Modo Dark)
    ctx.clearRect(0, 0, width, height);
    if (!transparent) {
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, width, height);
    }

    // 2. Desenhar a folha apenas no modo caderno; o espelho mantém fundo transparente.
    ctx.save();
    applyViewport(ctx);

    if (!transparent) {
      // Sombra da página
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(6, 8, pageWidth, pageHeight);

      // Folha escura (#0F172A por padrão no modo dark)
      const isLightDefaultBg =
        !backgroundColor ||
        backgroundColor.toUpperCase() === '#FFFFFF' ||
        backgroundColor.toUpperCase() === '#F8FAFC';
      ctx.fillStyle = isLightDefaultBg ? '#0F172A' : backgroundColor;
      ctx.fillRect(0, 0, pageWidth, pageHeight);

      // Borda nítida da folha escura
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5 / viewport.scale;
      ctx.strokeRect(0, 0, pageWidth, pageHeight);

      if (grid.enabled) {
        this.drawDottedGrid(ctx, grid, pageWidth, pageHeight);
      }
    }
    ctx.restore();

    // 3. Reconstruir camada incremental de traços confirmados apenas quando necessário
    if (this.committedDirty && this.committedCtx && this.committedLayer) {
      this.committedCtx.clearRect(0, 0, width, height);
      this.committedCtx.save();
      applyViewport(this.committedCtx);
      for (const stroke of committedStrokes) {
        this.drawStroke(this.committedCtx, stroke);
      }
      this.committedCtx.restore();
      this.committedDirty = false;
    }

    if (this.committedLayer) {
      ctx.drawImage(this.committedLayer, 0, 0);
    }

    // 4. Desenhar traços provisórios (em andamento em tempo real via WebSocket ou S Pen local)
    if (provisionalStrokes.size > 0) {
      ctx.save();
      applyViewport(ctx);
      for (const stroke of provisionalStrokes.values()) {
        this.drawStroke(ctx, stroke);
      }
      ctx.restore();
    }

    // 5. Indicador de raio da borracha por traço inteiro
    if (eraserPreview) {
      ctx.save();
      applyViewport(ctx);
      ctx.beginPath();
      ctx.arc(eraserPreview.x, eraserPreview.y, eraserPreview.radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#EF4444';
      ctx.lineWidth = 1.5 / viewport.scale;
      ctx.stroke();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Adiciona incrementalmente apenas um novo traço confirmado ao buffer existente,
   * evitando redesenhar toda a página.
   */
  public appendCommittedStroke(stroke: Stroke, viewport: ViewportTransform): void {
    if (!this.committedCtx || this.committedDirty) {
      this.committedDirty = true;
      return;
    }
    this.committedCtx.save();
    this.committedCtx.translate(viewport.panX, viewport.panY);
    this.committedCtx.scale(viewport.scale, viewport.scale);
    this.drawStroke(this.committedCtx, stroke);
    this.committedCtx.restore();
  }

  private drawDottedGrid(
    ctx: CanvasRenderingContext2D,
    grid: GridSettings,
    pageWidth: number,
    pageHeight: number
  ): void {
    const spacing = Math.max(10, Math.min(100, grid.spacing));
    ctx.save();
    ctx.fillStyle = '#475569';
    ctx.globalAlpha = Math.max(0.15, Math.min(1.0, grid.opacity));

    const dotRadius = 1.35;
    for (let y = spacing; y < pageHeight; y += spacing) {
      for (let x = spacing; x < pageWidth; x += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private resolveDarkCanvasStrokeColor(hex: string): string {
    const upper = (hex || '').toUpperCase();
    if (upper === '#111827' || upper === '#000000' || upper === '#0F172A') {
      return '#F8FAFC';
    }
    return hex;
  }

  private drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    const pts = stroke.points;
    if (pts.length === 0) return;

    const displayColor = this.resolveDarkCanvasStrokeColor(stroke.color);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = displayColor;
    ctx.fillStyle = displayColor;

    if (pts.length === 1) {
      const p0 = pts[0]!;
      const r = computePointWidth(stroke.baseWidth, p0.pressure) * 0.5;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const avgPressure = (a.pressure + b.pressure) * 0.5;
      ctx.lineWidth = computePointWidth(stroke.baseWidth, avgPressure);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.restore();
  }
}
