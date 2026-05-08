export type ToolId =
    | 'base64Encode'
    | 'base64Decode'
    | 'enhance'
    | 'compress'
    | 'watermark'
    | 'crop'
    | 'split'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

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
    }
    | {
        kind: 'split'
        sourceDataUrl: string
        rows: number
        cols: number
    }