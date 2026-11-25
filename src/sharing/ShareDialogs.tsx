import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/companion-session.ts'
import { parseMeshCoreShare } from './meshcoreLinks.ts'
import type { MeshCoreShare } from './meshcoreLinks.ts'
import { parseCompanionSetup } from './setupLink.ts'
import type { SetupShare } from './setupLink.ts'
import { importSharedChannel } from './importChannel.ts'
import { SetupPreview } from './SetupPreview.tsx'
import { CameraScanner } from './qrScanner.tsx'
import { decodeQrImage } from './qrImage.ts'
import './sharing.css'

export function ShareModal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const modal = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    modal.current?.showModal()
  }, [])

  return <dialog ref={modal} aria-labelledby={heading} className="share-dialog" onClose={close}>
    <h2 id={heading}>{title}</h2>
    {children}
    <button type="button" onClick={() => modal.current?.close()}>Close</button>
  </dialog>
}

export function ShareCode({ link, privateChannel, close }: { link: string; privateChannel?: boolean; close: () => void }) {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(link, { width: 288 })).then(
      (data) => { if (current) setCode(data) },
      () => { if (current) setError('The QR code could not be generated. You can still copy the link.') },
    )
    return () => { current = false }
  }, [link])

  async function copy() {
    setError('')
    try {
      await navigator.clipboard.writeText(link)
      setStatus('Link copied.')
    } catch {
      setError('Clipboard access failed. Select and copy the link from the text field.')
    }
  }

  return <ShareModal title="Share MeshCore link" close={close}>
    {privateChannel && <p>Anyone who gets this link or scans this QR code can join the channel.</p>}
    {code && <img src={code} alt="MeshCore share QR code" width="288" height="288" />}
    <label>Share link
      <input type="text" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
    </label>
    <div className="share-actions">
      <button type="button" onClick={() => void copy()}>Copy link</button>
      {code && <a href={code} download="meshcore-share.png">Download QR code</a>}
    </div>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </ShareModal>
}
export function ImportShare({ snapshot, session, close }: {
  snapshot: CompanionSnapshot; session: CompanionSession; close: () => void
}) {
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<MeshCoreShare | SetupShare | null>(null)
  const [scanning, setScanning] = useState(false)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [unscoped, setUnscoped] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const radio = snapshot.phase === 'ready' ? snapshot.device : null

  function review(text: string) {
    setSource('')
    setPreview(null)
    setUnscoped(false)
    setError('')
    setMessage('')
    try {
      setPreview(parseCompanionSetup(text) ?? parseMeshCoreShare(text))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The link could not be read.')
    }
  }

  async function read(readText: () => Promise<string>, failure: string) {
    setReading(true)
    setError('')
    try {
      review(await readText())
    } catch {
      setError(failure)
    } finally {
      setReading(false)
    }
  }

  async function apply() {
    if (!preview || preview.kind === 'setup' || !radio || saving) return
    setSaving(true)
    setError('')
    try {
      if (preview.kind === 'contact') {
        await session.addContact(radio.publicKey, preview)
      } else {
        if (preview.regionScope && !unscoped) return
        await importSharedChannel(session, radio.publicKey, preview)
      }
      setMessage(`${preview.kind === 'contact' ? 'Contact' : 'Channel'} added to ${radio.name || 'the connected radio'}.`)
      setPreview(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The radio rejected the import.')
    } finally {
      setSaving(false)
    }
  }

  return <ShareModal title="Import MeshCore share" close={close}>
    {preview?.kind !== 'setup' && <form onSubmit={(event) => { event.preventDefault(); review(source) }}>
      <label>MeshCore link
        <input type="password" value={source} onChange={(event) => setSource(event.currentTarget.value)}
          autoComplete="off" maxLength={32768} disabled={saving || reading || scanning} />
      </label>
      <div className="share-actions">
        <button disabled={!source.trim() || saving || reading || scanning}>Review link</button>
        <button type="button" disabled={saving || reading || scanning}
          onClick={() => void read(() => navigator.clipboard.readText(), 'Clipboard access failed. Paste the link into the field instead.')}>
          Read clipboard
        </button>
        <button type="button" disabled={saving || reading || scanning}
          onClick={() => { setError(''); setScanning(true) }}>Scan with camera</button>
      </div>
      <label>Read QR image
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={saving || reading || scanning}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void read(() => decodeQrImage(file), 'Could not read a QR code from this image.')
          }} />
      </label>
    </form>}
    {scanning && <CameraScanner found={(text) => { setScanning(false); review(text) }}
      failed={(text) => { setScanning(false); setError(text) }} cancel={() => setScanning(false)} />}
    {preview?.kind === 'setup' && <SetupPreview setup={preview} snapshot={snapshot} session={session} discard={() => setPreview(null)} />}
    {preview && preview.kind !== 'setup' && <div className="share-preview">
      <h3>{preview.kind === 'contact' ? 'Contact' : 'Channel'} {preview.name}</h3>
      {preview.kind === 'contact' && <p><code>{preview.publicKey}</code></p>}
      {preview.kind === 'channel' && preview.regionScope && <label className="share-checkbox">
        <input type="checkbox" checked={unscoped} disabled={saving} onChange={(event) => setUnscoped(event.currentTarget.checked)} />
        Join without the provided region scope ({preview.regionScope}). Configure the sending scope in Channels before sending.
      </label>}
      {radio ? <p>Apply to {radio.name || 'the connected radio'}.</p> : <p>Connect and sync a radio to apply this link.</p>}
      <div className="share-actions">
        <button type="button" disabled={!radio || saving || reading || scanning || (preview.kind === 'channel' && !!preview.regionScope && !unscoped)}
          onClick={() => void apply()}>{saving ? 'Applying…' : `Add ${preview.kind}`}</button>
        <button type="button" disabled={saving} onClick={() => { setPreview(null); setError('') }}>Discard preview</button>
      </div>
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </ShareModal>
}
