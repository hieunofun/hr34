export const createAttendanceImportWorker = () => {
  const worker = new Worker(new URL('../workers/attendanceImport.worker.js', import.meta.url), { type: 'module' })
  let nextId = 0
  const pending = new Map()
  const rejectAll = error => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (data.error) request.reject(new Error(data.error))
    else request.resolve(data.result)
  }
  worker.onerror = event => rejectAll(new Error(event.message || 'Không đọc được file chấm công.'))
  worker.onmessageerror = () => rejectAll(new Error('Không nhận được kết quả đọc file chấm công.'))
  return {
    request: (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try {
        worker.postMessage({ id, type, ...payload }, transfer)
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    }),
    terminate: () => {
      worker.terminate()
      rejectAll(new DOMException('Đã hủy đọc file.', 'AbortError'))
    }
  }
}
