# NebulaInk — S Pen Vector Studio (Samsung Galaxy S24 Ultra + Desktop Server)

Estúdio de caderno digital e escrita vetorial de baixa latência em modo Dark que transforma um **Samsung Galaxy S24 Ultra** em uma superfície de escrita e desenho geométrico com **S Pen** sincronizada em tempo real com o **NebulaInk Server** no computador (via Wi-Fi LAN ou USB).

Permite escrever e desenhar com a **S Pen** (preservando pressão, inclinação e pontos históricos de 240Hz), apagar traços inteiros ao manter pressionado o botão físico lateral da S Pen (sem confundir com desfazer), navegar com gestos de dedo configuráveis, visualizar os traços em tempo real no Desktop, organizar anotações em cadernos e páginas persistidos em **SQLite** e exportar os documentos para **PDF 100% vetorial**.

---

## 1. Estrutura do Monorepo

```text
.
├── protocol/                  # Contratos tipados do protocolo WebSocket, modelo geométrico,
│                              # SpatialGridIndex, WholeStrokeEraserSession e NotebookInputController
├── android-app/               # Aplicativo Android nativo (Kotlin, Jetpack Compose, SPenCanvasView,
│                              # MotionEventRouter, Room SQLite Buffer, Preferences DataStore, OkHttp WS)
├── desktop-app/               # Aplicativo Desktop (React, TypeScript Strict, Vite, Tauri 2 + Rust,
│   ├── src-tauri/             # Backend nativo Tauri 2 em Rust (rusqlite + tokio-tungstenite)
│   ├── server/                # Servidor local SQLite (node:sqlite) + WebSocket (ws) + QR Pairing
│   ├── src/                   # Interface React, Canvas2DRenderer incremental e VectorPdfExporter
│   └── tests/                 # Suíte de testes automatizados (Unidade, SQLite, Integração WS e PDF)
└── docs/                      # Documentação técnica completa
    ├── ENVIRONMENT_REPORT.md
    ├── IMPLEMENTATION_PLAN.md
    ├── ARCHITECTURE.md
    ├── PROTOCOL.md
    ├── PAIRING_AND_SECURITY.md
    ├── PDF_EXPORT.md
    ├── PHYSICAL_VALIDATION_S24_ULTRA.md
    └── TEST_REPORT.md
```

---

## 2. Instruções para Iniciar o Aplicativo Desktop

### Pré-requisitos
- **Node.js 22.5+ / 24+** (já instalado neste ambiente: `v24.18.0`, com suporte nativo a `node:sqlite`).
- *(Opcional para empacotamento nativo `.exe`/`.msi`)*: **Rust / Cargo** para build com Tauri 2 (`cargo tauri dev` / `cargo tauri build`).

### Executando em Desenvolvimento (Imediato)

No terminal PowerShell, a partir da raiz do projeto:

```powershell
cd desktop-app
npm.cmd install
npm.cmd run dev
```

Ao executar `npm.cmd run dev`:
1. O Vite inicia a interface Desktop em `http://localhost:5173`.
2. O plugin integrado inicia automaticamente o **Servidor Local WebSocket + SQLite** na porta `8765` (criando o banco durável `desktop-app/digital_notebook.sqlite` e escutando na interface Wi-Fi local `192.168.100.8:8765`).

### Executando com Tauri 2 (Quando Rust estiver instalado)

```powershell
cd desktop-app
npm.cmd run tauri dev
```

---

## 3. Instruções para Compilar e Instalar o Aplicativo Android (S24 Ultra)

### Pré-requisitos
- **Android Studio Ladybug (2024.2+)** ou **Android SDK Command-Line Tools** (`compileSdk = 35`, `minSdk = 29`).
- **JDK 17+** configurado no Android Studio / Gradle.
- **Samsung Galaxy S24 Ultra** com *Depuração USB* ou *Depuração por Wi-Fi* ativada nas *Opções do Desenvolvedor*.

### Compilação e Instalação

1. Abra a pasta `android-app/` no **Android Studio** ou configure a variável `ANDROID_HOME` apontando para o seu Android SDK.
2. Conecte o Samsung Galaxy S24 Ultra via USB e execute:
   ```powershell
   cd android-app
   .\gradlew assembleDebug
   .\gradlew installDebug
   ```
3. O aplicativo **Digital Notebook S Pen** será instalado e aberto automaticamente em orientação retrato.

---

## 4. Guia de Pareamento (S24 Ultra $\leftrightarrow$ Desktop)

1. No aplicativo **Desktop**, clique no botão **"Parear S24 Ultra (QR Code)"** na barra superior.
2. Verifique se a interface de rede selecionada no modal corresponde ao IP do seu computador na rede Wi-Fi (neste ambiente: `192.168.100.8`, ignorando interfaces VPN como Hamachi `25.x.x.x`).
3. O Desktop exibirá um **QR Code** contendo o endereço `ws://192.168.100.8:8765` e um **token temporário de uso único** (válido por 5 minutos).
4. No aplicativo **Android** no S24 Ultra, toque no indicador de conexão (**"Offline / Parear"**) no canto superior direito, escaneie o QR Code ou digite o endereço e o token temporário, e toque em **"Conectar"**.
5. Caso a opção *"Exigir aprovação manual na tela"* esteja marcada no Desktop, clique em **"Aprovar"** quando o aviso `Samsung Galaxy S24 Ultra` aparecer no modal do Desktop.
6. O indicador mudará para **"Sincronizado"** em ambos os dispositivos.

> **Alternativa para redes Wi-Fi com Isolamento de Clientes (AP Isolation):**
> Se estiver em uma rede corporativa/universitária que bloqueia tráfego entre clientes Wi-Fi, conecte o S24 Ultra via cabo USB, execute `adb reverse tcp:8765 tcp:8765` e utilize `ws://127.0.0.1:8765` no aplicativo Android.

---

## 5. Instruções de Exportação para PDF Vetorial

1. Na barra superior do **Desktop**, clique em **"Exportar PDF Vetorial"**.
2. Selecione o **Escopo da Exportação**:
   - **Apenas a Página Atual**: Gera um PDF de 1 página.
   - **Caderno Inteiro**: Gera um PDF onde cada página do caderno corresponde exatamente a 1 folha do PDF.
3. Marque ou desmarque **"Incluir grade pontilhada vetorial no PDF"**.
4. Clique em **"Gerar e Salvar PDF"** e escolha o local no seu computador para salvar o arquivo `.pdf`.

---

## 6. Executando os Testes Automatizados

Para executar todas as suítes de testes unitários, persistência SQLite, protocolo WebSocket e exportação PDF vetorial:

```powershell
cd desktop-app
npm.cmd test
```

Consulte [`docs/TEST_REPORT.md`](file:///c:/Users/mateu/projects/fun/touchpad/docs/TEST_REPORT.md) para o relatório detalhado e [`docs/PHYSICAL_VALIDATION_S24_ULTRA.md`](file:///c:/Users/mateu/projects/fun/touchpad/docs/PHYSICAL_VALIDATION_S24_ULTRA.md) para o protocolo de validação física no Samsung Galaxy S24 Ultra.
