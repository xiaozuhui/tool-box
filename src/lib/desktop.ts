import { invoke } from '@tauri-apps/api/core'
import type { ProcessResponse, ToolRequest } from '../types'

function isTauriRuntime() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function runTool(request: ToolRequest) {
    if (!isTauriRuntime()) {
        throw new Error('请使用 npm run tauri:dev 启动桌面应用，浏览器模式下不执行 Rust 图像命令。')
    }

    return invoke<ProcessResponse>('process_tool', { request })
}