import { createAttendanceImportWorkerHandler } from '../utils/attendanceImportWorkerHandler.js'

const handle = createAttendanceImportWorkerHandler()
self.onmessage = ({ data: request }) => {
  try {
    self.postMessage({ id: request.id, result: handle(request) })
  } catch (error) {
    self.postMessage({ id: request.id, error: error.message || String(error) })
  }
}
