# Relatório de Testes Executados e Limitações Conhecidas

## 1. Resumo da Execução Automatizada

Os testes automatizados foram executados utilizando o runner nativo do Node.js (`v24.18.0`, `--experimental-strip-types --test`) com verificação estrita de tipos TypeScript (`tsc --noEmit` em modo `strict: true`).

- **Comando executado**: `cd desktop-app && npm.cmd test && npm.cmd run build`
- **Total de suítes**: 4 suítes (11 cenários de teste abrangentes)
- **Resultado**: **11 aprovados / 0 falhas**
- **Tempo de execução**: `~316 ms`

---

## 2. Detalhamento dos Testes Executados

### 2.1 Suíte 1: Roteamento `MotionEvent`, S Pen, Dedo, Rejeição de Palma e Borracha (`tests/input-and-eraser.test.ts`)
1. **Diferenciação explícita entre `stylus`, `eraser`, botão lateral e `finger`**:
   - Verifica que `classifyPointerRole` classifica `stylus` sem botão como `stylus_pen`, `stylus` com botão lateral (`BUTTON_STYLUS_PRIMARY`) como `stylus_eraser`, `eraser` como `stylus_eraser`, e `finger` exclusivamente como `finger_gesture` (mesmo quando a ferramenta na UI está em modo borracha).
2. **Conversão de coordenadas e preservação de amostras históricas**:
   - Verifica inversibilidade exata entre `screenToLogical` e `logicalToScreen` sob zoom e pan (`scale = 2.0, panX = 100, panY = 50`).
   - Verifica que amostras históricas (`historicalSamples` de 240Hz) em `ACTION_MOVE` são integralmente preservadas no traço final com suas respectivas pressões.
3. **Política de Rejeição de Palma (`ACTION_CANCEL` e `FLAG_CANCELED`)**:
   - Verifica que um traço iniciado em `ACTION_DOWN` permanece provisório e, ao receber `FLAG_CANCELED = true` ou `ACTION_CANCEL`, é descartado imediatamente sem gerar traço confirmado no índice espacial.
4. **Botão físico da S Pen — Borracha por Traço Inteiro (`WholeStrokeEraserSession` & `SpatialGridIndex`)**:
   - Verifica que manter o botão lateral da S Pen pressionado não cria tinta nova.
   - Verifica que tocar apenas uma extremidade de um traço longo remove o objeto vetorial inteiro.
   - Verifica que um segundo traço paralelo próximo (fora do raio da borracha + meia espessura do segmento) permanece intacto.
   - Verifica que continuar arrastando sobre o mesmo traço na mesma passagem não gera operações `strokes.erase` duplicadas.
   - Verifica que soltar o botão lateral restaura imediatamente a escrita normal no próximo toque.
5. **Navegação por Dedo e Pinça de Dois Dedos em Execução**:
   - Verifica que `fingerMode = 'vertical'` bloqueia deslocamento horizontal em tempo real sem exigir reinicialização.
   - Verifica que o gesto de pinça com dois dedos (`pinchZoom = true`) altera a escala da viewport mantendo a geometria original dos traços inalterada.

### 2.2 Suíte 2: Protocolo, Segurança, Desfazer/Refazer e Idempotência (`tests/protocol-and-idempotency.test.ts`)
1. **Serialização e validação de todas as 11 mensagens do protocolo**:
   - Valida `session.start`, `session.resume`, `stroke.begin`, `stroke.points`, `stroke.end`, `strokes.erase`, `operation.undo`, `operation.redo`, `page.select`, `operation.ack`, `session.error`.
2. **Limites de Segurança**:
   - Verifica rejeição de payloads maiores que `512 KB` com código `PAYLOAD_TOO_LARGE`.
   - Verifica rejeição de IDs malformados/injeção com `INVALID_MESSAGE_FORMAT`.
3. **Desfazer/Refazer e Idempotência (`PageDocumentEngine`)**:
   - Verifica que reenviar o mesmo `operationId` de adição ou remoção é reconhecido como duplicado (`duplicate: true`) e não duplica traços nem apaga traços distintos.
   - Verifica que `applyUndo` restaura integralmente traços apagados pela borracha da S Pen e `applyRedo` reaplica a remoção.

### 2.3 Suíte 3: Persistência SQLite (`tests/sqlite-persistence.test.ts`)
1. **Transações ACID e Recuperação de Sessão**:
   - Cria caderno, página, insere traços, executa remoção por traço inteiro em arquivo SQLite real em disco, fecha a conexão e reabre uma nova instância simulando reinicialização completa do Desktop.
   - Verifica que cadernos, páginas, traços ativos e pilha de `undo`/`redo` sobrevivem à reinicialização e permitem desfazer/refazer operações anteriores ao fechamento.

### 2.4 Suíte 4: Integração WebSocket e Exportação PDF Vetorial (`tests/websocket-sync-and-pdf.integration.test.ts`)
1. **Pareamento QR Code, Aprovação Explícita, Sincronização em Tempo Real e Reconexão**:
   - Gera QR Code temporário, conecta cliente WebSocket, verifica estado `approved: false` até aprovação explícita no Desktop, e verifica invalidação do token temporário contra reuso por terceiros (`PAIRING_TIMEOUT`).
   - Transmite `stroke.begin` $\rightarrow$ `stroke.points` $\rightarrow$ `stroke.end` e verifica recebimento de `operation.ack` após persistência SQLite.
   - Simula queda de Wi-Fi, reconecta via `session.resume`, reenvia operação já confirmada e verifica deduplicação (`duplicate: true`).
   - Executa `strokes.erase` sincronizado e verifica remoção no SQLite.
2. **Exportação PDF 100% Vetorial**:
   - Gera PDF de múltiplas páginas diretamente dos dados vetoriais com e sem grade pontilhada, verificando cabeçalho `%PDF-1.4`, `/Count 2`, dimensões `MediaBox` proporcionais (`595.28 x 841.85 pt`) e operadores vetoriais de cor e espessura variável.

---

## 3. Testes Unitários e Instrumentados Android (`android-app/`)

Os testes JUnit 4 e AndroidX Test estão implementados em:
- [`MotionEventRouterAndEraserTest.kt`](file:///c:/Users/mateu/projects/fun/touchpad/android-app/app/src/test/java/com/digitalnotebook/spen/MotionEventRouterAndEraserTest.kt)
- [`SPenCanvasInstrumentedTest.kt`](file:///c:/Users/mateu/projects/fun/touchpad/android-app/app/src/androidTest/java/com/digitalnotebook/spen/SPenCanvasInstrumentedTest.kt)

Para executá-los assim que o Android SDK (`ANDROID_HOME`) e um Samsung Galaxy S24 Ultra estiverem conectados à máquina:
```powershell
cd android-app
.\gradlew testDebugUnitTest
.\gradlew connectedDebugAndroidTest
```

---

## 4. Limitações Conhecidas e Próximas Melhorias

1. **Validação Física Pendente no Hardware S24 Ultra**:
   - Como não há um aparelho físico Samsung Galaxy S24 Ultra conectado via ADB nem Android SDK instalado neste ambiente atual, os testes de curva real de pressão (4096 níveis), distância de hover eletromagnético (~15mm) para detecção de `BUTTON_STYLUS_PRIMARY`, interação com Samsung Air Actions e rejeição física de palma estão documentados em [`docs/PHYSICAL_VALIDATION_S24_ULTRA.md`](file:///c:/Users/mateu/projects/fun/touchpad/docs/PHYSICAL_VALIDATION_S24_ULTRA.md) para execução no aparelho real.
2. **Compilação Nativa do Binário Tauri (`.msi`/`.exe`)**:
   - O código-fonte completo em Rust (`desktop-app/src-tauri/`) está entregue, porém a geração do instalador `.exe`/`.msi` requer a instalação do toolchain `rustup` (`rustc` + `cargo`) na máquina. Enquanto isso, o aplicativo Desktop funciona integralmente via `npm.cmd run dev` com o servidor local `node:sqlite` + WebSocket.
3. **Próximas Melhorias Planejadas**:
   - Suporte a múltiplas ferramentas de ponta (caneta tinteiro caligráfica sensível a `tiltX`/`tiltY` e marca-texto translúcido com `multiply` blend mode).
   - Suporte a seleção por laço (*lasso tool*) para mover ou redimensionar subconjuntos de traços vetoriais.
   - Descoberta automática mDNS / Zeroconf complementar ao QR Code em redes domésticas sem isolamento de multicast.
