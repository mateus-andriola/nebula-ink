import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { availableMonitors, primaryMonitor, type Monitor } from '@tauri-apps/api/window';
import { type ServerStatusInfo, desktopBridge } from '../services/desktopBridge.ts';
import {
  setDesktopOverlayMonitor,
  showDesktopOverlayAgain,
  synchronizeDesktopOverlay,
  type DesktopMonitorTarget,
} from '../services/desktopOverlay.ts';

function monitorIdentity(monitor: Monitor): string {
  return `${monitor.position.x},${monitor.position.y}:${monitor.size.width}x${monitor.size.height}:${monitor.scaleFactor}`;
}

export function DesktopHostApp(): React.ReactElement {
  const shortcutModifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';
  const [status, setStatus] = useState<ServerStatusInfo | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [pairingAddress, setPairingAddress] = useState<string | null>(null);
  const [layerActive, setLayerActive] = useState(false);
  const [layerVisible, setLayerVisible] = useState(false);
  const [layerEnabled, setLayerEnabled] = useState(() => localStorage.getItem('nebulaInk.reflectionEnabled') !== 'false');
  const [monitors, setMonitors] = useState<DesktopMonitorTarget[]>([]);
  const [selectedMonitorId, setSelectedMonitorId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selectedMonitor = useMemo(
    () => monitors.find((monitor) => monitor.id === selectedMonitorId) ?? null,
    [monitors, selectedMonitorId],
  );
  const layerEnabledRef = useRef(layerEnabled);
  const layerActiveRef = useRef(layerActive);
  layerEnabledRef.current = layerEnabled;
  layerActiveRef.current = layerActive;

  const refreshMonitors = useCallback(async (): Promise<void> => {
    if (!isTauri()) return;
    try {
      const [available, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
      const primaryId = primary ? monitorIdentity(primary) : null;
      const options = available.map((monitor, index): DesktopMonitorTarget => {
        const position = monitor.position.toLogical(monitor.scaleFactor);
        const size = monitor.size.toLogical(monitor.scaleFactor);
        const id = monitorIdentity(monitor);
        return {
          id,
          name: monitor.name?.trim() || `Monitor ${index + 1}`,
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          physicalWidth: monitor.size.width,
          physicalHeight: monitor.size.height,
          scaleFactor: monitor.scaleFactor,
          primary: id === primaryId,
        };
      });
      setMonitors(options);
      const saved = localStorage.getItem('nebulaInk.selectedMonitor');
      const chosen = options.some((monitor) => monitor.id === saved)
        ? saved!
        : options.find((monitor) => monitor.primary)?.id ?? options[0]?.id ?? '';
      setSelectedMonitorId(chosen);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível listar os monitores.');
    }
  }, []);

  const createPairingCode = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const result = await desktopBridge.generatePairingQr();
      setStatus(result.status);
      setQrImage(result.qrDataUrl);
      setPairingAddress(`${result.qr.host}:${result.qr.port}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível gerar o QR Code.');
    }
  }, []);

  useEffect(() => {
    void refreshMonitors();
  }, [refreshMonitors]);

  useEffect(() => {
    if (!selectedMonitor) return;
    localStorage.setItem('nebulaInk.selectedMonitor', selectedMonitor.id);
    void setDesktopOverlayMonitor(selectedMonitor).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Não foi possível mover a camada para o monitor.');
    });

    let published = false;
    const publishSelectedBounds = (): void => {
      if (published) return;
      void desktopBridge.updateScreenBounds(selectedMonitor.width, selectedMonitor.height)
        .then(() => { published = true; })
        .catch(() => {});
    };
    publishSelectedBounds();
    const boundsRetry = window.setInterval(publishSelectedBounds, 2000);
    return () => window.clearInterval(boundsRetry);
  }, [selectedMonitor]);

  useEffect(() => {
    void createPairingCode();
    void desktopBridge.fetchState().then((state) => setStatus(state.status)).catch(() => {});

    const unsubscribe = desktopBridge.connectRealtime((event) => {
      if (event.event === 'desktop.init' || event.event === 'status.updated') {
        setStatus(event.status);
      }
      if (event.event === 'viewport.updated') {
        layerActiveRef.current = event.active;
        setLayerActive(event.active);
        const shouldShow = event.active && layerEnabledRef.current;
        setLayerVisible(shouldShow);
        void synchronizeDesktopOverlay(shouldShow)
          .catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a camada.');
          });
      }
    });

    const unlistenOverlayEvents: Array<() => void> = [];
    void listen('reflection:user-closed', () => setLayerVisible(false)).then((unlisten) => {
      unlistenOverlayEvents.push(unlisten);
    });
    void listen('reflection:user-hidden', () => setLayerVisible(false)).then((unlisten) => {
      unlistenOverlayEvents.push(unlisten);
    });
    void listen('reflection:user-shown', () => setLayerVisible(true)).then((unlisten) => {
      unlistenOverlayEvents.push(unlisten);
    });
    void listen<boolean>('reflection:set-enabled', (event) => {
      const enabled = event.payload;
      layerEnabledRef.current = enabled;
      setLayerEnabled(enabled);
      localStorage.setItem('nebulaInk.reflectionEnabled', String(enabled));
      if (enabled) {
        void synchronizeDesktopOverlay(true).then(() => setLayerVisible(true)).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Não foi possível ativar o reflexo.');
        });
      } else {
        void synchronizeDesktopOverlay(false).then(() => setLayerVisible(false)).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Não foi possível desativar o reflexo.');
        });
      }
    }).then((unlisten) => {
      unlistenOverlayEvents.push(unlisten);
    });

    return () => {
      unsubscribe();
      for (const unlisten of unlistenOverlayEvents) unlisten();
    };
  }, [createPairingCode]);

  const reopenLayer = (): void => {
    layerEnabledRef.current = true;
    setLayerEnabled(true);
    localStorage.setItem('nebulaInk.reflectionEnabled', 'true');
    void showDesktopOverlayAgain()
      .then(() => setLayerVisible(true))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível mostrar a camada.');
      });
  };

  const openLayer = (): void => {
    layerEnabledRef.current = true;
    setLayerEnabled(true);
    localStorage.setItem('nebulaInk.reflectionEnabled', 'true');
    void synchronizeDesktopOverlay(true)
      .then(() => setLayerVisible(true))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível abrir a camada.');
      });
  };

  const closeLayer = (): void => {
    layerEnabledRef.current = false;
    setLayerEnabled(false);
    localStorage.setItem('nebulaInk.reflectionEnabled', 'false');
    void synchronizeDesktopOverlay(false)
      .then(() => setLayerVisible(false))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível fechar a camada.');
      });
  };

  return (
    <main className="desktop-host">
      <header className="host-header">
        <img className="host-brand-mark" src="/icons/nebula-desktop.svg" alt="" />
        <div>
          <p className="host-eyebrow">NEBULAINK · DESKTOP</p>
          <h1>Escreva sobre a tela</h1>
          <p className="host-subtitle">O computador mostra os traços do celular por cima dos seus aplicativos.</p>
        </div>
      </header>

      <section className="host-monitor-card">
        <div>
          <p className="host-eyebrow">TELA DE DESENHO</p>
          <label htmlFor="desktop-monitor-select">Monitor que será replicado</label>
        </div>
        <select
          id="desktop-monitor-select"
          value={selectedMonitorId}
          onChange={(event) => setSelectedMonitorId(event.currentTarget.value)}
          disabled={monitors.length === 0}
        >
          {monitors.length === 0 ? <option value="">Procurando monitores…</option> : null}
          {monitors.map((monitor) => (
            <option key={monitor.id} value={monitor.id}>
              {monitor.name}{monitor.primary ? ' · Principal' : ''} — {monitor.physicalWidth} × {monitor.physicalHeight}
            </option>
          ))}
        </select>
        <button className="host-button host-button-quiet host-monitor-refresh" onClick={() => void refreshMonitors()}>
          Atualizar
        </button>
      </section>

      <section className={`host-layer-card ${layerActive && layerVisible ? 'is-active' : ''}`}>
        <div className="host-layer-status">
          <span className="host-status-dot" />
          <div>
            <strong>
              {!layerEnabled
                ? 'Reflexo desativado'
                : !layerActive
                ? layerVisible ? 'Camada transparente aberta' : 'Camada aguardando o celular'
                : layerVisible
                  ? 'Monitor inteiro pronto para escrita'
                  : 'Camada oculta'}
            </strong>
            <span>
              {!layerEnabled
                ? 'Ative o reflexo aqui ou pelo ícone do NebulaInk na área de notificação.'
                : !layerActive
                ? layerVisible
                  ? 'A camada está aberta e pronta; conecte o celular e ative “▣ PC” para projetar a escrita.'
                  : 'No celular, abra o quadro e toque em “▣ PC”. Você também pode abrir a camada transparente agora.'
                : layerVisible
                  ? 'O quadro do celular projeta os traços sobre a tela inteira.'
                  : 'A escrita do celular continua ativa; mostre a camada novamente quando quiser.'}
            </span>
          </div>
        </div>
        {!layerActive ? (
          <div className="host-layer-controls">
            <button className="host-button host-button-quiet" onClick={layerEnabled ? closeLayer : openLayer}>
              {layerEnabled ? 'Desativar reflexo' : 'Ativar reflexo'}
            </button>
            {layerEnabled && !layerVisible ? (
              <button className="host-button host-button-quiet" onClick={openLayer}>Abrir camada transparente</button>
            ) : null}
          </div>
        ) : null}
        {layerActive ? (
          <div className="host-layer-controls">
            <span>O contorno pontilhado acompanha a proporção e a orientação do celular; use zoom e pan para escolher a área.</span>
            <button className="host-button host-button-quiet" onClick={layerEnabled ? closeLayer : openLayer}>
              {layerEnabled ? 'Desativar reflexo' : 'Ativar reflexo'}
            </button>
            {layerEnabled && !layerVisible ? (
              <button className="host-button host-button-quiet" onClick={reopenLayer}>Mostrar novamente</button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="host-pairing-card">
        <div className="host-card-heading">
          <div>
            <p className="host-eyebrow">CONECTAR CELULAR</p>
            <h2>Leia o QR Code</h2>
          </div>
          <span className={`host-connection-pill ${status?.connectedMobileCount ? 'connected' : ''}`}>
            {status?.connectedMobileCount ? 'Conectado' : 'Aguardando'}
          </span>
        </div>
        <div className="host-pairing-body">
          <div className="host-qr-frame">
            {qrImage ? <img src={qrImage} alt="QR Code para conectar o celular" /> : <span>Gerando QR…</span>}
          </div>
          <div className="host-pairing-instructions">
            <p>1. Conecte o celular à mesma rede Wi-Fi.</p>
            <p>2. No app NebulaInk, escaneie este código.</p>
            <p>3. Toque em <strong>▣ PC</strong> no quadro para começar a escrever sobre a tela.</p>
            {pairingAddress ? <span className="host-address">{pairingAddress}</span> : null}
          </div>
        </div>
        <button className="host-button host-button-primary" onClick={() => void createPairingCode()}>
          Gerar novo QR Code
        </button>
      </section>

      <footer className="host-footer">
        <span>Atalhos da camada</span>
        <span><kbd>{shortcutModifier}</kbd> + <kbd>Shift</kbd> + <kbd>F9</kbd> mostra ou oculta a camada</span>
        <span><kbd>{shortcutModifier}</kbd> + <kbd>Shift</kbd> + <kbd>F10</kbd> fecha a camada</span>
      </footer>
      {error ? <p className="host-error" role="alert">{error}</p> : null}
    </main>
  );
}
