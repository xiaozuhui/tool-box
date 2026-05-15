import { invoke } from '@tauri-apps/api/core'
import type {
    DictionaryDashboard,
    DictionaryMetadata,
    DictionarySettings,
    FavoriteEntry,
    FavoritePayload,
    HistoryEntry,
    ProcessResponse,
    ToolRequest,
    TranslationQueryRequest,
    TranslationResult,
} from '../types'

function isTauriRuntime() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function runTool(request: ToolRequest) {
    if (!isTauriRuntime()) {
        throw new Error('请使用 npm run tauri:dev 启动桌面应用，浏览器模式下不执行 Rust 图像命令。')
    }

    return invoke<ProcessResponse>('process_tool', { request })
}

function assertTauriRuntime(featureName: string) {
    if (!isTauriRuntime()) {
        throw new Error(`请使用 npm run tauri:dev 启动桌面应用，浏览器模式下不执行${featureName}。`)
    }
}

export async function loadDictionaryDashboard() {
    assertTauriRuntime('离线词典命令')
    return invoke<DictionaryDashboard>('dictionary_dashboard')
}

export async function queryTranslation(request: TranslationQueryRequest) {
    assertTauriRuntime('离线词典命令')
    return invoke<TranslationResult>('query_translation', { request })
}

export async function addFavorite(payload: FavoritePayload) {
    assertTauriRuntime('离线词典命令')
    return invoke<FavoriteEntry>('dictionary_add_favorite', { payload })
}

export async function removeFavorite(id: number) {
    assertTauriRuntime('离线词典命令')
    return invoke<boolean>('dictionary_remove_favorite', { id })
}

export async function listHistory(limit?: number) {
    assertTauriRuntime('离线词典命令')
    return invoke<HistoryEntry[]>('dictionary_history', { limit })
}

export async function updateDictionarySettings(settings: DictionarySettings) {
    assertTauriRuntime('离线词典命令')
    return invoke<DictionarySettings>('dictionary_update_settings', { settings })
}

export async function getDictionaryMetadata() {
    assertTauriRuntime('离线词典命令')
    return invoke<DictionaryMetadata>('dictionary_metadata')
}