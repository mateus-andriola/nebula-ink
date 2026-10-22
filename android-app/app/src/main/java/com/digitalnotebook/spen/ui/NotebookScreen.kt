package com.digitalnotebook.spen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import com.digitalnotebook.spen.data.PendingOperationDao
import com.digitalnotebook.spen.data.PreferencesRepository
import com.digitalnotebook.spen.engine.PageDocumentEngine
import com.digitalnotebook.spen.input.MotionEventRouter
import com.digitalnotebook.spen.input.MotionRouterCallbacks
import com.digitalnotebook.spen.input.ResolvedPointerRole
import com.digitalnotebook.spen.model.ActiveUiTool
import com.digitalnotebook.spen.model.ConnectionStatus
import com.digitalnotebook.spen.model.DEFAULT_PAGE_HEIGHT
import com.digitalnotebook.spen.model.DEFAULT_PAGE_WIDTH
import com.digitalnotebook.spen.model.EraseOperationRecord
import com.digitalnotebook.spen.model.FingerMode
import com.digitalnotebook.spen.model.GridSettings
import com.digitalnotebook.spen.model.InputPreferences
import com.digitalnotebook.spen.model.ScrollMode
import com.digitalnotebook.spen.model.ShapeToolKind
import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.StrokePoint
import com.digitalnotebook.spen.model.ViewportTransform
import com.digitalnotebook.spen.sync.SyncWebSocketClient
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.roundToInt

private val PRESET_COLORS = listOf(
    "#F8FAFC", // Branco / Tinta Clara (convertida para Preto #000000 na exportação PDF)
    "#60A5FA", // Azul Claro Vibrante
    "#F87171", // Vermelho Coral
    "#34D399", // Verde Esmeralda
    "#C084FC", // Roxo Lavanda
    "#FBBF24"  // Âmbar / Amarelo
)

data class MobilePageItem(
    val id: String,
    val title: String,
    val width: Float = DEFAULT_PAGE_WIDTH,
    val height: Float = DEFAULT_PAGE_HEIGHT
)

data class MobileNotebookItem(
    val id: String,
    val title: String,
    val pages: List<MobilePageItem>
)

@Composable
fun NotebookScreen(
    preferencesRepository: PreferencesRepository,
    pendingDao: PendingOperationDao,
    syncClient: SyncWebSocketClient
) {
    val scope = rememberCoroutineScope()
    val inputPrefs by preferencesRepository.inputPreferencesFlow.collectAsState(
        initial = InputPreferences()
    )
    val gridSettings by preferencesRepository.gridSettingsFlow.collectAsState(
        initial = GridSettings()
    )
    val connectionStatus by syncClient.connectionStatus.collectAsState()
    val serverSync by syncClient.serverSyncState.collectAsState()
    val pendingOpsCount by pendingDao.observePendingCount().collectAsState(initial = 0)

    // Lista gerenciável de Cadernos e Páginas (suporta criar, alternar e remover/excluir)
    val notebooks = remember {
        mutableStateListOf(
            MobileNotebookItem(
                id = "nb_default",
                title = "Caderno 1",
                pages = listOf(MobilePageItem(id = "page_default_1", title = "Página 1"))
            )
        )
    }

    var activeNotebookId by remember { mutableStateOf("nb_default") }
    var activePageId by remember { mutableStateOf("page_default_1") }

    val activeNotebook = notebooks.firstOrNull { it.id == activeNotebookId } ?: notebooks.first()
    val activePageIndexZeroBased = activeNotebook.pages.indexOfFirst { it.id == activePageId }.coerceAtLeast(0)
    val activePage = activeNotebook.pages.getOrElse(activePageIndexZeroBased) { activeNotebook.pages.first() }

    val pageEngines = remember { HashMap<String, PageDocumentEngine>() }
    val currentEngine = remember(activeNotebookId, activePageId) {
        pageEngines.getOrPut("$activeNotebookId:$activePageId") {
            PageDocumentEngine(notebookId = activeNotebookId, pageId = activePageId)
        }
    }
    var currentEngineRef by remember { mutableStateOf(currentEngine) }
    currentEngineRef = currentEngine

    var strokesState by remember { mutableStateOf(currentEngine.getStrokes()) }
    var viewportState by remember { mutableStateOf(ViewportTransform(scale = 1.08f, panX = 0f, panY = 0f)) }
    var activeTool by remember { mutableStateOf(ActiveUiTool.PEN) }
    var activeShapeTool by remember { mutableStateOf(ShapeToolKind.NONE) }
    var polygonSides by remember { mutableIntStateOf(5) }
    var showShapesToolbar by remember { mutableStateOf(false) }
    var showTopBars by remember { mutableStateOf(true) }
    var selectedColor by remember { mutableStateOf(PRESET_COLORS.first()) }
    var penWidth by remember { mutableFloatStateOf(3.5f) }
    var eraserRadius by remember { mutableFloatStateOf(14.0f) }
    var showScrollbars by remember { mutableStateOf(true) }

    var showNotebooksModal by remember { mutableStateOf(false) }
    var showSettingsModal by remember { mutableStateOf(false) }
    var showPairingModal by remember { mutableStateOf(false) }
    var canvasViewRef by remember { mutableStateOf<SPenCanvasView?>(null) }

    val selectNotebookAndPage = { nbId: String, pgId: String ->
        activeNotebookId = nbId
        activePageId = pgId
        val opId = "op_page_${UUID.randomUUID().toString().take(8)}"
        syncClient.enqueueAndSendPageSelect(opId, nbId, pgId)
    }

    // Sincroniza cadernos, páginas e traços vindos do servidor Desktop
    LaunchedEffect(serverSync) {
        val sync = serverSync ?: return@LaunchedEffect
        if (sync.notebooks.isNotEmpty()) {
            val mapped = sync.notebooks.map { nb ->
                MobileNotebookItem(
                    id = nb.id,
                    title = nb.title,
                    pages = if (nb.pages.isNotEmpty()) {
                        nb.pages.map { pg ->
                            MobilePageItem(
                                id = pg.id,
                                title = pg.title,
                                width = if (pg.width > 100f) pg.width else DEFAULT_PAGE_WIDTH,
                                height = if (pg.height > 100f) pg.height else DEFAULT_PAGE_HEIGHT
                            )
                        }
                    } else {
                        listOf(MobilePageItem(id = "page_default_1", title = "Página 1"))
                    }
                )
            }
            notebooks.clear()
            notebooks.addAll(mapped)
        }
        activeNotebookId = sync.activeNotebookId
        activePageId = sync.activePageId

        val activeSnap = sync.activePage
        if (activeSnap != null) {
            val eng = pageEngines.getOrPut("${sync.activeNotebookId}:${sync.activePageId}") {
                PageDocumentEngine(notebookId = sync.activeNotebookId, pageId = sync.activePageId)
            }
            eng.replacePageStrokes(activeSnap.strokes)
            if (currentEngineRef.pageId == sync.activePageId) {
                strokesState = eng.getStrokes()
                canvasViewRef?.setPageDimensions(activeSnap.metadata.width, activeSnap.metadata.height)
                canvasViewRef?.setCommittedStrokes(strokesState)
            }
        }
    }

    val motionRouter = remember {
        MotionEventRouter(
            pageEngine = currentEngine,
            callbacks = object : MotionRouterCallbacks {
                override fun onProvisionalStrokeBegin(stroke: Stroke, operationId: String) {
                    syncClient.sendStrokeBegin(stroke, operationId)
                }

                override fun onProvisionalStrokePoints(
                    strokeId: String,
                    seq: Int,
                    addedPoints: List<StrokePoint>
                ) {
                    syncClient.sendStrokePoints(strokeId, currentEngineRef.pageId, seq, addedPoints)
                }

                override fun onProvisionalStrokeCancelled(strokeId: String, operationId: String) {
                    val dummy = Stroke(
                        id = strokeId,
                        pageId = currentEngineRef.pageId,
                        notebookId = currentEngineRef.notebookId,
                        color = selectedColor,
                        baseWidth = penWidth,
                        points = emptyList(),
                        createdAt = System.currentTimeMillis()
                    )
                    syncClient.sendStrokeCancelled(dummy, operationId)
                    canvasViewRef?.setProvisionalStroke(null)
                }

                override fun onStrokeCommitted(stroke: Stroke, operationId: String) {
                    val updated = currentEngineRef.getStrokes()
                    strokesState = updated
                    canvasViewRef?.appendCommittedStrokeIncrementally(stroke, updated)
                    syncClient.enqueueAndSendStrokeEnd(stroke, operationId)
                }

                override fun onStrokesErased(eraseRecord: EraseOperationRecord) {
                    val updated = currentEngineRef.getStrokes()
                    strokesState = updated
                    canvasViewRef?.setCommittedStrokes(updated)
                    syncClient.enqueueAndSendErase(eraseRecord)
                }

                override fun onViewportUpdated(viewport: ViewportTransform) {
                    viewportState = viewport
                    canvasViewRef?.setViewportTransform(viewport)
                }

                override fun onHoverPreview(
                    role: ResolvedPointerRole,
                    logicalX: Float,
                    logicalY: Float
                ) {
                    canvasViewRef?.setHoverPreview(role, logicalX, logicalY, eraserRadius)
                }
            }
        )
    }

    LaunchedEffect(Unit) {
        motionRouter.updateViewport(viewportState)
    }

    // Atualiza preferências em tempo real sem exigir reinicialização
    LaunchedEffect(inputPrefs) {
        motionRouter.preferences = inputPrefs
    }

    LaunchedEffect(activeTool, activeShapeTool, polygonSides, selectedColor, penWidth, eraserRadius) {
        motionRouter.activeUiTool = activeTool
        motionRouter.activeShapeTool = activeShapeTool
        motionRouter.polygonSides = polygonSides
        motionRouter.penColor = selectedColor
        motionRouter.penBaseWidth = penWidth
        motionRouter.setEraserRadius(eraserRadius)
    }

    val togglePageOrientation = {
        val isCurrentlyLandscape = activePage.width > activePage.height
        val nextW = if (isCurrentlyLandscape) DEFAULT_PAGE_WIDTH else DEFAULT_PAGE_HEIGHT
        val nextH = if (isCurrentlyLandscape) DEFAULT_PAGE_HEIGHT else DEFAULT_PAGE_WIDTH
        val nbIdx = notebooks.indexOfFirst { it.id == activeNotebook.id }
        if (nbIdx >= 0) {
            val updatedPages = activeNotebook.pages.map { pg ->
                if (pg.id == activePage.id) pg.copy(width = nextW, height = nextH) else pg
            }
            notebooks[nbIdx] = activeNotebook.copy(pages = updatedPages)
        }
        canvasViewRef?.setPageDimensions(nextW, nextH)
        val viewW = canvasViewRef?.width ?: 0
        if (viewW > 0) {
            val fitted = viewportState.copy(scale = viewW.toFloat() / nextW, panX = 0f, panY = 0f)
            motionRouter.updateViewport(fitted)
        }
        syncClient.updatePageOrientationRemote(activePage.id, nextW, nextH)
    }

    LaunchedEffect(currentEngine) {
        motionRouter.attachPageEngine(currentEngine)
        strokesState = currentEngine.getStrokes()
        canvasViewRef?.setCommittedStrokes(strokesState)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF020617))
            .statusBarsPadding()
    ) {
        if (showTopBars) {
            // Barra Superior Compacta (Altura fixa 46dp, modo Dark)
            Surface(
                tonalElevation = 2.dp,
                color = Color(0xFF0F172A),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(46.dp)
                    .zIndex(2f)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    // Botão Principal de Gerenciamento de Cadernos e Páginas
                    Box(
                        modifier = Modifier
                            .weight(1f, fill = false)
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF2563EB))
                            .clickable { showNotebooksModal = true }
                            .padding(horizontal = 8.dp, vertical = 6.dp)
                    ) {
                        Text(
                            text = "📚 ${activeNotebook.title} • Pág ${activePageIndexZeroBased + 1}/${activeNotebook.pages.size}",
                            color = Color.White,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 11.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        CompactTopBarButton(
                            text = "<",
                            enabled = activePageIndexZeroBased > 0,
                            onClick = {
                                if (activePageIndexZeroBased > 0) {
                                    val prevPage = activeNotebook.pages[activePageIndexZeroBased - 1]
                                    selectNotebookAndPage(activeNotebook.id, prevPage.id)
                                }
                            }
                        )

                        CompactTopBarButton(
                            text = if (activePageIndexZeroBased < activeNotebook.pages.lastIndex) ">" else "+Pág",
                            enabled = true,
                            onClick = {
                                if (activePageIndexZeroBased < activeNotebook.pages.lastIndex) {
                                    val nextPage = activeNotebook.pages[activePageIndexZeroBased + 1]
                                    selectNotebookAndPage(activeNotebook.id, nextPage.id)
                                } else {
                                    val newPageNum = activeNotebook.pages.size + 1
                                    val newPageId = "page_${System.currentTimeMillis()}"
                                    val newTitle = "Página $newPageNum"
                                    val newPage = MobilePageItem(
                                        id = newPageId,
                                        title = newTitle
                                    )
                                    val nbIndex = notebooks.indexOfFirst { it.id == activeNotebook.id }
                                    if (nbIndex >= 0) {
                                        notebooks[nbIndex] = activeNotebook.copy(
                                            pages = activeNotebook.pages + newPage
                                        )
                                        syncClient.createPageRemote(activeNotebook.id, newPageId, newTitle)
                                        selectNotebookAndPage(activeNotebook.id, newPage.id)
                                    }
                                }
                            }
                        )

                        CompactTopBarButton(
                            text = "↶",
                            enabled = currentEngine.canUndo(),
                            onClick = {
                                val opId = "op_undo_${UUID.randomUUID().toString().take(8)}"
                                val undone = currentEngine.applyUndo(opId)
                                if (undone != null) {
                                    strokesState = currentEngine.getStrokes()
                                    canvasViewRef?.setCommittedStrokes(strokesState)
                                    syncClient.enqueueAndSendUndo(
                                        opId,
                                        activeNotebookId,
                                        activePageId,
                                        undone.operationId
                                    )
                                }
                            }
                        )

                        CompactTopBarButton(
                            text = "↷",
                            enabled = currentEngine.canRedo(),
                            onClick = {
                                val opId = "op_redo_${UUID.randomUUID().toString().take(8)}"
                                val redone = currentEngine.applyRedo(opId)
                                if (redone != null) {
                                    strokesState = currentEngine.getStrokes()
                                    canvasViewRef?.setCommittedStrokes(strokesState)
                                    syncClient.enqueueAndSendRedo(
                                        opId,
                                        activeNotebookId,
                                        activePageId,
                                        redone.operationId
                                    )
                                }
                            }
                        )

                        CompactTopBarButton(
                            text = if (activePage.width > activePage.height) "📄H" else "📄V",
                            enabled = true,
                            onClick = { togglePageOrientation() }
                        )

                        ConnectionBadge(
                            status = connectionStatus,
                            pendingCount = pendingOpsCount,
                            onClick = { showPairingModal = true }
                        )

                        CompactTopBarButton(
                            text = "⚙",
                            enabled = true,
                            onClick = { showSettingsModal = true }
                        )

                        CompactTopBarButton(
                            text = "▲",
                            enabled = true,
                            onClick = { showTopBars = false }
                        )
                    }
                }
            }

            // Barra de Ferramentas S Pen (Altura fixa 46dp, modo Dark, rolagem horizontal sem quebra de linha)
            Surface(
                color = Color(0xFF1E293B),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(46.dp)
                    .zIndex(2f)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxSize()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    FilterChip(
                        selected = activeTool == ActiveUiTool.PEN && activeShapeTool == ShapeToolKind.NONE,
                        onClick = {
                            activeTool = ActiveUiTool.PEN
                            activeShapeTool = ShapeToolKind.NONE
                        },
                        label = { Text("Caneta", fontSize = 12.sp, maxLines = 1) },
                        modifier = Modifier.height(32.dp)
                    )
                    FilterChip(
                        selected = activeTool == ActiveUiTool.ERASER,
                        onClick = { activeTool = ActiveUiTool.ERASER },
                        label = { Text("Borracha", fontSize = 12.sp, maxLines = 1) },
                        modifier = Modifier.height(32.dp)
                    )
                    FilterChip(
                        selected = activePage.width > activePage.height,
                        onClick = { togglePageOrientation() },
                        label = {
                            Text(
                                if (activePage.width > activePage.height) "Folha: Horiz" else "Folha: Vert",
                                fontSize = 11.sp,
                                maxLines = 1
                            )
                        },
                        modifier = Modifier.height(32.dp)
                    )

                    // Seletor de Cores
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        for (hex in PRESET_COLORS) {
                            val parsed = Color(android.graphics.Color.parseColor(hex))
                            val isSelected = selectedColor.equals(hex, ignoreCase = true)
                            Box(
                                modifier = Modifier
                                    .size(22.dp)
                                    .clip(CircleShape)
                                    .background(parsed)
                                    .border(
                                        width = if (isSelected) 2.5.dp else 1.dp,
                                        color = if (isSelected) Color(0xFF38BDF8) else Color(0xFF475569),
                                        shape = CircleShape
                                    )
                                    .clickable {
                                        selectedColor = hex
                                        activeTool = ActiveUiTool.PEN
                                    }
                            )
                        }
                    }

                    // Espessura ou Raio da Borracha
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.width(135.dp)
                    ) {
                        if (activeTool == ActiveUiTool.PEN) {
                            Text("${penWidth.roundToInt()}pt", fontSize = 11.sp, maxLines = 1)
                            Slider(
                                value = penWidth,
                                onValueChange = { penWidth = it },
                                valueRange = 1.5f..18.0f
                            )
                        } else {
                            Text("R:${eraserRadius.roundToInt()}", fontSize = 11.sp, maxLines = 1)
                            Slider(
                                value = eraserRadius,
                                onValueChange = { eraserRadius = it },
                                valueRange = 6.0f..40.0f
                            )
                        }
                    }
                }
            }
        }

        // Área de Escrita Principal + Barras Discretas nas Bordas (estritamente recortada aos seus limites)
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clipToBounds()
        ) {
            AndroidView(
                factory = { ctx ->
                    SPenCanvasView(ctx).apply {
                        this.motionRouter = motionRouter
                        setPageDimensions(activePage.width, activePage.height)
                        setCommittedStrokes(strokesState)
                        setViewportTransform(viewportState)
                        setGridConfiguration(gridSettings)
                        canvasViewRef = this
                    }
                },
                update = { view ->
                    view.setPageDimensions(activePage.width, activePage.height)
                    view.setGridConfiguration(gridSettings)
                    view.setViewportTransform(viewportState)
                },
                modifier = Modifier.fillMaxSize()
            )

            // Botão compacto para reabrir as barras superiores quando recolhidas
            if (!showTopBars) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 6.dp, end = 10.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0xEE0F172A))
                        .border(1.dp, Color(0xFF334155), RoundedCornerShape(8.dp))
                        .clickable { showTopBars = true }
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                ) {
                    Text(
                        text = "▼ Menu",
                        color = Color(0xFFF8FAFC),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            // Barra Lateral Recolhível de Formas Geométricas (Borda Esquerda)
            if (!showShapesToolbar) {
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterStart)
                        .clip(RoundedCornerShape(topEnd = 10.dp, bottomEnd = 10.dp))
                        .background(
                            if (activeShapeTool != ShapeToolKind.NONE) Color(0xFF2563EB) else Color(0xEE0F172A)
                        )
                        .border(
                            width = 1.dp,
                            color = Color(0xFF334155),
                            shape = RoundedCornerShape(topEnd = 10.dp, bottomEnd = 10.dp)
                        )
                        .clickable { showShapesToolbar = true }
                        .padding(horizontal = 8.dp, vertical = 14.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text(
                            text = if (activeShapeTool != ShapeToolKind.NONE) activeShapeTool.icon else "⬡",
                            color = Color.White,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "▶",
                            color = Color(0xFF94A3B8),
                            fontSize = 10.sp
                        )
                    }
                }
            } else {
                Surface(
                    color = Color(0xF20F172A),
                    shape = RoundedCornerShape(topEnd = 12.dp, bottomEnd = 12.dp),
                    tonalElevation = 6.dp,
                    modifier = Modifier
                        .align(Alignment.CenterStart)
                        .width(142.dp)
                        .border(
                            width = 1.dp,
                            color = Color(0xFF334155),
                            shape = RoundedCornerShape(topEnd = 12.dp, bottomEnd = 12.dp)
                        )
                ) {
                    Column(
                        modifier = Modifier
                            .padding(8.dp)
                            .verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "Formas",
                                color = Color(0xFFF8FAFC),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(Color(0xFF1E293B))
                                    .clickable { showShapesToolbar = false }
                                    .padding(horizontal = 7.dp, vertical = 4.dp)
                            ) {
                                Text(
                                    text = "◀",
                                    color = Color(0xFFF8FAFC),
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }

                        ShapeToolKind.entries.forEach { shapeKind ->
                            val isSelected = activeTool == ActiveUiTool.PEN && activeShapeTool == shapeKind
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(
                                        if (isSelected) Color(0xFF2563EB) else Color(0xFF1E293B)
                                    )
                                    .border(
                                        width = 1.dp,
                                        color = if (isSelected) Color(0xFF60A5FA) else Color(0xFF334155),
                                        shape = RoundedCornerShape(8.dp)
                                    )
                                    .clickable {
                                        activeTool = ActiveUiTool.PEN
                                        activeShapeTool = shapeKind
                                    }
                                    .padding(horizontal = 8.dp, vertical = 7.dp)
                            ) {
                                Text(
                                    text = "${shapeKind.icon}  ${shapeKind.label}",
                                    color = Color(0xFFF8FAFC),
                                    fontSize = 11.sp,
                                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                                    maxLines = 1
                                )
                            }
                        }

                        // Seletor do número de lados N para o Polígono de lado N
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFF1E293B))
                                .border(1.dp, Color(0xFF334155), RoundedCornerShape(8.dp))
                                .padding(6.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Text(
                                text = "Lados N: $polygonSides",
                                color = Color(0xFFCBD5E1),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium
                            )
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceEvenly,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                CompactTopBarButton(
                                    text = "-",
                                    enabled = polygonSides > 3,
                                    onClick = {
                                        if (polygonSides > 3) {
                                            polygonSides -= 1
                                            activeTool = ActiveUiTool.PEN
                                            activeShapeTool = ShapeToolKind.POLYGON_N
                                        }
                                    }
                                )
                                Text(
                                    text = "$polygonSides",
                                    color = Color(0xFFF8FAFC),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )
                                CompactTopBarButton(
                                    text = "+",
                                    enabled = polygonSides < 20,
                                    onClick = {
                                        if (polygonSides < 20) {
                                            polygonSides += 1
                                            activeTool = ActiveUiTool.PEN
                                            activeShapeTool = ShapeToolKind.POLYGON_N
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }

            // Indicadores visuais discretos nas bordas (sem interceptar eventos de toque/S Pen nas bordas)
            if (showScrollbars) {
                // Indicador Vertical (Borda Direita)
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .fillMaxHeight()
                        .width(4.dp)
                ) {
                    val progressY = (-viewportState.panY / (activePage.height * viewportState.scale))
                        .coerceIn(0f, 0.85f)
                    Box(
                        modifier = Modifier
                            .offset { IntOffset(0, (progressY * 400).roundToInt()) }
                            .width(4.dp)
                            .height(48.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(Color(0x66475569))
                    )
                }

                // Indicador Horizontal (Borda Inferior)
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(4.dp)
                ) {
                    val progressX = (-viewportState.panX / (activePage.width * viewportState.scale))
                        .coerceIn(0f, 0.85f)
                    Box(
                        modifier = Modifier
                            .offset { IntOffset((progressX * 300).roundToInt(), 0) }
                            .height(4.dp)
                            .width(48.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(Color(0x66475569))
                    )
                }
            }
        }
    }

    // Modal de Gerenciamento de Cadernos e Páginas (Criar, Selecionar e Excluir/Remover)
    if (showNotebooksModal) {
        NotebooksAndPagesDialog(
            notebooks = notebooks,
            activeNotebookId = activeNotebook.id,
            activePageId = activePage.id,
            onSelectPage = { nbId, pgId ->
                selectNotebookAndPage(nbId, pgId)
                showNotebooksModal = false
            },
            onCreateNotebook = { customTitle ->
                val newNbId = "nb_${System.currentTimeMillis()}"
                val newPgId = "${newNbId}_p1"
                val title = customTitle.ifBlank { "Caderno ${notebooks.size + 1}" }
                notebooks.add(
                    MobileNotebookItem(
                        id = newNbId,
                        title = title,
                        pages = listOf(MobilePageItem(id = newPgId, title = "Página 1"))
                    )
                )
                syncClient.createNotebookRemote(newNbId, title)
                selectNotebookAndPage(newNbId, newPgId)
            },
            onDeleteNotebook = { nbId ->
                val target = notebooks.firstOrNull { it.id == nbId }
                if (target != null) {
                    target.pages.forEach { pg -> pageEngines.remove("$nbId:${pg.id}") }
                    notebooks.removeAll { it.id == nbId }
                }
                syncClient.deleteNotebookRemote(nbId)
                if (notebooks.isEmpty()) {
                    val freshNbId = "nb_${System.currentTimeMillis()}"
                    val freshPgId = "${freshNbId}_p1"
                    notebooks.add(
                        MobileNotebookItem(
                            id = freshNbId,
                            title = "Caderno 1",
                            pages = listOf(MobilePageItem(id = freshPgId, title = "Página 1"))
                        )
                    )
                }
                val fallbackNb = notebooks.firstOrNull { it.id == activeNotebookId } ?: notebooks.first()
                selectNotebookAndPage(fallbackNb.id, fallbackNb.pages.first().id)
            },
            onCreatePage = { nbId ->
                val idx = notebooks.indexOfFirst { it.id == nbId }
                if (idx >= 0) {
                    val nb = notebooks[idx]
                    val newPgId = "page_${System.currentTimeMillis()}"
                    val newTitle = "Página ${nb.pages.size + 1}"
                    val newPage = MobilePageItem(
                        id = newPgId,
                        title = newTitle
                    )
                    notebooks[idx] = nb.copy(pages = nb.pages + newPage)
                    syncClient.createPageRemote(nbId, newPgId, newTitle)
                    selectNotebookAndPage(nbId, newPgId)
                }
            },
            onDeletePage = { nbId, pgId ->
                pageEngines.remove("$nbId:$pgId")
                syncClient.deletePageRemote(pgId)
                val idx = notebooks.indexOfFirst { it.id == nbId }
                if (idx >= 0) {
                    val nb = notebooks[idx]
                    val remaining = nb.pages.filterNot { it.id == pgId }
                    val updatedPages = if (remaining.isEmpty()) {
                        listOf(
                            MobilePageItem(
                                id = "page_${System.currentTimeMillis()}",
                                title = "Página 1"
                            )
                        )
                    } else {
                        remaining
                    }
                    notebooks[idx] = nb.copy(pages = updatedPages)
                    if (activePageId == pgId) {
                        selectNotebookAndPage(nbId, updatedPages.first().id)
                    }
                }
            },
            onDismiss = { showNotebooksModal = false }
        )
    }

    if (showSettingsModal) {
        InputAndGridSettingsDialog(
            inputPrefs = inputPrefs,
            gridSettings = gridSettings,
            showScrollbars = showScrollbars,
            onToggleScrollbars = { showScrollbars = it },
            onUpdateInputPrefs = { updated ->
                scope.launch { preferencesRepository.updateInputPreferences(updated) }
            },
            onUpdateGrid = { updated ->
                scope.launch { preferencesRepository.updateGridSettings(updated) }
            },
            onDismiss = { showSettingsModal = false }
        )
    }

    if (showPairingModal) {
        PairingConnectionDialog(
            status = connectionStatus,
            initialWsUrl = syncClient.getCurrentWsUrl(),
            onConnect = { wsUrl, token, extraCandidates ->
                syncClient.connectWithPairingToken(wsUrl, token, extraCandidates)
                showPairingModal = false
            },
            onDisconnect = { syncClient.disconnect() },
            onDismiss = { showPairingModal = false }
        )
    }
}

@Composable
private fun NotebooksAndPagesDialog(
    notebooks: List<MobileNotebookItem>,
    activeNotebookId: String,
    activePageId: String,
    onSelectPage: (String, String) -> Unit,
    onCreateNotebook: (String) -> Unit,
    onDeleteNotebook: (String) -> Unit,
    onCreatePage: (String) -> Unit,
    onDeletePage: (String, String) -> Unit,
    onDismiss: () -> Unit
) {
    var newNotebookName by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Gerenciar Cadernos e Páginas") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    OutlinedTextField(
                        value = newNotebookName,
                        onValueChange = { newNotebookName = it },
                        label = { Text("Nome do novo caderno") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    Button(
                        onClick = {
                            onCreateNotebook(newNotebookName.trim())
                            newNotebookName = ""
                        }
                    ) {
                        Text("+ Caderno")
                    }
                }

                for (nb in notebooks) {
                    val isNbActive = nb.id == activeNotebookId
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (isNbActive) Color(0xFF1E3A8A) else Color(0xFF1E293B))
                            .padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "${nb.title} (${nb.pages.size} pág.)",
                                fontWeight = FontWeight.Bold,
                                color = Color(0xFFF8FAFC),
                                fontSize = 14.sp
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                OutlinedButton(
                                    onClick = { onCreatePage(nb.id) },
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                                    modifier = Modifier.height(30.dp)
                                ) {
                                    Text("+ Pág", fontSize = 11.sp, color = Color(0xFFF8FAFC))
                                }
                                Button(
                                    onClick = { onDeleteNotebook(nb.id) },
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = Color(0xFFEF4444)
                                    ),
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                                    modifier = Modifier.height(30.dp)
                                ) {
                                    Text("✕ Excluir", fontSize = 11.sp, color = Color.White)
                                }
                            }
                        }

                        for ((idx, pg) in nb.pages.withIndex()) {
                            val isPgActive = pg.id == activePageId && isNbActive
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(if (isPgActive) Color(0xFF2563EB) else Color(0xFF0F172A))
                                    .clickable { onSelectPage(nb.id, pg.id) }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "${idx + 1}. ${pg.title}",
                                    fontSize = 13.sp,
                                    color = Color(0xFFF8FAFC),
                                    fontWeight = if (isPgActive) FontWeight.SemiBold else FontWeight.Normal
                                )
                                TextButton(
                                    onClick = { onDeletePage(nb.id, pg.id) },
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                                    modifier = Modifier.height(26.dp)
                                ) {
                                    Text(
                                        text = "✕ Remover",
                                        color = Color(0xFFFCA5A5),
                                        fontSize = 11.sp
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) {
                Text("Fechar")
            }
        }
    )
}

@Composable
private fun CompactTopBarButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (enabled) Color(0xFF1E293B) else Color(0xFF0F172A))
            .border(
                width = 1.dp,
                color = if (enabled) Color(0xFF334155) else Color(0xFF1E293B),
                shape = RoundedCornerShape(6.dp)
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 7.dp, vertical = 5.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = if (enabled) Color(0xFFF8FAFC) else Color(0xFF475569),
            maxLines = 1
        )
    }
}

@Composable
private fun ConnectionBadge(
    status: ConnectionStatus,
    pendingCount: Int,
    onClick: () -> Unit
) {
    val (bgColor, fgColor, label) = when (status) {
        ConnectionStatus.CONNECTED_SYNCED -> Triple(Color(0xFF064E3B), Color(0xFF6EE7B7), "● Sync")
        ConnectionStatus.CONNECTED_SYNCING -> Triple(Color(0xFF78350F), Color(0xFFFDE68A), "Sync ($pendingCount)")
        ConnectionStatus.CONNECTING,
        ConnectionStatus.RECONNECTING -> Triple(Color(0xFF0C4A6E), Color(0xFF7DD3FC), "Sync...")
        ConnectionStatus.AWAITING_APPROVAL -> Triple(Color(0xFF78350F), Color(0xFFFDE68A), "Aprovar")
        ConnectionStatus.ERROR -> Triple(Color(0xFF7F1D1D), Color(0xFFFECACA), "Erro")
        ConnectionStatus.DISCONNECTED -> Triple(Color(0xFF1E293B), Color(0xFF94A3B8), "Parear")
    }

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(bgColor)
            .clickable { onClick() }
            .padding(horizontal = 7.dp, vertical = 5.dp)
    ) {
        Text(
            text = label,
            color = fgColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1
        )
    }
}

@Composable
private fun InputAndGridSettingsDialog(
    inputPrefs: InputPreferences,
    gridSettings: GridSettings,
    showScrollbars: Boolean,
    onToggleScrollbars: (Boolean) -> Unit,
    onUpdateInputPrefs: (InputPreferences) -> Unit,
    onUpdateGrid: (GridSettings) -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Configurações de Entrada e Grade") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text("Modo do Dedo (fingerMode):", fontWeight = FontWeight.SemiBold)
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    FingerMode.entries.forEach { mode ->
                        FilterChip(
                            selected = inputPrefs.fingerMode == mode,
                            onClick = { onUpdateInputPrefs(inputPrefs.copy(fingerMode = mode)) },
                            label = { Text(mode.wireValue, maxLines = 1) }
                        )
                    }
                }

                Text("Modo de Scroll (scrollMode):", fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ScrollMode.entries.forEach { mode ->
                        FilterChip(
                            selected = inputPrefs.scrollMode == mode,
                            onClick = { onUpdateInputPrefs(inputPrefs.copy(scrollMode = mode)) },
                            label = { Text(mode.wireValue, maxLines = 1) }
                        )
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Rejeição de Palma (palmRejection)")
                    Switch(
                        checked = inputPrefs.palmRejection,
                        onCheckedChange = {
                            onUpdateInputPrefs(inputPrefs.copy(palmRejection = it))
                        }
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Zoom por Pinça (pinchZoom)")
                    Switch(
                        checked = inputPrefs.pinchZoom,
                        onCheckedChange = {
                            onUpdateInputPrefs(inputPrefs.copy(pinchZoom = it))
                        }
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Exibir barras discretas nas bordas")
                    Switch(
                        checked = showScrollbars,
                        onCheckedChange = onToggleScrollbars
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Grade Pontilhada Visível")
                    Switch(
                        checked = gridSettings.enabled,
                        onCheckedChange = { onUpdateGrid(gridSettings.copy(enabled = it)) }
                    )
                }

                Text("Espaçamento da Grade: ${gridSettings.spacing.roundToInt()}px")
                Slider(
                    value = gridSettings.spacing,
                    onValueChange = { onUpdateGrid(gridSettings.copy(spacing = it)) },
                    valueRange = 15f..60f
                )

                Text("Opacidade da Grade: ${(gridSettings.opacity * 100).roundToInt()}%")
                Slider(
                    value = gridSettings.opacity,
                    onValueChange = { onUpdateGrid(gridSettings.copy(opacity = it)) },
                    valueRange = 0.1f..1.0f
                )
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) {
                Text("Concluído")
            }
        }
    )
}

@Composable
private fun PairingConnectionDialog(
    status: ConnectionStatus,
    initialWsUrl: String,
    onConnect: (String, String, List<String>) -> Unit,
    onDisconnect: () -> Unit,
    onDismiss: () -> Unit
) {
    var wsUrl by remember { mutableStateOf(initialWsUrl.ifBlank { "ws://192.168.100.8:8765" }) }
    var token by remember { mutableStateOf("") }
    var showCameraScanner by remember { mutableStateOf(true) }
    var scanFeedback by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Parear com Desktop (Câmera QR / LAN)") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = { showCameraScanner = !showCameraScanner },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (showCameraScanner) Color(0xFF2563EB) else Color(0xFF334155)
                        ),
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(
                            text = if (showCameraScanner) "📷 Câmera Ativa" else "📷 Escanear QR Code",
                            fontSize = 12.sp
                        )
                    }
                    OutlinedButton(
                        onClick = {
                            onConnect(
                                "ws://127.0.0.1:8765",
                                "auto_lan",
                                listOf("ws://192.168.100.8:8765")
                            )
                        },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("⚡ Auto USB/LAN", fontSize = 12.sp)
                    }
                }

                if (showCameraScanner) {
                    QrCodeCameraScannerBox(
                        onQrCodeScanned = { parsed ->
                            wsUrl = parsed.wsUrl
                            token = parsed.pairingToken
                            scanFeedback = "QR Code lido! Conectando a ${parsed.wsUrl}..."
                            onConnect(parsed.wsUrl, parsed.pairingToken, parsed.candidateUrls)
                        }
                    )
                }

                if (scanFeedback != null) {
                    Text(
                        text = scanFeedback!!,
                        color = Color(0xFF34D399),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }

                Text(
                    text = "Ou conecte manualmente informando o servidor e token:",
                    fontSize = 12.sp,
                    color = Color(0xFF94A3B8)
                )
                OutlinedTextField(
                    value = wsUrl,
                    onValueChange = { wsUrl = it },
                    label = { Text("Servidor WebSocket LAN") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("Token Temporário (opcional na LAN)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(onClick = { onConnect(wsUrl.trim(), token.trim(), emptyList()) }) {
                Text("Conectar")
            }
        },
        dismissButton = {
            Row {
                if (status != ConnectionStatus.DISCONNECTED) {
                    TextButton(onClick = onDisconnect) {
                        Text("Desconectar")
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text("Fechar")
                }
            }
        }
    )
}
