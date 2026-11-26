import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { browserRepeaterCredentialVault, repeaterCredentialKey } from '../radio/repeater-credentials.ts'

type Props = {
  radioKey: string
  contactKey: string
  disabled: boolean
  onUnlock: (passphrase: string) => void
}

function readStatus(radioKey: string, contactKey: string) {
  try { return { saved: browserRepeaterCredentialVault().has(radioKey, contactKey), error: '' } }
  catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : 'Encrypted password storage is unavailable.' }
  }
}

export function RepeaterCredentialStorage({ radioKey, contactKey, disabled, onUnlock }: Props) {
  const [status, setStatus] = useState(() => readStatus(radioKey, contactKey))
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const password = useRef<HTMLInputElement>(null)
  const passphrase = useRef<HTMLInputElement>(null)
  const confirmation = useRef<HTMLInputElement>(null)
  const unlockPassphrase = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    const key = repeaterCredentialKey(radioKey, contactKey)
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setStatus(readStatus(radioKey, contactKey))
    }
    window.addEventListener('storage', changed)
    return () => {
      window.removeEventListener('storage', changed)
      request.current?.abort(new Error('Stopped saving the encrypted password.'))
    }
  }, [radioKey, contactKey])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || pending) return
    let vault: ReturnType<typeof browserRepeaterCredentialVault>
    let expected: string | null
    try {
      vault = browserRepeaterCredentialVault()
      expected = vault.snapshot(radioKey, contactKey)
    } catch (error) {
      setStatus((current) => ({ ...current, error: error instanceof Error ? error.message : 'Encrypted password storage is unavailable.' }))
      return
    }
    if (expected !== null && !window.confirm('Replace the encrypted password saved for this radio and repeater?')) return
    const value = password.current?.value ?? ''
    const phrase = passphrase.current?.value ?? ''
    const repeat = confirmation.current?.value ?? ''
    if (password.current) password.current.value = ''
    if (passphrase.current) passphrase.current.value = ''
    if (confirmation.current) confirmation.current.value = ''
    setNotice('')
    if (phrase !== repeat) {
      setStatus((current) => ({ ...current, error: 'The passphrases do not match. Enter them again.' }))
      return
    }
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    try {
      await vault.save(radioKey, contactKey, value, phrase, expected, controller.signal)
      if (!controller.signal.aborted) {
        setStatus({ saved: true, error: '' })
        setNotice('Encrypted password saved. It has not been checked by the repeater.')
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus((current) => ({
        ...current, error: error instanceof Error ? error.message : 'Could not save the encrypted password.',
      }))
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
    }
  }

  async function forget() {
    if (disabled || pending) return
    let vault: ReturnType<typeof browserRepeaterCredentialVault>
    let expected: string | null
    try {
      vault = browserRepeaterCredentialVault()
      expected = vault.snapshot(radioKey, contactKey)
    } catch (error) {
      setStatus((current) => ({ ...current, error: error instanceof Error ? error.message : 'Encrypted password storage is unavailable.' }))
      return
    }
    if (expected === null) {
      setStatus({ saved: false, error: '' })
      setNotice('No encrypted password is saved for this radio and repeater.')
      return
    }
    if (!window.confirm('Delete the encrypted password for this radio and repeater? This does not revoke access.')) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setNotice('')
    try {
      await vault.forget(radioKey, contactKey, expected, controller.signal)
      if (!controller.signal.aborted) {
        setStatus({ saved: false, error: '' })
        setNotice('Encrypted password deleted from this browser.')
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus((current) => ({
        ...current, error: error instanceof Error ? error.message : 'Could not delete the encrypted password.',
      }))
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
    }
  }

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || pending) return
    const phrase = unlockPassphrase.current?.value ?? ''
    if (unlockPassphrase.current) unlockPassphrase.current.value = ''
    onUnlock(phrase)
  }

  return <details>
    <summary>Encrypted password in this browser</summary>
    <p>Optional: save a password encrypted for this radio and repeater. Saving does not log in or check the password.
      Unlocking and logging in sends a new request; nothing is automatic.</p>
    <p>Use a long, unique, random passphrase different from the repeater password. Anyone with the encrypted data can try to guess it offline;
      the radio and repeater public keys and approximate password length remain visible.
      If you lose the passphrase, this app cannot recover the password. Page scripts, browser extensions or malware
      with access to the page can read secrets while they are entered or used. Clearing site data removes the saved
      password, though an in-progress save could write it again. Deletion does not clear a tab-only remembered password,
      revoke repeater access, cancel an already started login, or erase browser backups.</p>
    <form className="contact-actions" onSubmit={(event) => void save(event)}>
      <label>Password to encrypt
        <input ref={password} type="password" autoComplete="off" required disabled={disabled || pending} />
      </label>
      <label>New encryption passphrase (12 or more characters)
        <input ref={passphrase} type="password" autoComplete="off" required disabled={disabled || pending} />
      </label>
      <label>Confirm encryption passphrase
        <input ref={confirmation} type="password" autoComplete="off" required disabled={disabled || pending} />
      </label>
      <button type="submit" disabled={disabled || pending}>Save encrypted password</button>
    </form>
    {status.saved && <form className="contact-actions" onSubmit={unlock}>
      <label>Encryption passphrase
        <input ref={unlockPassphrase} type="password" autoComplete="off" required disabled={disabled || pending} />
      </label>
      <button type="submit" disabled={disabled || pending}>Unlock and log in</button>
      <button type="button" disabled={disabled || pending} onClick={() => void forget()}>Delete encrypted password</button>
    </form>}
    {pending && <p role="status">Updating encrypted password…</p>}
    {notice && <p role="status">{notice}</p>}
    {status.error && <p role="alert">{status.error}</p>}
  </details>
}
