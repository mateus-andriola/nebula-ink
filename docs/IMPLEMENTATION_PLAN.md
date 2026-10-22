# Plano de Implementação — Digital Notebook (S Pen + Desktop)

O desenvolvimento está estruturado em 5 fases verificáveis, precedidas pela especificação dos contratos do protocolo e documentação arquitetural.

---

## Fase 0 — Contratos de Protocolo e Modelo Vetorial Compartilhado (`protocol/`)

### Escopo
- Definir o sistema de coordenadas lógicas normalizadas (`1000 x 1414.21` — proporção ISO A4 retrato, independente de resolução de tela).
- Especificar os contratos tipados de todas as mensagens WebSocket (`session.start`, `session.resume`, `stroke.begin`, `stroke.points`, `stroke.end`, `strokes.erase`, `operation.undo`, `operation.redo`, `page.select`, `operation.ack`, `session.error`).
- Implementar validadores rigorosos de payload, limites de tamanho de mensagem e algoritmos geométricos de interseção segmento-círculo com espessura de traço.

### Critérios de Aceite
- Contratos compilando em TypeScript `strict: true`.
- JSON Schema formal documentado em `protocol/protocol-schema.json`.

---

## Fase 1 — Captura Nativa e Motor de Desenho Android (`android-app/`)

### Escopo
- Configurar projeto Android Kotlin + Jetpack Compose.
- Implementar `SPenCanvasView` (`android.view.View` customizada integrada via `AndroidView` ao Compose) para captura de baixa latência.
- Implementar `ToolClassifier` e `MotionEventRouter`:
  - Diferenciação estrita entre `TOOL_TYPE_STYLUS`, `TOOL_TYPE_ERASER` e `TOOL_TYPE_FINGER` antes de qualquer processamento.
  - Extração de coordenadas históricas (`historySize` / `getHistoricalX` / `getHistoricalY` / `getHistoricalPressure` / `getHistoricalEventTime`), pressão, inclinação (`AXIS_TILT`), orientação (`AXIS_ORIENTATION`) e botão lateral (`BUTTON_STYLUS_PRIMARY`).
- Renderizar grade pontilhada configurável (espaçamento, cor, opacidade) independente da geometria dos traços.
- Renderizar traços vetoriais sensíveis à pressão da S Pen de forma incremental (buffer bitmap de traços confirmados + camada de traço ativo).

### Critérios de Aceite
- Caneta desenha com pressão variável e preserva pontos históricos.
- Dedo jamais produz tinta nem apaga traços.
- Grade pontilhada permanece nítida e independente das coordenadas dos traços.

---

## Fase 2 — Navegação, Rejeição de Palma e Borracha por Traço Inteiro (`android-app/`)

### Escopo
- Implementar `GestureCoordinator` para scroll com dedo (`fingerMode`: `both`, `vertical`, `horizontal`, `none`; `scrollMode`: `free`, `axisLocked`) e zoom por pinça de dois dedos (`pinchZoom: boolean`), transformando apenas a matriz de visualização (`scale`, `panX`, `panY`) sem alterar as coordenadas lógicas dos traços.
- Implementar barras de navegação discretas (horizontal e vertical) nas bordas da área de escrita.
- Persistir configurações em `Preferences DataStore` (`PreferencesRepository`) com atualização reativa em tempo real (`Flow`).
- Implementar `PalmRejectionPolicy`:
  - Respeitar `ACTION_CANCEL` e `FLAG_CANCELED`.
  - Manter traços em estado provisório (`provisional`) até `ACTION_UP` válido.
  - Descartar imediatamente qualquer traço provisório cancelado sem poluir histórico ou enviar confirmação indevida.
- Implementar `WholeStrokeEraser` e `SpatialGridIndex`:
  - Acionado pelo botão lateral da S Pen (`BUTTON_STYLUS_PRIMARY`), por `TOOL_TYPE_ERASER` ou pela ferramenta de borracha na UI.
  - Consulta espacial em grade uniforme ($O(1)$ por célula) e cálculo exato de distância ponto-segmento considerando o raio da borracha somado à metade da espessura do traço no segmento.
  - Remoção integral do traço atingido, preservando traços próximos fora do raio.
  - Prevenção de operações duplicadas na mesma passagem (`erasedInCurrentPass`).
  - Registro como operação independente (`strokes.erase`) com dados completos para `undo`/`redo` e idempotência.

### Critérios de Aceite
- Botão da S Pen ativa borracha por traço inteiro sem acionar comando de desfazer.
- Traços cancelados por `ACTION_CANCEL` / `FLAG_CANCELED` são removidos do estado provisório.
- Alteração de preferências atualiza o comportamento imediatamente sem reiniciar a Activity.

---

## Fase 3 — Aplicativo Desktop, Renderizador Vetorial e Persistência SQLite (`desktop-app/`)

### Escopo
- Criar aplicação React + TypeScript (`strict`) + Vite + Tauri 2 (`src-tauri/` em Rust e servidor local `server/` em Node + `node:sqlite`).
- Implementar banco de dados SQLite com tabelas normalizadas (`notebooks`, `pages`, `strokes`, `operations`, `paired_devices`, `sync_ack_log`), chaves estrangeiras (`ON DELETE CASCADE`), índices e transações explícitas (`BEGIN IMMEDIATE ... COMMIT`).
- Implementar `Canvas2DRenderer` incremental no desktop com suporte a pressão por ponto, grade pontilhada configurável, zoom e pan.
- Implementar servidor local com geração de QR Code temporário (expiração de 5 minutos, uso único) e aprovação explícita de novos dispositivos pelo usuário no desktop.

### Critérios de Aceite
- Cadernos, páginas, traços e remoções sobrevivem à reinicialização do desktop.
- Nenhuma confirmação (`operation.ack`) é emitida antes do `COMMIT` da transação SQLite.
- Pareamento exige token temporário válido e aprovação explícita quando configurado.

---

## Fase 4 — Sincronização em Tempo Real e Resiliência (`protocol/`, `android-app/`, `desktop-app/`)

### Escopo
- Implementar comunicação WebSocket bidirecional com todas as mensagens do contrato.
- Transmitir traços em tempo real (`stroke.begin` -> lotes `stroke.points` com `seq` -> `stroke.end`) e remoções (`strokes.erase`).
- Implementar buffer durável de operações pendentes no Android (Room SQLite) e reenvio ordenado em caso de desconexão.
- Implementar deduplicação por `operationId` no servidor SQLite (garantindo idempotência total em reenvios).

### Critérios de Aceite
- Escrita e apagamento refletidos em tempo real no desktop.
- Reconexão automática com reenvio sem duplicar traços ou apagar traços errados.

---

## Fase 5 — Exportação PDF Vetorial, Testes Automatizados e Acabamento

### Escopo
- Implementar `VectorPdfExporter` gerando arquivos PDF 100% vetoriais (especificação PDF 1.4 nativa com comandos vetoriais `m`, `l`, `c`, `f`, `S`, preservando espessura variável por pressão, cores exatas, dimensões lógicas e grade pontilhada opcional) para uma página ou caderno inteiro.
- Implementar desfazer/refazer sincronizado (`operation.undo` / `operation.redo`).
- Executar suíte completa de testes unitários e de integração automatizados.
- Documentar resultados dos testes e o protocolo de validação física no Samsung Galaxy S24 Ultra.

### Critérios de Aceite
- PDF gerado diretamente da geometria vetorial (sem captura de tela/rasterização), preservando proporções e pressão.
- Todos os testes automatizados aprovados e documentados em `docs/TEST_REPORT.md`.
