export function readQrPixels(context: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, 1024 / Math.max(width, height))
  const canvas = context.canvas
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

export async function decodeQrImage(file: File) {
  if (file.size > 12 * 1024 * 1024) throw new Error('Image is too large.')
  const { default: jsQR } = await import('jsqr')
  const bitmap = await createImageBitmap(file)
  try {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) throw new Error('Could not read image.')
    const image = readQrPixels(context, bitmap, bitmap.width, bitmap.height)
    const text = jsQR(image.data, image.width, image.height)?.data
    if (!text) throw new Error('No QR code found.')
    return text
  } finally {
    bitmap.close()
  }
}
