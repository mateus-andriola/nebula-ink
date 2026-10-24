import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/window';

const OVERLAY_LABEL = 'phone-reflection';

export interface DesktopMonitorTarget {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  physicalWidth: number;
  physicalHeight: number;
  scaleFactor: number;
  primary: boolean;
}

let desired = false;
let opening = false;
let known = false;
let suppressed = false;
let selectedMonitor: DesktopMonitorTarget | null = null;

export async function setDesktopOverlayMonitor(monitor: DesktopMonitorTarget): Promise<void> {
  selectedMonitor = monitor;
  if (!isTauri()) return;

  const overlay = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  if (!overlay) return;

  await overlay.setFullscreen(false);
  await overlay.setPosition(new LogicalPosition(monitor.x, monitor.y));
  await overlay.setSize(new LogicalSize(monitor.width, monitor.height));
}

export async function synchronizeDesktopOverlay(active: boolean): Promise<void> {
  if (!isTauri()) return;
  desired = active;

  if (!active) {
    suppressed = false;
    const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
    known = false;
    opening = false;
    if (existing) await existing.close();
    return;
  }
  if (suppressed || known || opening) return;

  opening = true;
  const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  if (!desired) {
    opening = false;
    return;
  }
  if (existing) {
    known = true;
    opening = false;
    await existing.show();
    return;
  }

  const monitor = selectedMonitor;
  const created = new WebviewWindow(OVERLAY_LABEL, {
    url: 'index.html?reflection=1',
    title: 'NebulaInk — Escrita sobre o monitor',
    ...(monitor ? {
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
    } : { fullscreen: true }),
    resizable: false,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,
    focusable: false,
    visible: false,
  });

  void created.once('tauri://created', () => {
    known = true;
    if (desired) {
      void invoke('set_reflection_click_through', { enabled: true })
        .then(() => { opening = false; })
        .catch(() => {
          opening = false;
          known = false;
          void created.close();
        });
    } else {
      opening = false;
      void created.close();
    }
  });
  void created.once('tauri://error', () => {
    opening = false;
    known = false;
  });
  void created.once('tauri://destroyed', () => {
    known = false;
    opening = false;
    if (desired) suppressed = true;
    void emit('reflection:user-closed');
  });
}

export async function showDesktopOverlayAgain(): Promise<void> {
  suppressed = false;
  const overlay = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  if (overlay) {
    known = true;
    await overlay.show();
    return;
  }
  if (desired) await synchronizeDesktopOverlay(true);
}
