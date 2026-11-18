import { ipcMain } from 'electron'
import { importXiaohongshu } from '../services/xiaohongshu/import'

export function registerXiaohongshuIpc(): void {
  ipcMain.handle('xiaohongshu:import', (_event, raw: string) => importXiaohongshu(raw))
}
