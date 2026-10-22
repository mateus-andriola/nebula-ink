# Validação Física Obrigatória — Samsung Galaxy S24 Ultra + S Pen

Conforme estabelecido nas diretrizes do projeto, funcionalidades de hardware específicas do digitalizador Wacom integrado ao **Samsung Galaxy S24 Ultra** e da **S Pen** original **não podem ser integralmente simuladas em um emulador Android padrão**.

Este documento especifica os testes que exigem validação física no aparelho real, os comportamentos particulares da One UI / Samsung Air Actions e as limitações conhecidas da rejeição de palma.

---

## 1. Limitações de Emuladores vs. Hardware Real S24 Ultra

| Aspecto | Emulador Android / Testes Sintéticos | Samsung Galaxy S24 Ultra Físico |
| :--- | :--- | :--- |
| **Taxa de amostragem e pontos históricos** | Eventos sintéticos de baixa frequência (~60Hz) sem `historySize` real do digitalizador | Painel de 120Hz com amostragem da S Pen a 240Hz+, gerando múltiplos pontos históricos por `ACTION_MOVE` |
| **Botão lateral da S Pen (`BUTTON_STYLUS_PRIMARY`)** | Simulado programaticamente via `MotionEvent.obtain` | Exige que a ponta da S Pen esteja dentro da distância de detecção eletromagnética (~1.5 cm da tela) para que o digitalizador reporte `BUTTON_STYLUS_PRIMARY` em `MotionEvent` |
| **Samsung Air Actions (Bluetooth LE)** | Inexistente no emulador | Se o usuário clicar no botão da S Pen **longe da tela**, a One UI intercepta via Bluetooth como Air Action e **não** envia `MotionEvent` para a `View`. Quando próxima da tela (hover/toque), o digitalizador Wacom assume e entrega `BUTTON_STYLUS_PRIMARY` / `TOOL_TYPE_ERASER` |
| **Curva física de pressão (4096 níveis)** | Valores numéricos arbitrários `[0.0, 1.0]` | Curva real do transdutor de pressão da ponta da S Pen (0.7mm) variando de toque leve (`~0.08`) a pressão firme (`~0.95`) |
| **Rejeição de palma e `FLAG_CANCELED`** | Cancelamentos injetados via testes instrumentados | Interação real entre a borda da mão apoiada no vidro e a aproximação do campo eletromagnético da S Pen |

---

## 2. Roteiro de Validação Física no Samsung Galaxy S24 Ultra

Os testes abaixo **não são declarados aprovados automaticamente** sem execução e evidência no dispositivo físico:

### Teste Físico 1 — Escrita em 120Hz e Curva de Pressão (4096 níveis)
1. Abrir o aplicativo no S24 Ultra em orientação retrato.
2. Escrever caligrafia cursiva rápida e traços longos variando a força da mão sobre a S Pen.
3. **Critério de validação**:
   - Ausência de polígonos quebrados em curvas rápidas (confirmando consumo de `event.historySize`).
   - Transição suave de espessura entre traço leve e traço forte.

### Teste Físico 2 — Botão Físico Lateral da S Pen (Borracha por Traço Inteiro)
1. Desenhar 5 traços paralelos próximos (separados por ~3mm) e 1 traço longo cruzando a página.
2. Aproximar a S Pen da tela (hover), manter o botão lateral da S Pen pressionado e tocar/arrastar apenas sobre o 3º traço paralelo e sobre uma ponta do traço longo.
3. Soltar o botão lateral e voltar a escrever imediatamente.
4. **Critério de validação**:
   - Enquanto o botão está pressionado, nenhuma tinta nova é criada.
   - O 3º traço paralelo e o traço longo são removidos **integralmente** assim que tocados.
   - Os traços 1, 2, 4 e 5 permanecem intactos.
   - O botão lateral **não** aciona desfazer (`undo`) dos traços não tocados.
   - Ao soltar o botão, o próximo toque volta a desenhar normalmente.
   - Verificar se as Air Actions do sistema não interferem quando a caneta está próxima à tela.

### Teste Físico 3 — Hover (`ACTION_HOVER_MOVE`) e Pré-visualização de Ferramenta
1. Aproximar a ponta da S Pen a ~1 cm da tela sem tocar o vidro.
2. Pressionar e soltar o botão lateral durante o hover.
3. **Critério de validação**:
   - O cursor visual na área de escrita alterna entre o indicador da caneta e o círculo do raio de apagamento da borracha antes mesmo do toque físico (`ACTION_DOWN`).

### Teste Físico 4 — Rejeição de Palma Real e `ACTION_CANCEL` / `FLAG_CANCELED`
1. Com `palmRejection = true`, apoiar naturalmente a lateral da mão (hipotenar) na tela antes de encostar a ponta da S Pen (cenário clássico em que o touch capacitivo detecta o dedo/palma alguns milissegundos antes do digitalizador detectar a caneta).
2. Iniciar a escrita com a S Pen.
3. **Critério de validação**:
   - O contato inicial da palma não deve gerar traços (pois `TOOL_TYPE_FINGER` nunca desenha).
   - Assim que a S Pen entra em hover/toque, o `GestureCoordinator` e o `ACTION_CANCEL` do Android interrompem o scroll iniciado pela palma, mantendo a página estável durante a escrita.

### Teste Físico 5 — Navegação por Dedo e Pinça de Dois Dedos
1. Afastar a S Pen da tela (> 3 cm).
2. Arrastar com 1 dedo na horizontal, vertical e diagonal sob os modos `fingerMode = both`, `vertical`, `horizontal`, `none` e `scrollMode = free`, `axisLocked`.
3. Realizar gesto de pinça com 2 dedos sobre traços existentes.
4. **Critério de validação**:
   - Os traços mantêm nitidez vetorial e espessura proporcional sem sofrer distorção nas coordenadas lógicas.

---

## 3. Limitações Documentadas da Rejeição de Palma

Não afirmamos que a rejeição de palma é perfeita em 100% dos cenários físicos. As limitações conhecidas são:

1. **Apoio da palma antes da entrada da S Pen na zona de hover (~15mm)**:
   - Se o usuário apoiar a palma na tela quando a S Pen ainda está muito distante (> 2 cm do vidro), o Android entrega eventos legítimos `TOOL_TYPE_FINGER`. Se `fingerMode != none`, a página pode sofrer um pequeno deslocamento de scroll durante os poucos milissegundos até que a S Pen entre na zona de detecção eletromagnética ou até que o Android emita `ACTION_CANCEL`.
   - **Mitigação disponível no app**: O usuário pode usar `fingerMode = none` (navegando pelas barras discretas nas bordas) caso deseje travamento absoluto do scroll por toque durante sessões intensas de escrita.
2. **Toques acidentais com a ponta dos dedos enquanto a S Pen está afastada**:
   - Como o dedo é utilizado para pan/zoom, toques da mão sem a S Pen próxima são interpretados como navegação, nunca como tinta ou apagamento.
