# Especificação do Protocolo de Comunicação — Digital Notebook

## 1. Visão Geral

A comunicação entre o aplicativo Android (**Samsung Galaxy S24 Ultra**) e o aplicativo **Desktop** ocorre sobre **WebSocket** (`ws://` em rede local controlada ou `wss://` com certificado validado via fingerprint do QR Code) utilizando mensagens codificadas em **JSON UTF-8**.

### Limites de Segurança do Canal
- **Tamanho máximo de mensagem**: `512 KB` (`524.288 bytes`). Mensagens maiores são rejeitadas com `session.error` (`PAYLOAD_TOO_LARGE`).
- **Máximo de pontos por lote `stroke.points`**: `500` pontos.
- **Formato de IDs**: Todos os `operationId`, `strokeId`, `pageId` e `notebookId` devem ser strings alfanuméricas/hifenizadas válidas (`1..128` caracteres, regex `^[a-zA-Z0-9_-]{1,128}$`).

---

## 2. Envelope Padrão

Todas as mensagens seguem a estrutura discriminada pelo campo `type`:

```json
{
  "type": "<message_type>",
  "timestamp": 1760985000000,
  "payload": { ... }
}
```

---

## 3. Contratos das Mensagens

### 3.1 `session.start` (Cliente $\rightarrow$ Servidor / Servidor $\rightarrow$ Cliente)

Inicia uma nova sessão autenticada utilizando o token temporário lido no QR Code.

**Cliente $\rightarrow$ Servidor:**
```json
{
  "type": "session.start",
  "timestamp": 1760985000000,
  "payload": {
    "pairingToken": "tkn_9f8a7b6c5d4e",
    "deviceId": "s24u-9812ab",
    "deviceName": "Samsung Galaxy S24 Ultra",
    "clientVersion": "1.0.0"
  }
}
```

**Resposta do Servidor (`session.start`):**
```json
{
  "type": "session.start",
  "timestamp": 1760985000050,
  "payload": {
    "sessionId": "sess_1a2b3c4d",
    "sessionResumeToken": "res_8877665544332211",
    "approved": true,
    "activeNotebookId": "nb_default",
    "activePageId": "page_default_1",
    "notebooks": [ ... ],
    "activePage": { ... }
  }
}
```
- **Garantias**: O `pairingToken` expira após 5 minutos ou após o primeiro uso confirmado. Se a política de aprovação manual estiver ativa no Desktop, o servidor mantém a sessão em estado `pending_approval` até a autorização explícita do usuário na interface do Desktop.

---

### 3.2 `session.resume` (Cliente $\rightarrow$ Servidor)

Reconecta uma sessão previamente autorizada após queda momentânea de Wi-Fi, utilizando o `sessionResumeToken` efêmero da sessão ativa e enviando a última operação sincronizada.

```json
{
  "type": "session.resume",
  "timestamp": 1760985010000,
  "payload": {
    "sessionId": "sess_1a2b3c4d",
    "sessionResumeToken": "res_8877665544332211",
    "deviceId": "s24u-9812ab",
    "lastAckedOperationId": "op_stroke_004"
  }
}
```
- **Garantias**: O servidor valida o token de retomada, devolve o estado atualizado da página ativa e aceita o reenvio imediato de todas as operações pendentes no buffer do Android.

---

### 3.3 `stroke.begin` (Cliente $\rightarrow$ Servidor)

Anuncia o início de um novo traço em tempo real (`ACTION_DOWN` da S Pen) para renderização imediata no Desktop (estado provisório em andamento).

```json
{
  "type": "stroke.begin",
  "timestamp": 1760985011000,
  "payload": {
    "operationId": "op_begin_101",
    "strokeId": "stk_101",
    "notebookId": "nb_default",
    "pageId": "page_default_1",
    "color": "#111827",
    "baseWidth": 3.5,
    "toolType": "pen",
    "startPoint": {
      "x": 120.5,
      "y": 340.2,
      "pressure": 0.42,
      "tiltX": 5.0,
      "tiltY": -3.0,
      "t": 0
    }
  }
}
```
- **Garantias**: Não persiste no SQLite ainda; alimenta o buffer de renderização em tempo real do Desktop. Se o traço for cancelado pela rejeição de palma no Android, um `stroke.end` com `cancelled: true` descarta o traço provisório no Desktop.

---

### 3.4 `stroke.points` (Cliente $\rightarrow$ Servidor)

Envia lotes de pontos capturados durante `ACTION_MOVE` (incluindo pontos históricos de 120Hz/240Hz), numerados sequencialmente por `seq`.

```json
{
  "type": "stroke.points",
  "timestamp": 1760985011016,
  "payload": {
    "strokeId": "stk_101",
    "pageId": "page_default_1",
    "seq": 1,
    "points": [
      { "x": 122.0, "y": 341.8, "pressure": 0.51, "tiltX": 5.0, "tiltY": -3.0, "t": 4 },
      { "x": 125.4, "y": 344.0, "pressure": 0.58, "tiltX": 5.1, "tiltY": -2.9, "t": 8 }
    ]
  }
}
```
- **Garantias**: O número de sequência `seq` estritamente crescente por `strokeId` permite ao Desktop ordenar ou ignorar lotes duplicados em tempo real.

---

### 3.5 `stroke.end` (Cliente $\rightarrow$ Servidor)

Finaliza o traço (`ACTION_UP`) ou informa seu cancelamento por rejeição de palma (`ACTION_CANCEL` / `FLAG_CANCELED`). Contém a geometria completa e autoritativa do traço para garantir consistência mesmo que algum pacote intermediário `stroke.points` tenha chegado fora de ordem durante oscilação de rede.

```json
{
  "type": "stroke.end",
  "timestamp": 1760985011250,
  "payload": {
    "operationId": "op_stk_101",
    "notebookId": "nb_default",
    "pageId": "page_default_1",
    "cancelled": false,
    "stroke": {
      "id": "stk_101",
      "pageId": "page_default_1",
      "notebookId": "nb_default",
      "color": "#111827",
      "baseWidth": 3.5,
      "toolType": "pen",
      "points": [
        { "x": 120.5, "y": 340.2, "pressure": 0.42, "tiltX": 5.0, "tiltY": -3.0, "t": 0 },
        { "x": 122.0, "y": 341.8, "pressure": 0.51, "tiltX": 5.0, "tiltY": -3.0, "t": 4 },
        { "x": 125.4, "y": 344.0, "pressure": 0.58, "tiltX": 5.1, "tiltY": -2.9, "t": 8 }
      ],
      "createdAt": 1760985011000
    }
  }
}
```
- **Garantias**:
  - Se `cancelled == true`, o Desktop remove qualquer rastro provisório de `stk_101` da tela e envia `operation.ack` sem gravar no banco.
  - Se `cancelled == false`, o Desktop abre uma transação SQLite, verifica se `operationId` já foi processado (idempotência), insere o traço e a operação, faz `COMMIT` e **somente então** envia `operation.ack`.

---

### 3.6 `strokes.erase` (Cliente $\rightarrow$ Servidor)

Remove integralmente um ou mais traços atingidos pela borracha da S Pen (botão físico lateral ou ferramenta borracha).

```json
{
  "type": "strokes.erase",
  "timestamp": 1760985015000,
  "payload": {
    "operationId": "op_erase_202",
    "notebookId": "nb_default",
    "pageId": "page_default_1",
    "targetStrokeIds": ["stk_101"],
    "removedStrokes": [
      {
        "id": "stk_101",
        "pageId": "page_default_1",
        "notebookId": "nb_default",
        "color": "#111827",
        "baseWidth": 3.5,
        "toolType": "pen",
        "points": [ ... ],
        "createdAt": 1760985011000
      }
    ]
  }
}
```
- **Garantias**:
  - **Idempotência estrita**: A remoção opera exclusivamente sobre os IDs explícitos em `targetStrokeIds` e é deduplicada por `operationId`. Reenviar `op_erase_202` após uma queda de conexão jamais apagará outros traços.
  - Armazena `removedStrokes` no registro da operação para permitir `operation.undo` e `operation.redo` perfeitos.

---

### 3.7 `operation.undo` e `operation.redo` (Bidirecional)

Desfaz ou refaz uma operação específica (`targetOperationId`) ou a última operação da pilha da página (`pageId`).

```json
{
  "type": "operation.undo",
  "timestamp": 1760985020000,
  "payload": {
    "operationId": "op_undo_301",
    "notebookId": "nb_default",
    "pageId": "page_default_1",
    "targetOperationId": "op_erase_202"
  }
}
```
- **Garantias**:
  - Desfazer um `stroke.end` marca o traço como `is_deleted = 1` no SQLite.
  - Desfazer um `strokes.erase` restaura os traços em `targetStrokeIds` (`is_deleted = 0`).
  - `operation.redo` reverte o efeito do `undo` sobre `targetOperationId`.
  - É confirmado via `operation.ack` após o `COMMIT`.

---

### 3.8 `page.select` (Bidirecional)

Altera o caderno e/ou página ativa em ambos os dispositivos ou cria nova página/caderno quando solicitado.

```json
{
  "type": "page.select",
  "timestamp": 1760985025000,
  "payload": {
    "operationId": "op_page_401",
    "notebookId": "nb_default",
    "pageId": "page_default_2"
  }
}
```
- **Garantias**: O Desktop responde com o estado sincronizado da página selecionada (incluindo todos os seus traços ativos e configurações de grade) e confirma com `operation.ack`.

---

### 3.9 `operation.ack` (Servidor $\rightarrow$ Cliente)

Confirma que a operação identificada por `operationId` foi validada e **persistida de forma durável em SQLite** (transação concluída com `COMMIT`).

```json
{
  "type": "operation.ack",
  "timestamp": 1760985011260,
  "payload": {
    "operationId": "op_stk_101",
    "pageId": "page_default_1",
    "status": "committed",
    "duplicate": false,
    "serverTimestamp": 1760985011260
  }
}
```

---

### 3.10 `session.error` (Servidor $\rightarrow$ Cliente)

Comunica erros de protocolo, falha de autenticação, mensagem inválida ou referência inexistente.

```json
{
  "type": "session.error",
  "timestamp": 1760985030000,
  "payload": {
    "code": "INVALID_TOKEN",
    "message": "O token de pareamento expirou ou já foi utilizado.",
    "relatedOperationId": null,
    "fatal": true
  }
}
```

Códigos padronizados:
- `INVALID_MESSAGE_FORMAT`
- `PAYLOAD_TOO_LARGE`
- `UNAUTHORIZED`
- `INVALID_TOKEN`
- `PAIRING_TIMEOUT`
- `DEVICE_REJECTED`
- `INVALID_REFERENCE`
- `INTERNAL_DB_ERROR`
