/**
 * Exportador PDF 100% Vetorial (PDF 1.4 Nativo).
 *
 * Gera documentos PDF diretamente a partir da geometria vetorial persistida (PageStateSnapshot[]),
 * sem jamais utilizar capturas de tela (screenshots) ou bitmaps rasterizados.
 *
 * Garantias:
 * - 1 página do caderno = 1 página do PDF.
 * - Preserva geometria, cores RGB exatas e espessura sensível à pressão da S Pen.
 * - Permite incluir ou excluir a grade pontilhada vetorial.
 * - Respeita as dimensões lógicas da página mapeadas proporcionalmente para pontos PDF (ISO A4).
 */

import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type PageStateSnapshot,
  type Stroke,
  computePointWidth,
} from '../../../protocol/src/index.ts';

export interface PdfExportOptions {
  includeGrid: boolean;
  title?: string;
  author?: string;
}

const PDF_A4_WIDTH_PT = 595.28;

function hexToRgbNormalized(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, '');
  if (clean.length < 6) {
    return { r: 0, g: 0, b: 0 };
  }
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return {
    r: Number.isFinite(r) ? Number(r.toFixed(4)) : 0,
    g: Number.isFinite(g) ? Number(g.toFixed(4)) : 0,
    b: Number.isFinite(b) ? Number(b.toFixed(4)) : 0,
  };
}

function blendColorWithWhite(
  rgb: { r: number; g: number; b: number },
  opacity: number
): { r: number; g: number; b: number } {
  const alpha = Math.max(0, Math.min(1, opacity));
  return {
    r: Number((rgb.r * alpha + 1.0 * (1 - alpha)).toFixed(4)),
    g: Number((rgb.g * alpha + 1.0 * (1 - alpha)).toFixed(4)),
    b: Number((rgb.b * alpha + 1.0 * (1 - alpha)).toFixed(4)),
  };
}

function fmt(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/**
 * Constrói o stream de comandos vetoriais PDF para uma única página.
 */
export function buildPageVectorContentStream(
  page: PageStateSnapshot,
  options: PdfExportOptions
): { content: string; pdfWidthPt: number; pdfHeightPt: number } {
  const logicalW = page.metadata.width > 0 ? page.metadata.width : DEFAULT_PAGE_WIDTH;
  const logicalH = page.metadata.height > 0 ? page.metadata.height : DEFAULT_PAGE_HEIGHT;

  const isLandscape = logicalW > logicalH;
  const targetWidthPt = isLandscape ? 841.89 : PDF_A4_WIDTH_PT;
  const scale = targetWidthPt / logicalW;
  const pdfWidthPt = Number((logicalW * scale).toFixed(2));
  const pdfHeightPt = Number((logicalH * scale).toFixed(2));

  const toPdfX = (lx: number): number => lx * scale;
  const toPdfY = (ly: number): number => pdfHeightPt - ly * scale;

  const ops: string[] = [];

  // 1. Fundo da página no PDF (Sempre Branco #FFFFFF na exportação)
  ops.push('q');
  ops.push('1 1 1 rg');
  ops.push(`0 0 ${fmt(pdfWidthPt)} ${fmt(pdfHeightPt)} re f`);
  ops.push('Q');

  // 2. Grade pontilhada vetorial opcional
  if (options.includeGrid && page.metadata.grid.enabled) {
    const spacing = Math.max(10, Math.min(100, page.metadata.grid.spacing));
    const rawGridRgb = hexToRgbNormalized(page.metadata.grid.color || '#94A3B8');
    const gridRgb = blendColorWithWhite(rawGridRgb, page.metadata.grid.opacity);
    const dotSizePt = fmt(1.6 * scale);

    ops.push('q');
    ops.push('1 J'); // Round cap -> transforma segmento de comprimento zero em ponto circular vetorial perfeito!
    ops.push(`${dotSizePt} w`);
    ops.push(`${gridRgb.r} ${gridRgb.g} ${gridRgb.b} RG`);

    for (let ly = spacing; ly < logicalH; ly += spacing) {
      const py = fmt(toPdfY(ly));
      for (let lx = spacing; lx < logicalW; lx += spacing) {
        const px = fmt(toPdfX(lx));
        ops.push(`${px} ${py} m ${px} ${py} l S`);
      }
    }
    ops.push('Q');
  }

  // 3. Traços vetoriais sensíveis à pressão
  for (const stroke of page.strokes) {
    renderStrokeToPdfOps(stroke, scale, toPdfX, toPdfY, ops);
  }

  return {
    content: ops.join('\n') + '\n',
    pdfWidthPt,
    pdfHeightPt,
  };
}

function resolvePdfStrokeColorHex(color: string): string {
  const upper = (color || '').trim().toUpperCase();
  // Tinta clara/branca usada na página escura (ou tinta padrão escura) é exportada como preto no PDF branco
  if (
    upper === '#F8FAFC' ||
    upper === '#FFFFFF' ||
    upper === '#E2E8F0' ||
    upper === '#F1F5F9' ||
    upper === '#111827' ||
    upper === '#000000'
  ) {
    return '#000000';
  }
  return color;
}

function renderStrokeToPdfOps(
  stroke: Stroke,
  scale: number,
  toPdfX: (lx: number) => number,
  toPdfY: (ly: number) => number,
  ops: string[]
): void {
  const pts = stroke.points;
  if (pts.length === 0) return;

  const pdfHex = resolvePdfStrokeColorHex(stroke.color);
  const rgb = hexToRgbNormalized(pdfHex);
  ops.push('q');
  ops.push('1 J 1 j'); // Round line cap e round line join
  ops.push(`${rgb.r} ${rgb.g} ${rgb.b} RG`);
  ops.push(`${rgb.r} ${rgb.g} ${rgb.b} rg`);

  if (pts.length === 1) {
    const p0 = pts[0]!;
    const widthPt = computePointWidth(stroke.baseWidth, p0.pressure) * scale;
    const px = fmt(toPdfX(p0.x));
    const py = fmt(toPdfY(p0.y));
    ops.push(`${fmt(widthPt)} w`);
    ops.push(`${px} ${py} m ${px} ${py} l S`);
    ops.push('Q');
    return;
  }

  // Emite segmentos vetoriais preservando a variação de espessura por pressão da S Pen
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const avgPressure = (a.pressure + b.pressure) * 0.5;
    const widthPt = computePointWidth(stroke.baseWidth, avgPressure) * scale;

    const ax = fmt(toPdfX(a.x));
    const ay = fmt(toPdfY(a.y));
    const bx = fmt(toPdfX(b.x));
    const by = fmt(toPdfY(b.y));

    ops.push(`${fmt(widthPt)} w`);
    ops.push(`${ax} ${ay} m ${bx} ${by} l S`);
  }

  ops.push('Q');
}

/**
 * Gera um documento PDF 1.4 completo em bytes (Uint8Array) contendo todas as páginas fornecidas.
 */
export function generateVectorPdfBytes(
  pages: PageStateSnapshot[],
  options: PdfExportOptions
): Uint8Array {
  if (pages.length === 0) {
    throw new Error('Cannot export PDF with zero pages.');
  }

  // Object IDs:
  // 1: Catalog
  // 2: Pages Tree
  // Para cada página i (0..N-1):
  //   pageObjId = 3 + i * 2
  //   contentObjId = 4 + i * 2
  const objects: Array<{ id: number; body: string }> = [];

  const pageObjIds: number[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const pageObjId = 3 + i * 2;
    const contentObjId = 4 + i * 2;
    pageObjIds.push(pageObjId);

    const { content, pdfWidthPt, pdfHeightPt } = buildPageVectorContentStream(page, options);
    const contentByteLength = new TextEncoder().encode(content).byteLength;

    objects.push({
      id: pageObjId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pdfWidthPt)} ${fmt(
        pdfHeightPt
      )}] /Contents ${contentObjId} 0 R /Resources << >> >>`,
    });

    objects.push({
      id: contentObjId,
      body: `<< /Length ${contentByteLength} >>\nstream\n${content}endstream`,
    });
  }

  const kidsRef = pageObjIds.map((id) => `${id} 0 R`).join(' ');

  const allObjects: Array<{ id: number; body: string }> = [
    {
      id: 1,
      body: `<< /Type /Catalog /Pages 2 0 R >>`,
    },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${kidsRef}] /Count ${pages.length} >>`,
    },
    ...objects,
  ];

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0]; // Índice 0 reservado para objeto livre 0
  let currentOffset = 0;

  const pushStr = (str: string): void => {
    const bytes = encoder.encode(str);
    chunks.push(bytes);
    currentOffset += bytes.byteLength;
  };

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  for (const obj of allObjects) {
    offsets[obj.id] = currentOffset;
    pushStr(`${obj.id} 0 obj\n${obj.body}\nendobj\n`);
  }

  const xrefOffset = currentOffset;
  const totalObjects = allObjects.length + 1;
  let xref = `xref\n0 ${totalObjects}\n0000000000 65535 f \n`;
  for (let id = 1; id < totalObjects; id++) {
    const off = offsets[id] ?? 0;
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pushStr(xref);

  const trailer =
    `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  pushStr(trailer);

  const output = new Uint8Array(currentOffset);
  let pos = 0;
  for (const chunk of chunks) {
    output.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return output;
}
