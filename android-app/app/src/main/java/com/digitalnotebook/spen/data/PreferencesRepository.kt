package com.digitalnotebook.spen.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.digitalnotebook.spen.model.FingerMode
import com.digitalnotebook.spen.model.GridSettings
import com.digitalnotebook.spen.model.InputPreferences
import com.digitalnotebook.spen.model.ScrollMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(
    name = "digital_notebook_preferences"
)

class PreferencesRepository(private val context: Context) {

    private object Keys {
        val FINGER_MODE = stringPreferencesKey("finger_mode")
        val SCROLL_MODE = stringPreferencesKey("scroll_mode")
        val PALM_REJECTION = booleanPreferencesKey("palm_rejection")
        val PINCH_ZOOM = booleanPreferencesKey("pinch_zoom")

        val GRID_ENABLED = booleanPreferencesKey("grid_enabled")
        val GRID_SPACING = floatPreferencesKey("grid_spacing")
        val GRID_COLOR = stringPreferencesKey("grid_color")
        val GRID_OPACITY = floatPreferencesKey("grid_opacity")
        val GRID_INCLUDE_PDF = booleanPreferencesKey("grid_include_pdf")
    }

    val inputPreferencesFlow: Flow<InputPreferences> = context.dataStore.data.map { prefs ->
        InputPreferences(
            fingerMode = FingerMode.fromWire(prefs[Keys.FINGER_MODE] ?: FingerMode.BOTH.wireValue),
            scrollMode = ScrollMode.fromWire(prefs[Keys.SCROLL_MODE] ?: ScrollMode.FREE.wireValue),
            palmRejection = prefs[Keys.PALM_REJECTION] ?: true,
            pinchZoom = prefs[Keys.PINCH_ZOOM] ?: true
        )
    }

    val gridSettingsFlow: Flow<GridSettings> = context.dataStore.data.map { prefs ->
        GridSettings(
            enabled = prefs[Keys.GRID_ENABLED] ?: true,
            spacing = prefs[Keys.GRID_SPACING] ?: 25f,
            color = prefs[Keys.GRID_COLOR] ?: "#94A3B8",
            opacity = prefs[Keys.GRID_OPACITY] ?: 0.45f,
            includeInPdf = prefs[Keys.GRID_INCLUDE_PDF] ?: true
        )
    }

    suspend fun updateInputPreferences(newPrefs: InputPreferences) {
        context.dataStore.edit { prefs ->
            prefs[Keys.FINGER_MODE] = newPrefs.fingerMode.wireValue
            prefs[Keys.SCROLL_MODE] = newPrefs.scrollMode.wireValue
            prefs[Keys.PALM_REJECTION] = newPrefs.palmRejection
            prefs[Keys.PINCH_ZOOM] = newPrefs.pinchZoom
        }
    }

    suspend fun updateGridSettings(grid: GridSettings) {
        context.dataStore.edit { prefs ->
            prefs[Keys.GRID_ENABLED] = grid.enabled
            prefs[Keys.GRID_SPACING] = grid.spacing
            prefs[Keys.GRID_COLOR] = grid.color
            prefs[Keys.GRID_OPACITY] = grid.opacity
            prefs[Keys.GRID_INCLUDE_PDF] = grid.includeInPdf
        }
    }
}
