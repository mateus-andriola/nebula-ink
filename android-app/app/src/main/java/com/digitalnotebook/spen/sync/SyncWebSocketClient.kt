package com.digitalnotebook.spen.sync

import com.digitalnotebook.spen.data.PendingOperationDao
import com.digitalnotebook.spen.data.PendingOperationEntity
import com.digitalnotebook.spen.model.ConnectionStatus
import com.digitalnotebook.spen.model.EraseOperationRecord
import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.StrokePoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit

class SyncWebSocketClient(
    private val scope: CoroutineScope,
    private val pendingDao: PendingOperationDao,
    private val deviceId: String = "s24u_${UUID.randomUUID().toString().take(8)}",
    private val deviceName: String = "Samsung Galaxy S24 Ultra"
) {
    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private val candidateUrls = mutableListOf(
        "ws://127.0.0.1:8765",
        "ws://192.168.100.8:8765"
    )
    private var candidateIndex = 0

    private var webSocket: WebSocket? = null
    private var currentWsUrl: String? = candidateUrls.first()
    private var pairingToken: String? = "auto_lan"
    private var sessionId: String? = null
    private var sessionResumeToken: String? = null
    private var lastAckedOperationId: String? = null
    private var reconnectJob: Job? = null
    private var shouldReconnect = true

    private val _connectionStatus = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val _serverSyncState = MutableStateFlow<ServerSessionSyncPayload?>(null)
    val serverSyncState: StateFlow<ServerSessionSyncPayload?> = _serverSyncState.asStateFlow()

    init {
        // Inicia conexão automática na LAN / ADB Reverse ao abrir o app no S24 Ultra
        openSocket(isResume = false)
    }

    fun getCurrentWsUrl(): String = currentWsUrl ?: candidateUrls.first()

    fun connectWithPairingToken(
        wsUrl: String,
        token: String,
        extraCandidates: List<String> = emptyList()
    ) {
        shouldReconnect = true
        val primary = wsUrl.ifBlank { candidateUrls.first() }
        val merged = (listOf(primary) + extraCandidates + listOf("ws://127.0.0.1:8765", "ws://192.168.100.8:8765"))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
        candidateUrls.clear()
        candidateUrls.addAll(merged)
        candidateIndex = 0
        currentWsUrl = primary
        pairingToken = token.ifBlank { "auto_lan" }
        sessionId = null
        sessionResumeToken = null
        openSocket(isResume = false)
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectJob?.cancel()
        webSocket?.close(1000, "User disconnected")
        webSocket = null
        _connectionStatus.value = ConnectionStatus.DISCONNECTED
    }

    private fun resolveHttpBaseUrl(): String {
        val ws = currentWsUrl ?: candidateUrls.first()
        return ws.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
    }

    private fun openSocket(isResume: Boolean) {
        val url = currentWsUrl ?: candidateUrls.first()
        _connectionStatus.value = if (isResume) {
            ConnectionStatus.RECONNECTING
        } else {
            ConnectionStatus.CONNECTING
        }

        val request = Request.Builder().url(url).build()
        webSocket?.cancel()
        webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (isResume && sessionId != null && sessionResumeToken != null) {
                    val resumeMsg = ProtocolSerializer.encodeMessage(
                        type = "session.resume",
                        payload = SessionResumePayload(
                            sessionId = sessionId!!,
                            sessionResumeToken = sessionResumeToken!!,
                            deviceId = deviceId,
                            lastAckedOperationId = lastAckedOperationId
                        )
                    )
                    webSocket.send(resumeMsg)
                } else {
                    val startMsg = ProtocolSerializer.encodeMessage(
                        type = "session.start",
                        payload = SessionStartClientPayload(
                            pairingToken = pairingToken?.ifBlank { "auto_lan" } ?: "auto_lan",
                            deviceId = deviceId,
                            deviceName = deviceName
                        )
                    )
                    webSocket.send(startMsg)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleIncomingMessage(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _lastError.value = t.message ?: "Falha na conexão Wi-Fi local"
                // Alterna entre IP Wi-Fi LAN (192.168.100.8) e USB Reverse (127.0.0.1) se falhar
                candidateIndex = (candidateIndex + 1) % candidateUrls.size
                currentWsUrl = candidateUrls[candidateIndex]
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (shouldReconnect && code != 1000) {
                    scheduleReconnect()
                } else {
                    _connectionStatus.value = ConnectionStatus.DISCONNECTED
                }
            }
        })
    }

    private fun handleIncomingMessage(raw: String) {
        val envelope = runCatching { ProtocolSerializer.decodeEnvelope(raw) }.getOrNull() ?: return
        when (envelope.type) {
            "session.start" -> {
                val incomingSessionId = envelope.payload["sessionId"]?.jsonPrimitive?.content
                val incomingResume = envelope.payload["sessionResumeToken"]?.jsonPrimitive?.content
                if (!incomingSessionId.isNullOrBlank()) {
                    sessionId = incomingSessionId
                }
                if (!incomingResume.isNullOrBlank() && incomingResume != "sync_update") {
                    sessionResumeToken = incomingResume
                }
                val approved = envelope.payload["approved"]?.jsonPrimitive?.booleanOrNull ?: true
                if (approved) {
                    _connectionStatus.value = ConnectionStatus.CONNECTED_SYNCED
                    val syncPayload = runCatching {
                        ProtocolSerializer.decodePayload<ServerSessionSyncPayload>(envelope)
                    }.getOrNull()
                    if (syncPayload != null) {
                        _serverSyncState.value = syncPayload
                    }
                    if (incomingResume != "sync_update") {
                        flushPendingOperations()
                    }
                } else {
                    _connectionStatus.value = ConnectionStatus.AWAITING_APPROVAL
                }
            }

            "operation.ack" -> {
                val ack = runCatching {
                    ProtocolSerializer.decodePayload<OperationAckPayload>(envelope)
                }.getOrNull() ?: return
                lastAckedOperationId = ack.operationId
                scope.launch {
                    pendingDao.acknowledge(ack.operationId)
                    val remaining = pendingDao.getAllPendingOrdered()
                    if (remaining.isEmpty() &&
                        _connectionStatus.value == ConnectionStatus.CONNECTED_SYNCING
                    ) {
                        _connectionStatus.value = ConnectionStatus.CONNECTED_SYNCED
                    }
                }
            }

            "session.error" -> {
                val err = runCatching {
                    ProtocolSerializer.decodePayload<SessionErrorPayload>(envelope)
                }.getOrNull() ?: return
                _lastError.value = "${err.code}: ${err.message}"
                if (err.code == "INVALID_TOKEN" || err.code == "PAIRING_TIMEOUT" || err.code == "UNAUTHORIZED") {
                    // Fallback para auto_lan e reconecta
                    pairingToken = "auto_lan"
                    sessionId = null
                    sessionResumeToken = null
                    scheduleReconnect()
                } else if (err.fatal) {
                    shouldReconnect = false
                    _connectionStatus.value = ConnectionStatus.ERROR
                }
            }
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            _connectionStatus.value = ConnectionStatus.RECONNECTING
            delay(2000L)
            openSocket(isResume = sessionId != null && sessionResumeToken != null)
        }
    }

    private fun flushPendingOperations() {
        scope.launch {
            val pending = pendingDao.getAllPendingOrdered()
            if (pending.isNotEmpty()) {
                _connectionStatus.value = ConnectionStatus.CONNECTED_SYNCING
                for (op in pending) {
                    webSocket?.send(op.serializedEnvelopeJson)
                }
            } else {
                _connectionStatus.value = ConnectionStatus.CONNECTED_SYNCED
            }
        }
    }

    // ========================================================================
    // Envio de Mensagens de Escrita, Borracha e Histórico
    // ========================================================================

    fun sendStrokeBegin(stroke: Stroke, operationId: String) {
        val firstPt = stroke.points.firstOrNull() ?: return
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "stroke.begin",
            payload = StrokeBeginPayload(
                operationId = operationId,
                strokeId = stroke.id,
                notebookId = stroke.notebookId,
                pageId = stroke.pageId,
                color = stroke.color,
                baseWidth = stroke.baseWidth,
                startPoint = firstPt
            )
        )
        webSocket?.send(jsonMsg)
    }

    fun sendStrokePoints(strokeId: String, pageId: String, seq: Int, points: List<StrokePoint>) {
        if (points.isEmpty()) return
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "stroke.points",
            payload = StrokePointsPayload(
                strokeId = strokeId,
                pageId = pageId,
                seq = seq,
                points = points
            )
        )
        webSocket?.send(jsonMsg)
    }

    fun sendStrokeCancelled(stroke: Stroke, operationId: String) {
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "stroke.end",
            payload = StrokeEndPayload(
                operationId = operationId,
                notebookId = stroke.notebookId,
                pageId = stroke.pageId,
                cancelled = true,
                stroke = stroke
            )
        )
        webSocket?.send(jsonMsg)
    }

    fun enqueueAndSendStrokeEnd(stroke: Stroke, operationId: String) {
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "stroke.end",
            payload = StrokeEndPayload(
                operationId = operationId,
                notebookId = stroke.notebookId,
                pageId = stroke.pageId,
                cancelled = false,
                stroke = stroke
            )
        )
        enqueueDurableOperation(
            operationId = operationId,
            notebookId = stroke.notebookId,
            pageId = stroke.pageId,
            messageType = "stroke.end",
            jsonMsg = jsonMsg
        )
    }

    fun enqueueAndSendErase(eraseRecord: EraseOperationRecord) {
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "strokes.erase",
            payload = StrokesErasePayload(
                operationId = eraseRecord.operationId,
                notebookId = eraseRecord.notebookId,
                pageId = eraseRecord.pageId,
                targetStrokeIds = eraseRecord.targetStrokeIds,
                removedStrokes = eraseRecord.removedStrokes
            )
        )
        enqueueDurableOperation(
            operationId = eraseRecord.operationId,
            notebookId = eraseRecord.notebookId,
            pageId = eraseRecord.pageId,
            messageType = "strokes.erase",
            jsonMsg = jsonMsg
        )
    }

    fun enqueueAndSendUndo(operationId: String, notebookId: String, pageId: String, targetOpId: String? = null) {
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "operation.undo",
            payload = OperationUndoRedoPayload(
                operationId = operationId,
                notebookId = notebookId,
                pageId = pageId,
                targetOperationId = targetOpId
            )
        )
        enqueueDurableOperation(operationId, notebookId, pageId, "operation.undo", jsonMsg)
    }

    fun enqueueAndSendRedo(operationId: String, notebookId: String, pageId: String, targetOpId: String? = null) {
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "operation.redo",
            payload = OperationUndoRedoPayload(
                operationId = operationId,
                notebookId = notebookId,
                pageId = pageId,
                targetOperationId = targetOpId
            )
        )
        enqueueDurableOperation(operationId, notebookId, pageId, "operation.redo", jsonMsg)
    }

    fun enqueueAndSendPageSelect(operationId: String, notebookId: String, pageId: String) {
        val jsonMsg = ProtocolSerializer.encodeMessage(
            type = "page.select",
            payload = PageSelectPayload(
                operationId = operationId,
                notebookId = notebookId,
                pageId = pageId
            )
        )
        enqueueDurableOperation(operationId, notebookId, pageId, "page.select", jsonMsg)
    }

    fun createNotebookRemote(notebookId: String, title: String) {
        postJsonAsync(
            path = "/api/notebooks/create",
            bodyJson = """{"notebookId":"$notebookId","title":"${title.replace("\"", "")}"}"""
        )
    }

    fun deleteNotebookRemote(notebookId: String) {
        postJsonAsync(
            path = "/api/notebooks/delete",
            bodyJson = """{"notebookId":"$notebookId"}"""
        )
    }

    fun createPageRemote(notebookId: String, pageId: String, title: String) {
        postJsonAsync(
            path = "/api/pages/create",
            bodyJson = """{"notebookId":"$notebookId","pageId":"$pageId","title":"${title.replace("\"", "")}"}"""
        )
    }

    fun deletePageRemote(pageId: String) {
        postJsonAsync(
            path = "/api/pages/delete",
            bodyJson = """{"pageId":"$pageId"}"""
        )
    }

    fun updatePageOrientationRemote(pageId: String, width: Float, height: Float) {
        postJsonAsync(
            path = "/api/pages/orientation",
            bodyJson = """{"pageId":"$pageId","width":$width,"height":$height}"""
        )
    }

    private fun postJsonAsync(path: String, bodyJson: String) {
        scope.launch(Dispatchers.IO) {
            runCatching {
                val base = resolveHttpBaseUrl()
                val req = Request.Builder()
                    .url("$base$path")
                    .post(bodyJson.toRequestBody("application/json; charset=utf-8".toMediaType()))
                    .build()
                okHttpClient.newCall(req).execute().close()
            }
        }
    }

    private fun enqueueDurableOperation(
        operationId: String,
        notebookId: String,
        pageId: String,
        messageType: String,
        jsonMsg: String
    ) {
        scope.launch {
            pendingDao.enqueue(
                PendingOperationEntity(
                    operationId = operationId,
                    notebookId = notebookId,
                    pageId = pageId,
                    messageType = messageType,
                    serializedEnvelopeJson = jsonMsg,
                    createdAt = System.currentTimeMillis()
                )
            )
            if (_connectionStatus.value == ConnectionStatus.CONNECTED_SYNCED ||
                _connectionStatus.value == ConnectionStatus.CONNECTED_SYNCING
            ) {
                _connectionStatus.value = ConnectionStatus.CONNECTED_SYNCING
                webSocket?.send(jsonMsg)
            }
        }
    }
}
