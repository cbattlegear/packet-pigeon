import { useEffect, useRef } from 'react'
import { readQrPixels } from './qrImage.ts'

export function CameraScanner({ found, failed, cancel }: {
  found: (text: string) => void; failed: (message: string) => void; cancel: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const callbacks = useRef({ found, failed })
  useEffect(() => { callbacks.current = { found, failed } }, [found, failed])
  useEffect(() => {
    let closed = false
    let stream: MediaStream | undefined
    let timer: number | undefined
    const preview = video.current

    async function start() {
      try {
        if (!preview || !navigator.mediaDevices?.getUserMedia) {
          callbacks.current.failed('Camera scanning is unavailable. Use a QR image or paste the link.')
          return
        }
        const { default: jsQR } = await import('jsqr')
        if (closed) return
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (closed) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        stream = media
        preview.srcObject = stream
        await preview.play()
        if (closed) return
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Camera preview is unavailable.')
        timer = window.setInterval(() => {
          if (!preview.videoWidth) return
          try {
            const image = readQrPixels(context, preview, preview.videoWidth, preview.videoHeight)
            const text = jsQR(image.data, image.width, image.height)?.data
            if (text) {
              window.clearInterval(timer)
              callbacks.current.found(text)
            }
          } catch {
            window.clearInterval(timer)
            callbacks.current.failed('Camera scanning failed. Use a QR image or paste the link.')
          }
        }, 200)
      } catch {
        if (!closed) callbacks.current.failed('Camera access failed. Check browser permissions or use a QR image.')
      }
    }

    void start()
    return () => {
      closed = true
      window.clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
      if (preview) preview.srcObject = null
    }
  }, [])

  return <div className="share-camera">
    <video ref={video} muted playsInline aria-label="QR camera preview" />
    <button type="button" onClick={cancel}>Stop camera</button>
  </div>
}
