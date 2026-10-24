import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_GRID_SETTINGS,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type PageStateSnapshot,
  type Stroke,
  type ViewportUpdatePayload,
} from '../../../protocol/src/index.ts';
import { desktopBridge, type DesktopServerEvent } from '../services/desktopBridge.ts';
import { Canvas2DRenderer } from './Canvas2DRenderer.ts';

export function ScreenReflectionApp(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef(new Canvas2DRenderer());
  const provisionalRef = useRef(new Map<string, Stroke>());
  const [page, setPage] = useState<PageStateSnapshot | null>(null);
  const [phoneViewport, setPhoneViewport] = useState<ViewportUpdatePayload | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent';
    return () => {
      document.documentElement.style.backgroundColor = '';
    };
  }, []);

  useEffect(() => {
    const applyEvent = (event: DesktopServerEvent): void => {
      switch (event.event) {
        case 'desktop.init':
          if (event.activePage) setPage(event.activePage);
          break;
        case 'page.updated':
          provisionalRef.current.clear();
          if (event.snapshot) setPage(event.snapshot);
          break;
        case 'page.selected':
          provisionalRef.current.clear();
          if (event.snapshot) setPage(event.snapshot);
          break;
        case 'viewport.updated':
          setPhoneViewport(event.active ? event : null);
          break;
        case 'stroke.begin':
          provisionalRef.current.set(event.stroke.id, event.stroke);
          setRevision((revision) => revision + 1);
          break;
        case 'stroke.points': {
          const stroke = provisionalRef.current.get(event.strokeId);
          if (stroke) stroke.points.push(...event.points);
          setRevision((revision) => revision + 1);
          break;
        }
        case 'stroke.cancelled':
          provisionalRef.current.delete(event.strokeId);
          setRevision((revision) => revision + 1);
          break;
        case 'status.updated':
          break;
      }
    };
    return desktopBridge.connectRealtime(applyEvent);
  }, []);

  useEffect(() => {
    let raf = 0;
    const draw = (): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        rendererRef.current.markCommittedDirty();
      }

      const pageWidth = page?.metadata.width ?? DEFAULT_PAGE_WIDTH;
      const pageHeight = page?.metadata.height ?? DEFAULT_PAGE_HEIGHT;
      // Preserve a geometria da página. O conteúdo cobre o monitor, enquanto
      // o enquadramento acompanha a proporção real da tela do celular.
      const projectionScale = Math.max(
        width / Math.max(1, pageWidth),
        height / Math.max(1, pageHeight)
      );
      const projectionOffsetX = (width - pageWidth * projectionScale) / 2;
      const projectionOffsetY = (height - pageHeight * projectionScale) / 2;
      rendererRef.current.render({
        canvas,
        committedStrokes: page?.strokes ?? [],
        provisionalStrokes: provisionalRef.current,
        grid: page?.metadata.grid ?? DEFAULT_GRID_SETTINGS,
        backgroundColor: page?.metadata.backgroundColor ?? '#FFFFFF',
        pageWidth,
        pageHeight,
        viewport: {
          scale: 1,
          panX: projectionOffsetX / projectionScale,
          panY: projectionOffsetY / projectionScale,
          minScale: 0.01,
          maxScale: 100,
        },
        viewportProjection: {
          // A tela inteira é a superfície de desenho. O viewport do celular
          // seleciona qual parte da página lógica cai em cada área do monitor.
          scaleX: projectionScale,
          scaleY: projectionScale,
        },
        transparent: true,
      });

      if (phoneViewport && phoneViewport.scale > 0) {
        const viewLeft = -phoneViewport.panX / phoneViewport.scale;
        const viewTop = -phoneViewport.panY / phoneViewport.scale;
        const viewWidth = phoneViewport.viewWidth / phoneViewport.scale;
        const viewHeight = phoneViewport.viewHeight / phoneViewport.scale;
        const x = projectionOffsetX + viewLeft * projectionScale;
        const y = projectionOffsetY + viewTop * projectionScale;
        const selectionWidth = viewWidth * projectionScale;
        const selectionHeight = viewHeight * projectionScale;

        const monitorLogicalWidth = width / projectionScale;
        const monitorLogicalHeight = height / projectionScale;
        const fitScale = Math.min(
          phoneViewport.viewWidth / monitorLogicalWidth,
          phoneViewport.viewHeight / monitorLogicalHeight,
        );
        const zoomFactor = Math.max(0.01, phoneViewport.scale / Math.max(0.001, fitScale));
        const dashTightening = Math.sqrt(zoomFactor);
        const dashLength = Math.max(3, Math.min(10, 10 / dashTightening));
        const dashGap = Math.max(2, Math.min(7, 7 / dashTightening));

        const ctx = canvas.getContext('2d');
        if (ctx && selectionWidth > 0 && selectionHeight > 0) {
          ctx.save();
          ctx.fillStyle = 'rgba(45, 212, 191, 0.045)';
          ctx.fillRect(x, y, selectionWidth, selectionHeight);
          ctx.lineJoin = 'round';
          ctx.setLineDash([]);
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(2, 6, 23, 0.88)';
          ctx.strokeRect(x, y, selectionWidth, selectionHeight);
          ctx.setLineDash([dashLength, dashGap]);
          ctx.lineDashOffset = 0;
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(94, 234, 212, 0.96)';
          ctx.strokeRect(x, y, selectionWidth, selectionHeight);
          ctx.restore();
        }
      }
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [page, phoneViewport, revision]);

  useEffect(() => {
    const onResize = (): void => {
      rendererRef.current.markCommittedDirty();
      setRevision((revision) => revision + 1);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <main className="reflection-window" aria-label="Reflexo da tela do celular">
      <canvas ref={canvasRef} className="reflection-canvas" />
    </main>
  );
}
