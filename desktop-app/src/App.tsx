import React, { useEffect, useRef, useState } from 'react';
import {
  type ActiveUiTool,
  DEFAULT_GRID_SETTINGS,
  DEFAULT_INPUT_PREFERENCES,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type FingerMode,
  type GridSettings,
  type InputPreferences,
  NotebookInputController,
  type NotebookSummary,
  type PageStateSnapshot,
  type PairingQrPayload,
  type ProtocolMessage,
  type ScrollMode,
  SpatialGridIndex,
  type Stroke,
  type ViewportTransform,
  applyPinchZoom,
  createDefaultViewport,
} from '../../protocol/src/index.ts';
import { generateVectorPdfBytes } from './pdf/VectorPdfExporter.ts';
import { Canvas2DRenderer } from './renderer/Canvas2DRenderer.ts';
import { type ServerStatusInfo, desktopBridge } from './services/desktopBridge.ts';

const PRESET_COLORS = [
  '#F8FAFC', // Branco / Tinta Clara (convertida para Preto #000000 na exportação PDF)
  '#60A5FA', // Azul Claro Vibrante
  '#F87171', // Vermelho Coral
  '#34D399', // Verde Esmeralda
  '#C084FC', // Roxo Lavanda
  '#FBBF24', // Âmbar / Amarelo
];

export function App(): React.ReactElement {
  const [serverStatus, setServerStatus] = useState<ServerStatusInfo | null>(null);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [activeNotebookId, setActiveNotebookId] = useState<string>('nb_default');
  const [activePageId, setActivePageId] = useState<string>('page_default_1');
  const [pageSnapshot, setPageSnapshot] = useState<PageStateSnapshot | null>(null);

  // Estado de ferramentas e preferências (espelhando o modelo S Pen)
  const [activeTool, setActiveTool] = useState<ActiveUiTool>('pen');
  const [penColor, setPenColor] = useState<string>(PRESET_COLORS[0]!);
  const [penWidth, setPenWidth] = useState<number>(3.5);
  const [eraserRadius, setEraserRadius] = useState<number>(14.0);
  const [simulateSPenButtonHeld, setSimulateSPenButtonHeld] = useState<boolean>(false);
  const [inputPrefs, setInputPrefs] = useState<InputPreferences>(() => {
    try {
      const saved = localStorage.getItem('dn_input_prefs');
      return saved ? (JSON.parse(saved) as InputPreferences) : { ...DEFAULT_INPUT_PREFERENCES };
    } catch {
      return { ...DEFAULT_INPUT_PREFERENCES };
    }
  });

  // Viewport (Zoom e Pan independentes das coordenadas originais dos traços)
  const [viewport, setViewport] = useState<ViewportTransform>(() => ({
    ...createDefaultViewport(),
    scale: 0.56,
    panX: 160,
    panY: 24,
  }));
  const [showScrollbars, setShowScrollbars] = useState<boolean>(true);
  const [showSidebar, setShowSidebar] = useState<boolean>(true);

  // Modais
  const [showPairingModal, setShowPairingModal] = useState<boolean>(false);
  const [pairingData, setPairingData] = useState<{
    qr: PairingQrPayload;
    qrDataUrl: string;
  } | null>(null);
  const [selectedHost, setSelectedHost] = useState<string>('');
  const [requireApproval, setRequireApproval] = useState<boolean>(false);

  const [showGridModal, setShowGridModal] = useState<boolean>(false);
  const [showInputPrefsModal, setShowInputPrefsModal] = useState<boolean>(false);
  const [showPdfModal, setShowPdfModal] = useState<boolean>(false);
  const [pdfScope, setPdfScope] = useState<'current_page' | 'entire_notebook'>('current_page');
  const [pdfIncludeGrid, setPdfIncludeGrid] = useState<boolean>(true);
  const [pdfExportFeedback, setPdfExportFeedback] = useState<string | null>(null);

  // Referências para renderização incremental Canvas 2D e cliente WebSocket integrado
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Canvas2DRenderer>(new Canvas2DRenderer());
  const spatialIndexRef = useRef<SpatialGridIndex>(new SpatialGridIndex());
  const provisionalStrokesRef = useRef<Map<string, Stroke>>(new Map());
  const pageSnapshotRef = useRef<PageStateSnapshot | null>(null);
  const viewportRef = useRef<ViewportTransform>(viewport);
  const activePageIdRef = useRef<string>(activePageId);
  const eraserRadiusRef = useRef<number>(eraserRadius);
  const eraserPreviewRef = useRef<{ x: number; y: number; radius: number } | null>(null);
  const inputControllerRef = useRef<NotebookInputController | null>(null);
  const localMobileWsRef = useRef<WebSocket | null>(null);
  const seqCounterRef = useRef<number>(0);

  viewportRef.current = viewport;
  activePageIdRef.current = activePageId;
  eraserRadiusRef.current = eraserRadius;

  const updateViewportSync = (
    updater: ViewportTransform | ((prev: ViewportTransform) => ViewportTransform)
  ): void => {
    const nextVp = typeof updater === 'function' ? updater(viewportRef.current) : updater;
    viewportRef.current = nextVp;
    const ctrl = inputControllerRef.current;
    if (ctrl) {
      // setViewport já dispara onViewportChanged sincronamente
      ctrl.setViewport(nextVp);
    } else {
      rendererRef.current.markCommittedDirty();
      setViewport(nextVp);
      requestCanvasRender();
    }
  };

  // Inicializar e escutar eventos em tempo real do servidor Desktop
  useEffect(() => {
    desktopBridge
      .fetchState()
      .then((initial) => {
        setServerStatus(initial.status);
        setSelectedHost(initial.status.preferredHost);
        setRequireApproval(initial.status.requireExplicitApproval);
        setNotebooks(initial.notebooks);
        setActiveNotebookId(initial.status.activeNotebookId);
        setActivePageId(initial.status.activePageId);
        if (initial.activePage) {
          applyIncomingPageSnapshot(initial.activePage);
        }
      })
      .catch(() => {
        // Ignorado caso o servidor ainda esteja subindo
      });

    const unsubscribe = desktopBridge.connectRealtime((ev) => {
      switch (ev.event) {
        case 'desktop.init':
          setServerStatus(ev.status);
          setSelectedHost(ev.status.preferredHost);
          setRequireApproval(ev.status.requireExplicitApproval);
          setNotebooks(ev.notebooks);
          setActiveNotebookId(ev.status.activeNotebookId);
          setActivePageId(ev.status.activePageId);
          if (ev.activePage) {
            applyIncomingPageSnapshot(ev.activePage);
          }
          break;

        case 'status.updated':
          setServerStatus(ev.status);
          break;

        case 'stroke.begin':
          provisionalStrokesRef.current.set(ev.stroke.id, ev.stroke);
          requestCanvasRender();
          break;

        case 'stroke.points': {
          const existing = provisionalStrokesRef.current.get(ev.strokeId);
          if (existing) {
            existing.points.push(...ev.points);
            requestCanvasRender();
          }
          break;
        }

        case 'stroke.cancelled':
          provisionalStrokesRef.current.delete(ev.strokeId);
          requestCanvasRender();
          break;

        case 'page.updated':
          if (ev.snapshot) {
            provisionalStrokesRef.current.clear();
            applyIncomingPageSnapshot(ev.snapshot);
          }
          break;

        case 'page.selected':
          setNotebooks(ev.notebooks);
          setActiveNotebookId(ev.notebookId);
          setActivePageId(ev.pageId);
          if (ev.snapshot) {
            provisionalStrokesRef.current.clear();
            applyIncomingPageSnapshot(ev.snapshot);
          }
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Conectar um canal WebSocket autenticado para a superfície interativa local (com reconexão automática após reload do servidor)
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;

    const connectLocalSurface = (): void => {
      if (disposed) return;
      ws = new WebSocket('ws://127.0.0.1:8765');
      localMobileWsRef.current = ws;
      ws.onopen = () => {
        const startMsg: ProtocolMessage = {
          type: 'session.start',
          timestamp: Date.now(),
          payload: {
            role: 'client',
            pairingToken: 'auto_lan',
            deviceId: 's24u_live_surface',
            deviceName: 'S24 Ultra Surface Bridge',
            clientVersion: '1.0.0',
          },
        };
        ws?.send(JSON.stringify(startMsg));
      };
      ws.onclose = () => {
        if (!disposed) {
          retryTimer = window.setTimeout(connectLocalSurface, 1000);
        }
      };
    };

    connectLocalSurface();

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      ws?.close();
    };
  }, []);

  // Inicializar o controlador de entrada S Pen / Borracha / Dedo
  useEffect(() => {
    const controller = new NotebookInputController({
      notebookId: activeNotebookId,
      pageId: activePageId,
      spatialIndex: spatialIndexRef.current,
      eraserRadius,
      preferences: inputPrefs,
      viewport,
      callbacks: {
        onProvisionalStrokeBegin: (stroke) => {
          provisionalStrokesRef.current.set(stroke.id, stroke);
          seqCounterRef.current = 0;
          requestCanvasRender();

          const ws = localMobileWsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN && stroke.points[0]) {
            const msg: ProtocolMessage = {
              type: 'stroke.begin',
              timestamp: Date.now(),
              payload: {
                operationId: `op_b_${stroke.id}`,
                strokeId: stroke.id,
                notebookId: stroke.notebookId,
                pageId: stroke.pageId,
                color: stroke.color,
                baseWidth: stroke.baseWidth,
                toolType: 'pen',
                startPoint: stroke.points[0],
              },
            };
            ws.send(JSON.stringify(msg));
          }
        },
        onProvisionalStrokeUpdate: (strokeId, newPoints) => {
          const existing = provisionalStrokesRef.current.get(strokeId);
          if (existing) {
            existing.points.push(...newPoints);
          }
          requestCanvasRender();

          const ws = localMobileWsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            seqCounterRef.current += 1;
            const msg: ProtocolMessage = {
              type: 'stroke.points',
              timestamp: Date.now(),
              payload: {
                strokeId,
                pageId: activePageIdRef.current,
                seq: seqCounterRef.current,
                points: newPoints,
              },
            };
            ws.send(JSON.stringify(msg));
          }
        },
        onProvisionalStrokeCancel: (strokeId) => {
          provisionalStrokesRef.current.delete(strokeId);
          requestCanvasRender();
        },
        onStrokeCommit: (stroke, operationId) => {
          provisionalStrokesRef.current.delete(stroke.id);
          const ws = localMobileWsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            const msg: ProtocolMessage = {
              type: 'stroke.end',
              timestamp: Date.now(),
              payload: {
                operationId,
                notebookId: stroke.notebookId,
                pageId: stroke.pageId,
                cancelled: false,
                stroke,
              },
            };
            ws.send(JSON.stringify(msg));
          }
        },
        onStrokesErased: (eraseOp) => {
          const ws = localMobileWsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            const msg: ProtocolMessage = {
              type: 'strokes.erase',
              timestamp: Date.now(),
              payload: {
                operationId: eraseOp.operationId,
                notebookId: eraseOp.notebookId,
                pageId: eraseOp.pageId,
                targetStrokeIds: eraseOp.targetStrokeIds,
                removedStrokes: eraseOp.removedStrokes,
              },
            };
            ws.send(JSON.stringify(msg));
          }
        },
        onViewportChanged: (newVp) => {
          viewportRef.current = newVp;
          rendererRef.current.markCommittedDirty();
          setViewport(newVp);
          requestCanvasRender();
        },
        onHoverToolPreview: (role, lx, ly) => {
          if (role === 'stylus_eraser') {
            eraserPreviewRef.current = { x: lx, y: ly, radius: eraserRadiusRef.current };
            requestCanvasRender();
          } else if (eraserPreviewRef.current !== null) {
            eraserPreviewRef.current = null;
            requestCanvasRender();
          }
        },
      },
    });
    inputControllerRef.current = controller;
  }, []);

  // Interceptar Ctrl + Scroll dentro do canvas para dar zoom na própria página (sem dar zoom na janela do browser)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleCanvasWheel = (e: WheelEvent): void => {
      e.preventDefault();
      e.stopPropagation();

      const rect = canvas.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = Math.exp(-e.deltaY * 0.0022);
        const nextVp = applyPinchZoom(viewportRef.current, zoomFactor, focalX, focalY);
        updateViewportSync(nextVp);
      } else {
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        updateViewportSync((prev) => ({
          ...prev,
          panX: prev.panX - dx,
          panY: prev.panY - dy,
        }));
      }
    };

    canvas.addEventListener('wheel', handleCanvasWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleCanvasWheel);
    };
  }, []);

  // Sincronizar alterações de preferências e ferramentas sem reiniciar
  useEffect(() => {
    const ctrl = inputControllerRef.current;
    if (!ctrl) return;
    ctrl.updatePreferences(inputPrefs);
    try {
      localStorage.setItem('dn_input_prefs', JSON.stringify(inputPrefs));
    } catch {
      // Ignorar erro de storage
    }
  }, [inputPrefs]);

  useEffect(() => {
    const ctrl = inputControllerRef.current;
    if (!ctrl) return;
    ctrl.setActiveUiTool(activeTool);
    ctrl.setPenStyle(penColor, penWidth);
    ctrl.setEraserRadius(eraserRadius);
  }, [activeTool, penColor, penWidth, eraserRadius]);

  useEffect(() => {
    const ctrl = inputControllerRef.current;
    if (!ctrl) return;
    ctrl.setPageContext(activeNotebookId, activePageId);
  }, [activeNotebookId, activePageId]);

  useEffect(() => {
    rendererRef.current.markCommittedDirty();
    requestCanvasRender();
  }, [viewport]);

  useEffect(() => {
    requestCanvasRender();
  }, [pageSnapshot]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      rendererRef.current.markCommittedDirty();
      requestCanvasRender();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [showSidebar]);

  const applyIncomingPageSnapshot = (snap: PageStateSnapshot): void => {
    pageSnapshotRef.current = snap;
    setPageSnapshot(snap);
    spatialIndexRef.current.clear();
    for (const stroke of snap.strokes) {
      spatialIndexRef.current.insert(stroke);
    }
    rendererRef.current.markCommittedDirty();
    requestCanvasRender();
  };

  const requestCanvasRender = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
      canvas.width = Math.max(1, Math.floor(rect.width));
      canvas.height = Math.max(1, Math.floor(rect.height));
      rendererRef.current.markCommittedDirty();
    }

    const currentSnap = pageSnapshotRef.current;
    const currentVp = viewportRef.current;

    rendererRef.current.render({
      canvas,
      committedStrokes: currentSnap?.strokes ?? [],
      provisionalStrokes: provisionalStrokesRef.current,
      grid: currentSnap?.metadata.grid ?? DEFAULT_GRID_SETTINGS,
      backgroundColor: currentSnap?.metadata.backgroundColor ?? '#FFFFFF',
      viewport: currentVp,
      pageWidth: currentSnap?.metadata.width ?? DEFAULT_PAGE_WIDTH,
      pageHeight: currentSnap?.metadata.height ?? DEFAULT_PAGE_HEIGHT,
      eraserPreview: eraserPreviewRef.current,
    });
  };

  // Manipuladores de PointerEvents nativos (S Pen / Caneta Wacom / Toque / Mouse)
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Detectar se é S Pen / Stylus, borracha física (buttons === 32 / button === 5) ou dedo (touch)
    const isTouchFinger = e.pointerType === 'touch';
    const isEraserButton =
      simulateSPenButtonHeld ||
      (e.buttons & 32) !== 0 ||
      (e.buttons & 2) !== 0 ||
      e.button === 2 ||
      e.button === 5;

    inputControllerRef.current?.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: Math.round(e.timeStamp),
      eventTimeMs: Math.round(e.timeStamp),
      pointers: [
        {
          pointerId: e.pointerId,
          toolType: isTouchFinger ? 'finger' : 'stylus',
          screenX: x,
          screenY: y,
          pressure: e.pressure > 0 ? e.pressure : 0.55,
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          stylusButtonPressed: isEraserButton,
        },
      ],
    });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const isTouchFinger = e.pointerType === 'touch';
    const isEraserButton =
      simulateSPenButtonHeld || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0;

    if (e.buttons === 0 && !isTouchFinger) {
      inputControllerRef.current?.handleMotionEvent({
        action: 'ACTION_HOVER_MOVE',
        downTimeMs: Math.round(e.timeStamp),
        eventTimeMs: Math.round(e.timeStamp),
        pointers: [
          {
            pointerId: e.pointerId,
            toolType: 'stylus',
            screenX: x,
            screenY: y,
            pressure: 0,
            stylusButtonPressed: isEraserButton,
          },
        ],
      });
      return;
    }

    if (e.buttons === 0 && isTouchFinger) return;

    // Extrair pontos coalescidos (equivalente a getHistoricalX/Y de 240Hz no navegador/Wacom)
    const nativeEv = e.nativeEvent;
    const coalesced =
      typeof nativeEv.getCoalescedEvents === 'function' ? nativeEv.getCoalescedEvents() : [];
    const historicalSamples =
      coalesced.length > 1
        ? coalesced.slice(0, -1).map((ce) => ({
            screenX: ce.clientX - rect.left,
            screenY: ce.clientY - rect.top,
            pressure: ce.pressure > 0 ? ce.pressure : 0.55,
            tiltX: ce.tiltX,
            tiltY: ce.tiltY,
            eventTimeMs: Math.round(ce.timeStamp),
          }))
        : [];

    inputControllerRef.current?.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: Math.round(e.timeStamp),
      eventTimeMs: Math.round(e.timeStamp),
      pointers: [
        {
          pointerId: e.pointerId,
          toolType: isTouchFinger ? 'finger' : 'stylus',
          screenX: x,
          screenY: y,
          pressure: e.pressure > 0 ? e.pressure : 0.55,
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          stylusButtonPressed: isEraserButton,
          historicalSamples,
        },
      ],
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const isTouchFinger = e.pointerType === 'touch';
    const isEraserButton = simulateSPenButtonHeld;

    inputControllerRef.current?.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: Math.round(e.timeStamp),
      eventTimeMs: Math.round(e.timeStamp),
      pointers: [
        {
          pointerId: e.pointerId,
          toolType: isTouchFinger ? 'finger' : 'stylus',
          screenX: x,
          screenY: y,
          pressure: e.pressure > 0 ? e.pressure : 0.55,
          stylusButtonPressed: isEraserButton,
        },
      ],
    });
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    inputControllerRef.current?.handleMotionEvent({
      action: 'ACTION_CANCEL',
      downTimeMs: Math.round(e.timeStamp),
      eventTimeMs: Math.round(e.timeStamp),
      flagCanceled: true,
      pointers: [],
    });
  };

  // Ações de Caderno, Página, Pareamento e Exportação PDF
  const handleOpenPairingModal = async (): Promise<void> => {
    setShowPairingModal(true);
    const data = await desktopBridge.generatePairingQr({
      host: selectedHost || undefined,
      requireExplicitApproval: requireApproval,
    });
    setPairingData({ qr: data.qr, qrDataUrl: data.qrDataUrl });
    setServerStatus(data.status);
  };

  const handleCreateNotebook = async (): Promise<void> => {
    const title = `Caderno ${notebooks.length + 1}`;
    const res = await desktopBridge.createNotebook(title);
    setNotebooks(res.notebooks);
    setActiveNotebookId(res.activeNotebookId);
    setActivePageId(res.activePageId);
    if (res.activePage) applyIncomingPageSnapshot(res.activePage);
  };

  const handleDeleteNotebook = async (nbId: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const res = await desktopBridge.deleteNotebook(nbId);
    setNotebooks(res.notebooks);
    setActiveNotebookId(res.activeNotebookId);
    setActivePageId(res.activePageId);
    if (res.activePage) applyIncomingPageSnapshot(res.activePage);
  };

  const handleCreatePage = async (): Promise<void> => {
    const res = await desktopBridge.createPage(activeNotebookId);
    setNotebooks(res.notebooks);
    setActiveNotebookId(res.activeNotebookId);
    setActivePageId(res.activePageId);
    if (res.activePage) applyIncomingPageSnapshot(res.activePage);
  };

  const handleDeletePage = async (pgId: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const res = await desktopBridge.deletePage(pgId);
    setNotebooks(res.notebooks);
    setActiveNotebookId(res.activeNotebookId);
    setActivePageId(res.activePageId);
    if (res.activePage) applyIncomingPageSnapshot(res.activePage);
  };

  const handleSelectPage = async (nbId: string, pgId: string): Promise<void> => {
    const res = await desktopBridge.selectPage(nbId, pgId);
    setNotebooks(res.notebooks);
    setActiveNotebookId(res.activeNotebookId);
    setActivePageId(res.activePageId);
    if (res.activePage) applyIncomingPageSnapshot(res.activePage);
  };

  const handleUndo = async (): Promise<void> => {
    const snap = await desktopBridge.undo(activeNotebookId, activePageId);
    if (snap) applyIncomingPageSnapshot(snap);
  };

  const handleRedo = async (): Promise<void> => {
    const snap = await desktopBridge.redo(activeNotebookId, activePageId);
    if (snap) applyIncomingPageSnapshot(snap);
  };

  const handleUpdateGrid = async (partial: Partial<GridSettings>): Promise<void> => {
    const currentGrid = pageSnapshot?.metadata.grid ?? DEFAULT_GRID_SETTINGS;
    const updatedGrid: GridSettings = { ...currentGrid, ...partial };
    const snap = await desktopBridge.updateGrid(activePageId, updatedGrid);
    if (snap) applyIncomingPageSnapshot(snap);
  };

  const handleTogglePageOrientation = async (): Promise<void> => {
    const curW = pageSnapshot?.metadata.width ?? DEFAULT_PAGE_WIDTH;
    const curH = pageSnapshot?.metadata.height ?? DEFAULT_PAGE_HEIGHT;
    const isLandscape = curW > curH;
    const nextW = isLandscape ? DEFAULT_PAGE_WIDTH : DEFAULT_PAGE_HEIGHT;
    const nextH = isLandscape ? DEFAULT_PAGE_HEIGHT : DEFAULT_PAGE_WIDTH;
    const res = await desktopBridge.updatePageOrientation(activePageId, nextW, nextH);
    setNotebooks(res.notebooks);
    if (res.activePage) {
      applyIncomingPageSnapshot(res.activePage);
    }
  };

  const handleExportPdf = async (): Promise<void> => {
    try {
      setPdfExportFeedback(null);
      let pagesToExport: PageStateSnapshot[] = [];
      if (pdfScope === 'current_page' && pageSnapshot) {
        pagesToExport = [pageSnapshot];
      } else {
        pagesToExport = await desktopBridge.fetchNotebookPagesForExport(activeNotebookId);
      }

      if (pagesToExport.length === 0) {
        setPdfExportFeedback('Nenhuma página disponível para exportação.');
        return;
      }

      const pdfBytes = generateVectorPdfBytes(pagesToExport, {
        includeGrid: pdfIncludeGrid,
        title: `DigitalNotebook_${activeNotebookId}`,
      });

      const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
      const defaultFileName =
        pdfScope === 'current_page'
          ? `DigitalNotebook_${activePageId}.pdf`
          : `DigitalNotebook_${activeNotebookId}_Completo.pdf`;

      const winWithPicker = window as unknown as {
        showSaveFilePicker?: (opts: unknown) => Promise<{
          createWritable: () => Promise<{
            write: (data: Blob) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      };

      if (typeof winWithPicker.showSaveFilePicker === 'function') {
        const handle = await winWithPicker.showSaveFilePicker({
          suggestedName: defaultFileName,
          types: [
            {
              description: 'Documento PDF Vetorial',
              accept: { 'application/pdf': ['.pdf'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }

      setPdfExportFeedback(
        `PDF vetorial exportado com sucesso (${pagesToExport.length} página(s), ${pdfBytes.byteLength} bytes).`
      );
    } catch (err) {
      setPdfExportFeedback(
        `Erro ao exportar PDF (os dados originais estão preservados): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const currentGrid = pageSnapshot?.metadata.grid ?? DEFAULT_GRID_SETTINGS;

  return (
    <div className="app-layout" onContextMenu={(e) => e.preventDefault()}>
      {/* Sidebar: Cadernos e Páginas (exibida quando showSidebar === true, com botão próprio de ocultar) */}
      {showSidebar && (
        <aside className="sidebar">
          <div
            className="sidebar-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: '8px',
            }}
          >
            <div>
              <h1>NebulaInk</h1>
              <p>S Pen Vector Studio • S24 Ultra + Desktop</p>
            </div>
            <button
              className="btn"
              style={{
                background: '#1e293b',
                color: '#f8fafc',
                borderColor: '#334155',
                padding: '4px 8px',
                fontSize: '12px',
                flexShrink: 0,
              }}
              onClick={() => setShowSidebar(false)}
              title="Esconder painel lateral"
            >
              ◀ Ocultar
            </button>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <span>Cadernos ({notebooks.length})</span>
              <button className="btn btn-primary" onClick={handleCreateNotebook}>
                + Caderno
              </button>
            </div>

            {notebooks.map((nb) => {
              const isNbActive = nb.id === activeNotebookId;
              return (
                <div key={nb.id} className="notebook-item">
                  <div
                    className={`notebook-title-row ${isNbActive ? 'active' : ''}`}
                    onClick={() => {
                      if (nb.pages[0]) {
                        handleSelectPage(nb.id, nb.pages[0].id);
                      }
                    }}
                  >
                    <span>{nb.title}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '11px', opacity: 0.85 }}>{nb.pages.length} pág.</span>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '2px 6px', fontSize: '11px', lineHeight: 1.2 }}
                        title="Excluir Caderno"
                        onClick={(e) => handleDeleteNotebook(nb.id, e)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {isNbActive && (
                    <div className="page-list">
                      {nb.pages.map((pg, idx) => (
                        <div
                          key={pg.id}
                          className={`page-item ${pg.id === activePageId ? 'active' : ''}`}
                          onClick={() => handleSelectPage(nb.id, pg.id)}
                        >
                          <span>{pg.title || `Página ${idx + 1}`}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span>#{idx + 1}</span>
                            <button
                              className="btn btn-danger"
                              style={{ padding: '1px 5px', fontSize: '10px', lineHeight: 1.1 }}
                              title="Excluir Página"
                              onClick={(e) => handleDeletePage(pg.id, e)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        className="btn"
                        style={{ width: '100%', marginTop: '6px' }}
                        onClick={handleCreatePage}
                      >
                        + Nova Página
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* Área Principal */}
      <main className="main-area">
        {/* Barra Superior */}
        <header className="top-toolbar">
          <div className="toolbar-group">
            {!showSidebar && (
              <button
                className="btn"
                onClick={() => setShowSidebar(true)}
                title="Abrir painel de cadernos e páginas"
              >
                ☰ Cadernos
              </button>
            )}
            <span
              className={`status-badge ${
                (serverStatus?.connectedMobileCount ?? 0) > 0 ? 'synced' : 'waiting'
              }`}
            >
              ●{' '}
              {(serverStatus?.connectedMobileCount ?? 0) > 0
                ? `Sincronizado (${serverStatus?.connectedMobileCount} S Pen conectada)`
                : 'Servidor Local Ativo'}
            </span>
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              LAN: ws://{serverStatus?.preferredHost ?? '192.168.100.8'}:
              {serverStatus?.port ?? 8765}
            </span>
            <button className="btn btn-primary" onClick={handleOpenPairingModal}>
              Parear S24 Ultra (QR Code)
            </button>
            {(serverStatus?.pendingApprovals.length ?? 0) > 0 && (
              <button className="btn btn-danger" onClick={handleOpenPairingModal}>
                Aprovar Dispositivo ({serverStatus?.pendingApprovals.length})
              </button>
            )}
          </div>

          <div className="toolbar-group">
            <button
              className="btn"
              disabled={!pageSnapshot?.canUndo}
              onClick={handleUndo}
              title="Desfazer última operação (distinto da borracha da S Pen)"
            >
              ↶ Desfazer
            </button>
            <button
              className="btn"
              disabled={!pageSnapshot?.canRedo}
              onClick={handleRedo}
              title="Refazer operação"
            >
              ↷ Refazer
            </button>
            <button
              className="btn"
              onClick={handleTogglePageOrientation}
              title="Alternar posicionamento da folha entre Vertical (Retrato) e Horizontal (Paisagem)"
            >
              📄 Folha:{' '}
              {(pageSnapshot?.metadata.width ?? DEFAULT_PAGE_WIDTH) >
              (pageSnapshot?.metadata.height ?? DEFAULT_PAGE_HEIGHT)
                ? 'Horizontal'
                : 'Vertical'}
            </button>
            <button className="btn" onClick={() => setShowGridModal(true)}>
              Grade Pontilhada
            </button>
            <button className="btn" onClick={() => setShowInputPrefsModal(true)}>
              Entrada / Gestos
            </button>
            <button className="btn btn-primary" onClick={() => setShowPdfModal(true)}>
              Exportar PDF Vetorial
            </button>
          </div>
        </header>

        {/* Sub-barra de Ferramentas S Pen e Zoom */}
        <div className="sub-toolbar">
          <div className="toolbar-group">
            <button
              className={`btn ${activeTool === 'pen' && !simulateSPenButtonHeld ? 'btn-active' : ''}`}
              onClick={() => {
                setActiveTool('pen');
                setSimulateSPenButtonHeld(false);
              }}
            >
              ✒ Caneta S Pen
            </button>
            <button
              className={`btn ${activeTool === 'eraser' ? 'btn-active' : ''}`}
              onClick={() => setActiveTool('eraser')}
            >
              ⌫ Borracha (Traço Inteiro)
            </button>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 8px',
                background: simulateSPenButtonHeld ? '#7f1d1d' : '#1e293b',
                color: simulateSPenButtonHeld ? '#fecaca' : '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '12px',
              }}
              title="Simula manter o botão físico lateral da S Pen pressionado (apaga o traço inteiro tocado)"
            >
              <input
                type="checkbox"
                checked={simulateSPenButtonHeld}
                onChange={(e) => setSimulateSPenButtonHeld(e.target.checked)}
              />
              Botão Físico S Pen Pressionado
            </label>

            <div className="toolbar-group" style={{ marginLeft: '8px' }}>
              {PRESET_COLORS.map((hex) => (
                <div
                  key={hex}
                  className={`color-swatch ${penColor === hex ? 'selected' : ''}`}
                  style={{ backgroundColor: hex }}
                  onClick={() => {
                    setPenColor(hex);
                    setActiveTool('pen');
                    setSimulateSPenButtonHeld(false);
                  }}
                />
              ))}
            </div>

            {activeTool === 'pen' && !simulateSPenButtonHeld ? (
              <div className="toolbar-group">
                <span>Espessura: {penWidth.toFixed(1)}pt</span>
                <input
                  type="range"
                  min={1.0}
                  max={18.0}
                  step={0.5}
                  value={penWidth}
                  onChange={(e) => setPenWidth(Number(e.target.value))}
                />
              </div>
            ) : (
              <div className="toolbar-group">
                <span>Raio Borracha: {eraserRadius.toFixed(0)}px</span>
                <input
                  type="range"
                  min={6}
                  max={40}
                  step={1}
                  value={eraserRadius}
                  onChange={(e) => setEraserRadius(Number(e.target.value))}
                />
              </div>
            )}
          </div>

          <div className="toolbar-group">
            <span>Traços: {pageSnapshot?.strokes.length ?? 0}</span>
            <button
              className="btn"
              onClick={() => {
                const canvas = canvasRef.current;
                const cx = canvas ? canvas.clientWidth * 0.5 : 400;
                const cy = canvas ? canvas.clientHeight * 0.5 : 400;
                updateViewportSync((v) => applyPinchZoom(v, 1 / 1.15, cx, cy));
              }}
            >
              -
            </button>
            <span style={{ minWidth: '48px', textAlign: 'center' }}>
              {Math.round(viewport.scale * 100)}%
            </span>
            <button
              className="btn"
              onClick={() => {
                const canvas = canvasRef.current;
                const cx = canvas ? canvas.clientWidth * 0.5 : 400;
                const cy = canvas ? canvas.clientHeight * 0.5 : 400;
                updateViewportSync((v) => applyPinchZoom(v, 1.15, cx, cy));
              }}
            >
              +
            </button>
            <button
              className="btn"
              onClick={() =>
                updateViewportSync({
                  ...createDefaultViewport(),
                  scale: 0.56,
                  panX: 160,
                  panY: 24,
                })
              }
            >
              Ajustar Página
            </button>
          </div>
        </div>

        {/* Área de Escrita e Visualização + Barras de Navegação Discretas */}
        <div className="viewport-container">
          <canvas
            ref={canvasRef}
            className="drawing-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          />

          {showScrollbars && (
            <>
              {/* Barra Vertical Discreta */}
              <div
                className="discrete-scrollbar-v"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientY - rect.top) / rect.height;
                  updateViewportSync((v) => ({
                    ...v,
                    panY: 40 - ratio * DEFAULT_PAGE_HEIGHT * v.scale * 0.6,
                  }));
                }}
              >
                <div
                  className="scrollbar-thumb"
                  style={{
                    width: '8px',
                    height: '54px',
                    left: '1px',
                    top: `${Math.max(
                      0,
                      Math.min(
                        80,
                        ((-viewport.panY + 40) / (DEFAULT_PAGE_HEIGHT * viewport.scale)) * 100
                      )
                    )}%`,
                  }}
                />
              </div>

              {/* Barra Horizontal Discreta */}
              <div
                className="discrete-scrollbar-h"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientX - rect.left) / rect.width;
                  updateViewportSync((v) => ({
                    ...v,
                    panX: 160 - ratio * DEFAULT_PAGE_WIDTH * v.scale * 0.6,
                  }));
                }}
              >
                <div
                  className="scrollbar-thumb"
                  style={{
                    height: '8px',
                    width: '54px',
                    top: '1px',
                    left: `${Math.max(
                      0,
                      Math.min(
                        80,
                        ((-viewport.panX + 160) / (DEFAULT_PAGE_WIDTH * viewport.scale)) * 100
                      )
                    )}%`,
                  }}
                />
              </div>
            </>
          )}
        </div>
      </main>

      {/* Modal de Pareamento via QR Code + Aprovação de Dispositivos */}
      {showPairingModal && (
        <div className="modal-backdrop" onClick={() => setShowPairingModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Parear Samsung Galaxy S24 Ultra</h2>
            <p className="modal-row" style={{ color: '#94a3b8' }}>
              Escaneie o QR Code com o aplicativo Android na mesma rede Wi-Fi. O token é temporário
              (expira em 5 minutos) e de uso único.
            </p>

            <div className="modal-row">
              <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Interface de Rede Local (Wi-Fi prioritário):
              </label>
              <select
                value={selectedHost}
                onChange={async (e) => {
                  const newHost = e.target.value;
                  setSelectedHost(newHost);
                  const res = await desktopBridge.generatePairingQr({
                    host: newHost,
                    requireExplicitApproval: requireApproval,
                  });
                  setPairingData({ qr: res.qr, qrDataUrl: res.qrDataUrl });
                }}
                style={{ width: '100%', padding: '6px', borderRadius: '6px' }}
              >
                {(serverStatus?.candidateHosts ?? ['192.168.100.8']).map((ip) => (
                  <option key={ip} value={ip}>
                    {ip} {ip.startsWith('192.168.') ? '(Rede Wi-Fi Local Recomendada)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="modal-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={requireApproval}
                  onChange={async (e) => {
                    const checked = e.target.checked;
                    setRequireApproval(checked);
                    const res = await desktopBridge.generatePairingQr({
                      host: selectedHost,
                      requireExplicitApproval: checked,
                    });
                    setPairingData({ qr: res.qr, qrDataUrl: res.qrDataUrl });
                    setServerStatus(res.status);
                  }}
                />
                Exigir aprovação manual na tela antes de autorizar novo dispositivo
              </label>
            </div>

            {pairingData && (
              <div style={{ textAlign: 'center', margin: '12px 0' }}>
                <img
                  src={pairingData.qrDataUrl}
                  alt="QR Code de Pareamento"
                  style={{
                    width: '210px',
                    height: '210px',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    background: '#ffffff',
                    padding: '4px',
                  }}
                />
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px' }}>
                  <div>
                    <strong>Servidor:</strong> ws://{pairingData.qr.host}:{pairingData.qr.port}
                  </div>
                  <div>
                    <strong>Token Temporário:</strong> <code>{pairingData.qr.pairingToken}</code>
                  </div>
                </div>
              </div>
            )}

            {(serverStatus?.pendingApprovals.length ?? 0) > 0 && (
              <div
                style={{
                  background: '#fef3c7',
                  padding: '10px',
                  borderRadius: '8px',
                  marginBottom: '12px',
                }}
              >
                <strong style={{ fontSize: '13px' }}>Solicitações de Pareamento Pendentes:</strong>
                {serverStatus?.pendingApprovals.map((req) => (
                  <div
                    key={req.deviceId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginTop: '6px',
                    }}
                  >
                    <span style={{ fontSize: '12px' }}>
                      {req.deviceName} ({req.deviceId})
                    </span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="btn btn-primary"
                        onClick={async () => {
                          const st = await desktopBridge.approveDevice(req.deviceId, true);
                          setServerStatus(st);
                        }}
                      >
                        Aprovar
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={async () => {
                          const st = await desktopBridge.approveDevice(req.deviceId, false);
                          setServerStatus(st);
                        }}
                      >
                        Rejeitar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={handleOpenPairingModal}>
                Gerar Novo Token
              </button>
              <button className="btn btn-primary" onClick={() => setShowPairingModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Grade Pontilhada */}
      {showGridModal && (
        <div className="modal-backdrop" onClick={() => setShowGridModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Configuração da Grade Pontilhada</h2>
            <div className="modal-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={currentGrid.enabled}
                  onChange={(e) => handleUpdateGrid({ enabled: e.target.checked })}
                />
                Exibir grade pontilhada na página
              </label>
            </div>
            <div className="modal-row">
              <label>Espaçamento dos pontos: {currentGrid.spacing}px</label>
              <input
                type="range"
                min={15}
                max={60}
                step={5}
                value={currentGrid.spacing}
                onChange={(e) => handleUpdateGrid({ spacing: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-row">
              <label>Opacidade dos pontos: {Math.round(currentGrid.opacity * 100)}%</label>
              <input
                type="range"
                min={0.1}
                max={1.0}
                step={0.05}
                value={currentGrid.opacity}
                onChange={(e) => handleUpdateGrid({ opacity: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-row">
              <label>Cor dos pontos: </label>
              <input
                type="color"
                value={currentGrid.color}
                onChange={(e) => handleUpdateGrid({ color: e.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setShowGridModal(false)}>
                Concluído
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Configurações de Entrada e Gestos */}
      {showInputPrefsModal && (
        <div className="modal-backdrop" onClick={() => setShowInputPrefsModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Configurações de Entrada (S Pen & Dedo)</h2>
            <div className="modal-row">
              <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Modo do Dedo (fingerMode):
              </label>
              <select
                value={inputPrefs.fingerMode}
                onChange={(e) =>
                  setInputPrefs((p) => ({ ...p, fingerMode: e.target.value as FingerMode }))
                }
                style={{ width: '100%', padding: '6px' }}
              >
                <option value="both">both (Horizontal e Vertical)</option>
                <option value="vertical">vertical (Apenas Vertical)</option>
                <option value="horizontal">horizontal (Apenas Horizontal)</option>
                <option value="none">none (Desativado — apenas S Pen ativa)</option>
              </select>
            </div>

            <div className="modal-row">
              <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Modo de Scroll (scrollMode):
              </label>
              <select
                value={inputPrefs.scrollMode}
                onChange={(e) =>
                  setInputPrefs((p) => ({ ...p, scrollMode: e.target.value as ScrollMode }))
                }
                style={{ width: '100%', padding: '6px' }}
              >
                <option value="free">free (Movimento livre inclusive diagonal)</option>
                <option value="axisLocked">axisLocked (Trava no eixo dominante do gesto)</option>
              </select>
            </div>

            <div className="modal-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={inputPrefs.palmRejection}
                  onChange={(e) =>
                    setInputPrefs((p) => ({ ...p, palmRejection: e.target.checked }))
                  }
                />
                Rejeição de Palma ativa (palmRejection)
              </label>
            </div>

            <div className="modal-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={inputPrefs.pinchZoom}
                  onChange={(e) => setInputPrefs((p) => ({ ...p, pinchZoom: e.target.checked }))}
                />
                Zoom por Pinça de Dois Dedos (pinchZoom)
              </label>
            </div>

            <div className="modal-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={showScrollbars}
                  onChange={(e) => setShowScrollbars(e.target.checked)}
                />
                Exibir barras de navegação discretas nas bordas
              </label>
            </div>

            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setShowInputPrefsModal(false)}>
                Concluído
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Exportação PDF Vetorial */}
      {showPdfModal && (
        <div className="modal-backdrop" onClick={() => setShowPdfModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Exportar para PDF Vetorial</h2>
            <p className="modal-row" style={{ color: '#94a3b8' }}>
              O documento PDF será gerado com <strong>folha branca (#FFFFFF)</strong> e{' '}
              <strong>escrita preta (#000000)</strong> diretamente a partir das geometrias vetoriais
              e pressões persistidas no SQLite (sem uso de captura de tela).
            </p>

            <div className="modal-row">
              <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Escopo da Exportação:
              </label>
              <select
                value={pdfScope}
                onChange={(e) =>
                  setPdfScope(e.target.value as 'current_page' | 'entire_notebook')
                }
                style={{ width: '100%', padding: '6px' }}
              >
                <option value="current_page">Apenas a Página Atual</option>
                <option value="entire_notebook">Caderno Inteiro (1 página por folha PDF)</option>
              </select>
            </div>

            <div className="modal-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={pdfIncludeGrid}
                  onChange={(e) => setPdfIncludeGrid(e.target.checked)}
                />
                Incluir grade pontilhada vetorial no PDF
              </label>
            </div>

            {pdfExportFeedback && (
              <div
                className="modal-row"
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: pdfExportFeedback.startsWith('Erro') ? '#450a0a' : '#064e3b',
                  color: pdfExportFeedback.startsWith('Erro') ? '#fecaca' : '#6ee7b7',
                  border: pdfExportFeedback.startsWith('Erro')
                    ? '1px solid #991b1b'
                    : '1px solid #059669',
                }}
              >
                {pdfExportFeedback}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={() => setShowPdfModal(false)}>
                Fechar
              </button>
              <button className="btn btn-primary" onClick={handleExportPdf}>
                Gerar e Salvar PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
