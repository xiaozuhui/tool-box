export type ToolId =
    | 'base64Encode'
    | 'base64Decode'
    | 'enhance'
    | 'compress'
    | 'watermark'
    | 'crop'
    | 'split'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export type CropMode = 'rectangle' | 'ellipse' | 'polygon' | 'smoothPath'

export interface CropPoint {
    x: number
    y: number
}

export type WatermarkPosition =
    | 'topLeft'
    | 'topCenter'
    | 'topRight'
    | 'centerLeft'
    | 'center'
    | 'centerRight'
    | 'bottomLeft'
    | 'bottomCenter'
    | 'bottomRight'

export interface ImageAsset {
    name: string
    dataUrl: string
    width: number
    height: number
    size: number
    mimeType: string
}

export interface SplitItem {
    name: string
    dataUrl: string
    width: number
    height: number
}

export interface ProcessResponse {
    primaryDataUrl: string | null
    primaryText: string | null
    width: number | null
    height: number | null
    bytes: number
    mimeType: string | null
    notes: string[]
    splitItems: SplitItem[]
}

export type WorkspaceMode = 'image' | 'translate'

export type QueryDirection = 'auto' | 'zhToEn' | 'enToZh'

export type ResolvedDirection = 'zhToEn' | 'enToZh'

export interface DictionaryMetadata {
    version: string
    entryCount: number
    phraseCount: number
    languagePairs: string[]
    features: string[]
    sourceLabel: string
    generatedAt: string | null
    packageCount: number
}

export interface FavoriteEntry {
    id: number
    query: string
    direction: ResolvedDirection
    translation: string
    createdAt: string
}

export interface HistoryEntry {
    id: number
    query: string
    normalizedQuery: string
    direction: ResolvedDirection
    resultCount: number
    createdAt: string
}

export interface DictionarySettings {
    defaultDirection: QueryDirection
    autoCopyPrimary: boolean
    compactResultView: boolean
    maxHistoryItems: number
}

export interface DictionaryVariantSummary {
    id: number
    definition: string
    partOfSpeech: string | null
    examples: string[]
    score: number
}

export interface DictionaryEntrySummary {
    id: number
    term: string
    normalizedTerm: string
    sourceLanguage: 'zh' | 'en'
    targetLanguage: 'zh' | 'en'
    pronunciation: string | null
    phonetic: string | null
    tags: string[]
    aliases: string[]
    isPhrase: boolean
    score: number
    primaryTranslation: string
    variants: DictionaryVariantSummary[]
    matchedBy: string
    matchReason: string
}

export interface TranslationResult {
    query: string
    normalizedQuery: string
    direction: ResolvedDirection
    detectedSourceLanguage: 'zh' | 'en'
    phraseHits: DictionaryEntrySummary[]
    exactHits: DictionaryEntrySummary[]
    fuzzyHits: DictionaryEntrySummary[]
    suggestions: string[]
    totalHits: number
    notes: string[]
}

export interface TranslationQueryRequest {
    query: string
    direction: QueryDirection
    limit?: number
}

export interface FavoritePayload {
    query: string
    direction: ResolvedDirection
    translation: string
}

export interface DictionaryDashboard {
    metadata: DictionaryMetadata
    settings: DictionarySettings
    favorites: FavoriteEntry[]
    history: HistoryEntry[]
}

export type ToolRequest =
    | {
        kind: 'base64Encode'
        sourceDataUrl: string
        outputFormat: ImageFormat
    }
    | {
        kind: 'base64Decode'
        base64Input: string
        outputFormat: ImageFormat | null
    }
    | {
        kind: 'enhance'
        sourceDataUrl: string
        contrast: number
        brighten: number
        sharpen: number
        saturation: number
    }
    | {
        kind: 'compress'
        sourceDataUrl: string
        outputFormat: ImageFormat
        quality: number
        maxWidth: number | null
    }
    | {
        kind: 'watermark'
        sourceDataUrl: string
        overlayDataUrl: string
        position: WatermarkPosition
        opacity: number
        scalePercent: number
        margin: number
    }
    | {
        kind: 'crop'
        sourceDataUrl: string
        x: number
        y: number
        width: number
        height: number
        mode: CropMode
        points: CropPoint[]
    }
    | {
        kind: 'split'
        sourceDataUrl: string
        rows: number
        cols: number
    }