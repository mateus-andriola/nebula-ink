# Diagnóstico do Ambiente de Desenvolvimento

Este documento registra a inspeção realizada no ambiente de desenvolvimento antes da implementação dos módulos principais do projeto **Digital Notebook — S Pen + Desktop**.

## 1. Sistema Operacional e Rede Local

- **Sistema Operacional**: Microsoft Windows 11 (`Win32NT 10.0.22631.0`).
- **Shell padrão**: PowerShell (com política de execução `Restricted` para scripts `.ps1`, exigindo o uso de executáveis `.cmd`/`.exe` como `npm.cmd` ou `bun.exe`).
- **Interfaces de Rede Detectadas**:
  - **Wi-Fi (`Adaptador de Rede sem Fio Wi-Fi`)**: IPv4 `192.168.100.8` ( máscara `255.255.255.0`, gateway `192.168.100.1`).
  - **Hamachi (`Adaptador Ethernet Hamachi`)**: IPv4 `25.31.138.90` (interface virtual VPN).
  - **Hyper-V / WSL (`vEthernet Default Switch`)**: IPv4 `172.18.96.1` (switch virtual interno).
- **Implicações e Limitações para Descoberta na Rede Local**:
  1. Em sistemas Windows com adaptadores virtuais (Hamachi, WSL/Hyper-V, Docker), a enumeração ingênua de IPs frequentemente retorna o IP da VPN (`25.x.x.x`) ou do switch virtual (`172.18.x.x`), que são inacessíveis pelo Samsung Galaxy S24 Ultra conectado ao Wi-Fi.
  2. O servidor local do desktop foi projetado para priorizar interfaces de rede privada Wi-Fi/LAN (`192.168.x.x`, `10.x.x.x`) e expor na lista de pareamento todos os candidatos IPv4 válidos para seleção manual caso o computador possua múltiplas sub-redes.
  3. O Firewall do Windows Defender pode bloquear conexões TCP de entrada na primeira execução caso a rede Wi-Fi esteja classificada como "Pública". O servidor vincula-se apenas à interface selecionada (ou `0.0.0.0` + `127.0.0.1` em desenvolvimento local) em porta configurável/dinâmica.
  4. Roteadores com **AP Isolation (Isolamento de Clientes Wi-Fi)** impedem a comunicação direta entre dispositivos na mesma WLAN. O protocolo trata timeouts de conexão e orienta o diagnóstico dessa condição.

## 2. Ferramentas, Compiladores e Runtimes

| Ferramenta / SDK | Status no Ambiente | Versão / Caminho | Observações |
| :--- | :--- | :--- | :--- |
| **Node.js** | Instalado | `v24.18.0` (`C:\nvm4w\nodejs\node.exe`) | Inclui módulo nativo `node:sqlite` (`DatabaseSync`) |
| **NPM** | Instalado | `11.16.0` (`C:\nvm4w\nodejs\npm.cmd`) | Usar `npm.cmd` devido à política do PowerShell |
| **Bun** | Instalado | `1.3.14` (`C:\Users\mateu\.bun\bin\bun.exe`) | Disponível para instalação rápida e execução de testes |
| **JDK (JAVA_HOME)** | Instalado | OpenJDK `25.0.4` LTS (`C:\Program Files\Microsoft\jdk-25.0.4.7-hotspot`) | `PATH` contém JRE 1.8 antes do `JAVA_HOME`; scripts devem priorizar `JAVA_HOME` |
| **Python** | Instalado | `3.12.10` | Disponível para scripts utilitários |
| **Android SDK / ADB** | Não instalado | `ANDROID_HOME` e `ANDROID_SDK_ROOT` ausentes | Sem emulador ou Samsung Galaxy S24 Ultra conectado via ADB no momento |
| **Rust / Cargo (Tauri)** | Não instalado | `rustc` e `cargo` ausentes no host | Código-fonte Tauri 2 em Rust entregue integralmente + servidor local Node/SQLite funcional para execução imediata sem depender do compilador Rust |

## 3. Estratégia de Execução e Testes no Ambiente

1. **Aplicativo Android (`android-app/`)**:
   - Estruturado como projeto Gradle Kotlin DSL completo (Jetpack Compose, `View` customizada para `MotionEvent` da S Pen, Room SQLite, Preferences DataStore, OkHttp WebSocket).
   - Inclui testes unitários JUnit (`src/test`) e testes instrumentados (`src/androidTest`).
   - Como o Android SDK e um dispositivo físico S24 Ultra não estão conectados a esta máquina no momento, toda a lógica de roteamento de `MotionEvent`, classificação de ferramentas (`TOOL_TYPE_STYLUS`, `TOOL_TYPE_ERASER`, `TOOL_TYPE_FINGER`), rejeição de palma, índice espacial, borracha por traço inteiro, desfazer/refazer e protocolo também é validada por uma suíte de testes automatizados executável localmente em TypeScript/Node.

2. **Aplicativo Desktop (`desktop-app/`)**:
   - Inclui o backend **Tauri 2 em Rust** (`src-tauri/`) completo e pronto para compilação com `cargo tauri dev` / `cargo tauri build`.
   - Inclui também o servidor backend local em **TypeScript + `node:sqlite` + `ws`** (`desktop-app/server/`), que utiliza exatamente o mesmo esquema relacional SQLite (com transações ACID, chaves estrangeiras e índices) e o mesmo protocolo WebSocket. Isso garante que o aplicativo desktop seja **100% funcional imediatamente neste ambiente** (com persistência real em disco SQLite, servidor WebSocket em tempo real na rede Wi-Fi `192.168.100.8`, QR Code real e exportação PDF vetorial).
