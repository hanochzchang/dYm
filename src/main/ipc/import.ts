import { dialog, ipcMain } from 'electron'
import { importLocalMedia, type LocalImportInput } from '../services/import/local-import'

export function registerImportIpc(): void {
  ipcMain.handle('import:pick', async (_event, kind: 'video' | 'images') => {
    const isGallery = kind === 'images'
    const result = await dialog.showOpenDialog({
      title: isGallery ? '选择图片（多选会组成一个图集）' : '选择视频',
      properties: isGallery ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: isGallery
        ? [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
        : [{ name: '视频', extensions: ['mp4', 'mov', 'avi'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('import:start', (_event, input: LocalImportInput) => importLocalMedia(input))
}
