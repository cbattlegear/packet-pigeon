import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { MessageSync } from '../integration/message-sync.ts'
import type { CompanionSession } from '../radio/companion-session.ts'
import {
  compareRepeaterPublicKey, parseRepeaterNeighbors, repeaterCliCommand, repeaterCliCommands, repeaterNameCommand, repeaterOwnerInfoCommand,
  repeaterPositionCommand, repeaterRegionQuery, repeaterHomeRegionCommand, repeaterRegionFloodCommand, repeaterRegionPutCommand,
  repeaterRegionRemoveCommand,
  repeaterGuestPasswordCommand, repeaterRemoveAccessCommand, repeaterGrantAdminCommand, repeaterGrantAdminWarning,
  repeaterLimitedAccessCommand, repeaterLimitedAccessWarning, repeaterRemoveNeighborCommand, repeaterRemoveNeighborWarning,
  repeaterTransmitPowerCommand, repeaterAdcMultiplierSafety, repeaterAdcMultiplierCaveats, repeaterAdcMultiplierWarning,
  repeaterRadioSettingsSafety, repeaterRadioSettingsCaveats, repeaterRadioSettingsWarning, repeaterTempRadioWarning,
  repeaterClockCommand, repeaterClockWarning, repeaterBridgeDelayWarning, repeaterBridgeChannelWarning, repeaterBridgeBaudWarning, isRepeaterRebootCommand,
  UncertainRepeaterCliError,
} from '../radio/repeater-cli.ts'
import type { RepeaterCliReceipt } from '../radio/repeater-cli.ts'
import { mapPosition } from '../map/nodes.ts'
import { resolvePath } from '../paths/model.ts'
import type { MapPath, PathNode } from '../paths/model.ts'
import type { Coordinates } from '../map/nodes.ts'

export type RepeaterMessageSync = Pick<MessageSync, 'subscribe' | 'getSnapshot' | 'subscribeToSavedReceipts' | 'sync'>

type Props = {
  session: Pick<CompanionSession, 'sendRepeaterCommand'>
  messageSync: RepeaterMessageSync
  radioKey: string
  contactKey: string
  name: string
  route: { pathLength: number; pathHex: string }
  ready: boolean
  busy: boolean
  onPending: (pending: boolean) => void
  onAccessChange: () => void
  onNeighborChange: () => void
  onStatsReset: () => void
  onBatteryCalibration: () => void
  onReboot: (notice: string) => void
  neighborNodes: readonly PathNode[]
  repeaterPosition: Coordinates | null
  onMap?: (path: MapPath) => void
}

type HistoryEntry = {
  command: string
  description: string
  tag: string
  route: RepeaterCliReceipt['route'] | null
  deadline: number
  reply: { text: string; syncedAt: number } | null
  unconfirmed: boolean
}

const neighborTiming = 'Ages are seconds since heard when the repeater generated the reply; the reply may have been delayed before syncing.'
const bootloaderDiagnosticHelp = 'This is not the repeater firmware version or proof that a bootloader works or is update-compatible. ' +
  'In v1.14.1, nRF52 firmware looks for a UF2 marker; unknown does not prove a bootloader is missing, and other platforms report unsupported. ' +
  'Firmware and hardware support vary; replies may be delayed or misattributed.'
const receiveDelayWarning = 'This experimental setting can affect flood processing, routing and remote access. ' +
  'It is a base, not milliseconds. In repeater firmware v1.14.1, the delay depends on packet score and estimated airtime; direct packets are not deferred by this mechanism. ' +
  'Already queued floods retain their scheduled time. ' +
  'Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. ' +
  'An OK reply or matching read-back does not prove persistence or actual timing. Other firmware may behave differently.'
const agcResetWarning = 'Zero disables scheduled resets. Radio and firmware support varies; a scheduled reset may do nothing. ' +
  'In repeater firmware v1.14.1, the timer restarts after a send completes or times out. RadioLib skips a reset during packet reception or when a packet is pending, then schedules the next attempt. An applied reset briefly interrupts reception and restarts noise-floor sampling. An existing timer can carry over after a change. ' +
  'Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. ' +
  'An OK reply or matching read-back does not prove a reset occurred or the preference was saved.'
const interferenceWarning = 'Changing this can affect collisions, transmission delays and remote access. ' +
  'In repeater v1.14.1 RadioLib, zero disables the extra noise-floor-based interference check, not the packet-reception busy check. A nonzero value is a dB offset above the sampled noise floor, compared with current signal strength; a low value can delay sends, while a high value can miss interference. The noise floor can be inaccurate. ' +
  'Changes reach the radio check periodically, not necessarily immediately. After about four seconds of busy detection, v1.14.1 may transmit anyway. Radio and firmware support varies. ' +
  'Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove detection worked or the preference was saved.'

function powerDiagnosticHelp(command: string): string | undefined {
  switch (command) {
    case 'get pwrmgt.support':
      return 'In v1.14.1, supported indicates a firmware build flag, not proof that every power-management feature is configured.'
    case 'get pwrmgt.source':
      return 'In v1.14.1, the reported source reflects USB VBUS detection, not charging state.'
    case 'get pwrmgt.bootreason':
      return 'Reset and shutdown reasons may be incomplete; unknown does not necessarily mean a failure.'
    case 'get pwrmgt.bootmv':
      return 'This is a boot-time reading, not the current battery voltage. In v1.14.1, zero can mean no reading was recorded.'
  }
}

function bridgeDiagnosticHelp(command: string): string | undefined {
  switch (command) {
    case 'get bridge.type':
      return 'In v1.14.1 this reports the compiled bridge type, not whether a bridge is enabled or working.'
    case 'get bridge.enabled':
      return 'This reports a preference, not whether bridge hardware is connected or forwarding.'
    case 'get bridge.delay':
      return 'In v1.14.1 this reports the delay preference in milliseconds, not measured forwarding latency.'
    case 'get bridge.source':
      return 'In v1.14.1 logRx and logTx select received or transmitted packets, not proof that packets are bridged.'
    case 'get bridge.baud':
      return 'This reports the RS-232 baud preference, not whether an interface or peer is working.'
    case 'get bridge.channel':
      return 'This reports the ESP-NOW channel preference, not whether a peer is connected.'
  }
}

const managementForms = {
  regions: { title: 'Inspect repeater regions', terms: 'region get region home region put region remove region allowf region denyf region save region list region default' },
  removeNeighbor: { title: 'Remove a cached neighbor', terms: 'neighbor.remove neighbors' },
  floodLimit: { title: 'Change flood hop limits', terms: 'set flood.max set flood.max.unscoped set flood.max.advert get flood.max get flood.max.unscoped get flood.max.advert' },
  loopDetection: { title: 'Change flood loop detection', terms: 'set loop.detect get loop.detect' },
  pathHash: { title: 'Change advert path hash size', terms: 'set path.hash.mode get path.hash.mode' },
  airtime: { title: 'Change airtime factor', terms: 'set af get af' },
  retransmission: { title: 'Change retransmission delays', terms: 'set txdelay set direct.txdelay get txdelay get direct.txdelay' },
  receiveDelay: { title: 'Change receive-delay base', terms: 'set rxdelay get rxdelay' },
  transmitPower: { title: 'Change repeater transmit power', terms: 'set tx get tx' },
  radioSettings: { title: 'Change repeater radio parameters', terms: 'set radio get radio frequency bandwidth spreading factor coding rate' },
  tempRadio: { title: 'Set temporary radio override', terms: 'tempradio temporary frequency bandwidth spreading factor coding rate' },
  batteryCalibration: { title: 'Calibrate battery voltage', terms: 'get adc.multiplier set adc.multiplier battery voltage' },
  receiverGain: { title: 'Change receiver boosted-gain preference', terms: 'set radio.rxgain get radio.rxgain' },
  agc: { title: 'Change AGC reset interval', terms: 'set agc.reset.interval get agc.reset.interval' },
  interference: { title: 'Change interference threshold', terms: 'set int.thresh get int.thresh' },
  multiAck: { title: 'Change extra direct ACK preference', terms: 'set multi.acks get multi.acks' },
  powerSaving: { title: 'Change repeater power-saving preference', terms: 'powersaving' },
  packetLog: { title: 'Manage repeater packet log', terms: 'log start stop erase logging packet diagnostics' },
  bridge: { title: 'Manage repeater bridge', terms: 'get bridge.type get bridge.enabled set bridge.enabled on off get bridge.source set bridge.source rx tx logRx logTx get bridge.delay set bridge.delay' },
  bridgeChannel: { title: 'Change ESP-NOW bridge channel', terms: 'get bridge.channel set bridge.channel wifi wireless peer' },
  bridgeBaud: { title: 'Change RS-232 bridge baud rate', terms: 'get bridge.baud set bridge.baud serial uart peer' },
  advertInterval: { title: 'Change advertisement interval', terms: 'set advert.interval set flood.advert.interval' },
  removeAccess: { title: 'Remove repeater access-list entry', terms: 'setperm acl permissions' },
  limitedAccess: { title: 'Set non-admin repeater client role', terms: 'setperm acl permissions read-only read-write' },
  adminAccess: { title: 'Grant repeater administrator access', terms: 'setperm acl permissions' },
  guestPassword: { title: 'Change guest login password', terms: 'set guest.password' },
  name: { title: 'Change repeater name', terms: 'set name get name' },
  owner: { title: 'Change owner information', terms: 'set owner.info' },
  clock: { title: 'Set repeater clock in UTC', terms: 'time clock utc' },
  gps: { title: 'Manage GPS receiver', terms: 'gps on gps off gps sync clock sensor get gps activity' },
  position: { title: 'Change stored position', terms: 'set lat set lon gps setloc gps advert location' },
} as const

export function RepeaterCli({ session, messageSync, radioKey, contactKey, name, route, ready, busy, onPending, onAccessChange, onNeighborChange, onStatsReset, onBatteryCalibration, onReboot,
  neighborNodes, repeaterPosition, onMap }: Props) {
  const ownerInfoId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [intervalKind, setIntervalKind] = useState<'advert.interval' | 'flood.advert.interval'>('advert.interval')
  const [interval, setInterval] = useState('')
  const [floodLimitKind, setFloodLimitKind] = useState<'flood.max' | 'flood.max.unscoped' | 'flood.max.advert'>('flood.max')
  const [floodLimit, setFloodLimit] = useState('')
  const [retransmitKind, setRetransmitKind] = useState<'txdelay' | 'direct.txdelay'>('txdelay')
  const [retransmitDelay, setRetransmitDelay] = useState('')
  const [receiveDelay, setReceiveDelay] = useState('')
  const [agcResetInterval, setAgcResetInterval] = useState('')
  const [interferenceThreshold, setInterferenceThreshold] = useState('')
  const [bridgeDelay, setBridgeDelay] = useState('')
  const [bridgeChannel, setBridgeChannel] = useState('')
  const [bridgeBaud, setBridgeBaud] = useState('')
  const [airtimeFactor, setAirtimeFactor] = useState('')
  const [transmitPower, setTransmitPower] = useState('')
  const [radioFrequency, setRadioFrequency] = useState('')
  const [radioBandwidth, setRadioBandwidth] = useState('')
  const [radioSpreadingFactor, setRadioSpreadingFactor] = useState('')
  const [radioCodingRate, setRadioCodingRate] = useState('')
  const [tempFrequency, setTempFrequency] = useState('')
  const [tempBandwidth, setTempBandwidth] = useState('')
  const [tempSpreadingFactor, setTempSpreadingFactor] = useState('')
  const [tempCodingRate, setTempCodingRate] = useState('')
  const [tempDuration, setTempDuration] = useState('')
  const [adcMultiplier, setAdcMultiplier] = useState('')
  const [loopDetection, setLoopDetection] = useState('')
  const [pathHashMode, setPathHashMode] = useState('')
  const [regionName, setRegionName] = useState('')
  const [homeRegion, setHomeRegion] = useState('')
  const [ownerInfo, setOwnerInfo] = useState('')
  const [clockTime, setClockTime] = useState('')
  const [repeaterName, setRepeaterName] = useState('')
  const [guestPassword, setGuestPassword] = useState('')
  const [neighborKey, setNeighborKey] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [adminAccessKey, setAdminAccessKey] = useState('')
  const [limitedAccessKey, setLimitedAccessKey] = useState('')
  const [limitedRole, setLimitedRole] = useState<'' | 'read-only' | 'read-write'>('')
  const [advertPolicy, setAdvertPolicy] = useState('')
  const powerSavingCommands = repeaterCliCommands.filter((item) =>
    item.command === 'powersaving on' || item.command === 'powersaving off')
  const packetLogCommands = repeaterCliCommands.filter((item) =>
    item.command === 'log start' || item.command === 'log stop' || item.command === 'log erase')
  const bridgeCommands = repeaterCliCommands.filter((item) =>
    item.command === 'set bridge.enabled on' || item.command === 'set bridge.enabled off')
  const bridgeSourceCommands = repeaterCliCommands.filter((item) =>
    item.command === 'set bridge.source rx' || item.command === 'set bridge.source tx')
  const receiverGainCommands = repeaterCliCommands.filter((item) =>
    item.command === 'set radio.rxgain on' || item.command === 'set radio.rxgain off')
  const gpsCommands = repeaterCliCommands.filter((item) => item.command === 'gps on' || item.command === 'gps off')
  const gpsClockSync = repeaterCliCommands.find((item) => item.command === 'gps sync')
  const gpsSetLocation = repeaterCliCommands.find((item) => item.command === 'gps setloc')
  const multiAckCommands = repeaterCliCommands.filter((item) =>
    item.command === 'set multi.acks 1' || item.command === 'set multi.acks 0')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState(false)
  const [syncRequested, setSyncRequested] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const panel = useRef<HTMLDetailsElement | null>(null)
  const syncStatus = useSyncExternalStore(messageSync.subscribe, messageSync.getSnapshot)
  const term = query.trim().toLowerCase()
  const choices = repeaterCliCommands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(term))
  const matchingForms = term ? Object.entries(managementForms).filter(([, form]) =>
    `${form.title} ${form.terms}`.toLowerCase().includes(term)) : []
  const matchingHistory = history.filter((item) =>
    `${item.command} ${item.description} ${item.reply?.text ?? ''}`.toLowerCase().includes(term))
  const action = repeaterCliCommands.find((item) => item.command === selected)
  const regionActions = repeaterCliCommands.filter((item) =>
    item.command === 'region allowf *' || item.command === 'region denyf *' || item.command === 'region save')

  useEffect(() => messageSync.subscribeToSavedReceipts((key, message) => {
    const receipt = message.receipt
    if (key !== radioKey || receipt?.kind !== 'direct-text' || receipt.textType !== 1 ||
      receipt.senderKeyPrefix !== contactKey.slice(0, 12) || receipt.text[2] !== '|') return
    const tag = receipt.text.slice(0, 2)
    const syncedAt = Date.now()
    setHistory((current) => current.map((item) => item.tag === tag && item.reply === null
      ? { ...item, reply: { text: receipt.text.slice(3).trimStart(), syncedAt } } : item))
  }), [messageSync, radioKey, contactKey])

  useEffect(() => {
    const next = history.reduce((earliest, item) =>
      item.reply === null && item.deadline > now ? Math.min(earliest, item.deadline) : earliest, Infinity)
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now()))
    return () => clearTimeout(timer)
  }, [history, now])

  useEffect(() => () => request.current?.abort(new Error('Stopped waiting for the radio.')), [])

  async function send(
    command: string, description: string, confirmed: boolean, warning = '', historyCommand = command,
    afterConfirmation?: () => void,
  ) {
    if (!ready || busy || pending || syncStatus.syncing) return
    const reboots = isRepeaterRebootCommand(command)
    const rebootLabel = command === 'clkreboot' ? 'Clock reset and reboot' : 'Reboot'
    const rebootAction = command === 'clkreboot' ? 'clock reset and reboot' : 'reboot'
    const rebootFollowup = command === 'clkreboot'
      ? 'No reply is expected on repeater v1.14.1. Log in again when the repeater is available; a delayed clock reset and reboot may still arrive. Read and set the clock separately using a trusted time.'
      : 'No reply is expected. Log in again when the repeater is available; a delayed reboot may still arrive.'
    const target = reboots || command.startsWith('log ') || command.startsWith('set bridge.enabled ') ||
      command.startsWith('set bridge.source ') || command.startsWith('set bridge.delay ') ||
      command.startsWith('set bridge.channel ') || command.startsWith('set bridge.baud ')
      ? `${name} (${contactKey.slice(0, 12)})` : name
    if (confirmed) {
      if (!window.confirm(`${description} on ${target}? This will transmit over the mesh.${warning ? ` ${warning}` : ''}`)) return
      afterConfirmation?.()
    }
    if (term && !`${command} ${description}`.toLowerCase().includes(term)) setQuery('')
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    onPending(true)
    setError('')
    try {
      const result = await session.sendRepeaterCommand(radioKey, contactKey, route, command, confirmed, controller.signal)
      if (command === 'clear stats') onStatsReset()
      if (command.startsWith('set adc.multiplier ')) onBatteryCalibration()
      if (reboots) {
        onReboot(`${rebootLabel} accepted by the radio (${result.route}), but execution is unverified. ${rebootFollowup}`)
        return
      }
      const sentAt = Date.now()
      setNow(sentAt)
      setHistory((current) => [...current.slice(-99), {
        command: historyCommand, description, tag: result.tag, route: result.route, deadline: sentAt + result.timeoutMs,
        reply: null, unconfirmed: false,
      }])
    } catch (reason) {
      if (reboots && reason instanceof UncertainRepeaterCliError) {
        onReboot(`The radio may have sent the ${rebootAction} but did not confirm it. ${rebootFollowup}`)
        return
      }
      if (reboots) {
        const detail = reason instanceof Error ? reason.message : 'The repeater command failed.'
        onReboot(`${rebootLabel} was not confirmed: ${detail} If sent, it may still arrive without a reply. Log in again when the repeater is available.`)
        return
      }
      if (reason instanceof UncertainRepeaterCliError) {
        if (command === 'clear stats') onStatsReset()
        if (command.startsWith('set adc.multiplier ')) onBatteryCalibration()
        const sentAt = Date.now()
        setNow(sentAt)
        setHistory((current) => [...current.slice(-99), {
          command: historyCommand, description, tag: reason.tag, route: null, deadline: sentAt + 120_000,
          reply: null, unconfirmed: true,
        }])
      }
      setError(reason instanceof Error ? reason.message : 'The repeater command failed.')
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
      onPending(false)
    }
  }

  function sendChoice(item: (typeof repeaterCliCommands)[number]) {
    void send(item.command, item.description, 'confirm' in item && item.confirm,
      'warning' in item ? item.warning : '')
  }

  function submitInterval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set ${intervalKind} ${interval}`)
      const unit = intervalKind === 'advert.interval' ? 'minutes' : 'hours'
      const description = interval === '0' ? `Disable ${intervalKind === 'advert.interval' ? 'local' : 'flood'} advertisements`
        : `${command.description} to ${interval} ${unit}`
      void send(command.command, description, true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid advertisement interval.')
    }
  }

  function submitOwnerInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterOwnerInfoCommand(ownerInfo)
      const description = ownerInfo ? 'Replace owner information' : 'Clear owner information'
      const preview = ownerInfo ? `\n\n${ownerInfo}` : ''
      void send(command.command, description, true,
        `This information can be requested over the mesh. Do not include passwords or private data.${preview}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid owner information.')
    }
  }

  function submitClock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterClockCommand(clockTime)
      const utc = new Date(Number(command.command.slice(5)) * 1000).toISOString().replace('.000Z', ' UTC')
      void send(command.command, `Set repeater clock to ${utc}`, true, repeaterClockWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid UTC time.')
    }
  }

  function submitFloodLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set ${floodLimitKind} ${floodLimit}`)
      void send(command.command, `${command.description} to ${floodLimit}`, true,
        'Lower limits can disrupt mesh routes and remote access. Zero stops forwarding matching floods. Other applicable limits can be more restrictive.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid flood hop limit.')
    }
  }

  function submitTransmitPower(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterTransmitPowerCommand(transmitPower)
      void send(command.command, `Set repeater transmit power to ${transmitPower} dBm`,
        'confirm' in command && command.confirm,
        'Firmware documents 1–22 dBm, but supported values vary by board. Check the device manual and local regulations; a power amplifier can increase output and excessive power may be illegal. Firmware saves the preference and attempts to apply it, but may report OK even if applying it fails. A matching get tx reply shows only the stored preference, not the applied or radiated RF power.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid repeater transmit power.')
    }
  }

  function submitRadioSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set radio ${radioFrequency},${radioBandwidth},${radioSpreadingFactor},${radioCodingRate}`)
      void send(command.command,
        `Set repeater radio preferences to ${radioFrequency} MHz, ${radioBandwidth} kHz, SF ${radioSpreadingFactor}, CR 4/${radioCodingRate}`,
        true, repeaterRadioSettingsWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid repeater radio preferences.')
    }
  }

  function submitTempRadio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`tempradio ${tempFrequency},${tempBandwidth},${tempSpreadingFactor},${tempCodingRate},${tempDuration}`)
      void send(command.command,
        `Set temporary radio override to ${tempFrequency} MHz, ${tempBandwidth} kHz, SF ${tempSpreadingFactor}, CR 4/${tempCodingRate} for ${tempDuration} minutes`,
        true, repeaterTempRadioWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid temporary radio override.')
    }
  }

  function submitRetransmitDelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set ${retransmitKind} ${retransmitDelay}`)
      void send(command.command, `${command.description} to ${retransmitDelay}`, true,
        'Changing retransmission delays can affect collisions, latency and remote access. Zero removes this random delay, not all other delays. Sync the reply and read the selected factor again.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid retransmission delay factor.')
    }
  }

  function submitReceiveDelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set rxdelay ${receiveDelay}`)
      void send(command.command, `${command.description} to ${receiveDelay}`, true, receiveDelayWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid receive-delay base.')
    }
  }

  function submitAdcMultiplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set adc.multiplier ${adcMultiplier}`)
      void send(command.command, `${command.description} to ${adcMultiplier}`, true, repeaterAdcMultiplierWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid battery ADC multiplier.')
    }
  }

  function submitAgcResetInterval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set agc.reset.interval ${agcResetInterval}`)
      void send(command.command, `${command.description} to ${agcResetInterval} seconds`, true, agcResetWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid AGC reset interval.')
    }
  }

  function submitInterferenceThreshold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set int.thresh ${interferenceThreshold}`)
      void send(command.command, `${command.description} to ${interferenceThreshold}`, true, interferenceWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid interference threshold.')
    }
  }

  function submitBridgeDelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set bridge.delay ${bridgeDelay}`)
      void send(command.command, `${command.description} to ${bridgeDelay} milliseconds`, true, repeaterBridgeDelayWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid bridge delay.')
    }
  }

  function submitBridgeChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set bridge.channel ${bridgeChannel}`)
      void send(command.command, `${command.description} to ${bridgeChannel}`, true, repeaterBridgeChannelWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid ESP-NOW bridge channel.')
    }
  }

  function submitBridgeBaud(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set bridge.baud ${bridgeBaud}`)
      void send(command.command, `${command.description} to ${bridgeBaud}`, true, repeaterBridgeBaudWarning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid RS-232 bridge baud rate.')
    }
  }

  function submitAirtimeFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set af ${airtimeFactor}`)
      void send(command.command, `${command.description} to ${airtimeFactor}`, true,
        'Lower factors permit more airtime and may violate local regulations; higher factors can delay traffic and remote access. The budget permits bursts and does not guarantee legal compliance. Check your jurisdiction and channel plan. Sync the reply and read the factor again.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid airtime factor.')
    }
  }

  function submitLoopDetection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set loop.detect ${loopDetection}`)
      const warning = loopDetection === 'off'
        ? 'This disables flood loop detection.'
        : 'This can drop flooded packets when this repeater ID/hash repeats in the route. Stricter modes drop at lower repetition counts and may reduce reachability. Requires repeater firmware v1.14 or later.'
      void send(command.command, command.description, true, warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Choose a supported loop detection mode.')
    }
  }

  function submitPathHashMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set path.hash.mode ${pathHashMode}`)
      const mode = Number(pathHashMode)
      const hashBytes = mode + 1
      const warning = mode === 0
        ? 'This uses one-byte hashes for this repeater\'s manual flood advertisements.'
        : `This uses ${hashBytes}-byte hashes for this repeater's manual flood advertisements. On repeater v1.14.0 scheduled flood advertisements still use one-byte hashes. Repeater firmware v1.13 or earlier drops packets with multi-byte path hashes, which can limit flood propagation. Confirm the mesh is sufficiently upgraded first.`
      void send(command.command, command.description, true, warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Choose a supported advert path hash size.')
    }
  }

  function submitRegionQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterRegionQuery(regionName)
      void send(command.command, command.description, false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid region name.')
    }
  }

  function submitHomeRegion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterHomeRegionCommand(homeRegion)
      void send(command.command, command.description, 'confirm' in command && command.confirm,
        'warning' in command ? command.warning : '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid home region.')
    }
  }

  function changeRegionFlood(allow: boolean) {
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      if (regionName === '*') throw new Error('Use the wildcard flood controls below for *.')
      const command = repeaterRegionFloodCommand(regionName, allow)
      void send(command.command, command.description, command.confirm, command.warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid region name.')
    }
  }

  function putRegion() {
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterRegionPutCommand(regionName)
      void send(command.command, command.description, command.confirm, command.warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid region name.')
    }
  }

  function removeRegion() {
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterRegionRemoveCommand(regionName)
      void send(command.command, command.description, command.confirm, command.warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid region name.')
    }
  }

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterNameCommand(repeaterName)
      void send(command.command, `Set repeater name to "${repeaterName}"`, true,
        'This changes the advertised name, not the public key. An advertisement is not sent automatically.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid repeater name.')
    }
  }

  function submitGuestPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterGuestPasswordCommand(guestPassword)
      const warning = 'This changes guest login access only, not the administrator password. Do not reuse the administrator password. ' +
        'Changing the guest password does not revoke already-authorized guest identities; they may still access the repeater. ' +
        'The firmware returns OK without echoing the new value; do not query get guest.password because firmware returns it in plaintext. ' +
        'Clearing is not offered because a blank guest password could allow unauthenticated guest access. ' +
        'Sync the reply to confirm the setting was accepted.'
      void send(command.command, command.description, true,
        warning,
        'set guest.password [redacted]', () => setGuestPassword(''))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid guest password.')
    }
  }

  function submitRemoveAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterRemoveAccessCommand(accessKey)
      if (command.accessTarget === radioKey || command.accessTarget === contactKey) {
        throw new Error('Cannot remove the connected radio or repeater from its access list.')
      }
      void send(command.command, `${command.description} for ${command.accessTarget}`, command.confirm, command.warning,
        command.command, () => { setAccessKey(''); onAccessChange() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid client public key.')
    }
  }

  function submitRemoveNeighbor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterRemoveNeighborCommand(neighborKey)
      void send(command.command, `${command.description} for ${command.neighborTarget}`,
        command.confirm, command.warning, command.command, () => { setNeighborKey(''); onNeighborChange() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid neighbor public key.')
    }
  }

  function submitGrantAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterGrantAdminCommand(adminAccessKey)
      if (command.accessTarget === radioKey || command.accessTarget === contactKey) {
        throw new Error('Cannot grant administrator access to the connected radio or repeater.')
      }
      void send(command.command, `${command.description} for ${command.accessTarget}`, command.confirm, command.warning,
        command.command, () => { setAdminAccessKey(''); onAccessChange() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid client public key.')
    }
  }

  function submitLimitedAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      if (!limitedRole) throw new Error('Choose a supported non-admin role.')
      const command = repeaterLimitedAccessCommand(limitedAccessKey, limitedRole)
      if (command.accessTarget === radioKey || command.accessTarget === contactKey) {
        throw new Error('Cannot change the connected radio or repeater access-list role.')
      }
      void send(command.command, `${command.description} for ${command.accessTarget}`, command.confirm, command.warning,
        command.command, () => { setLimitedAccessKey(''); onAccessChange() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid client public key.')
    }
  }

  function submitPosition(event: FormEvent<HTMLFormElement>, axis: 'lat' | 'lon', value: string) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterPositionCommand(axis, value)
      const coordinate = axis === 'lat' ? 'latitude' : 'longitude'
      void send(command.command, `Set stored ${coordinate} to ${value}`,
        true, 'Advertisements use stored coordinates only when the GPS advert policy is prefs.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid advertised position.')
    }
  }

  function submitAdvertPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    const command = repeaterCliCommands.find((item) => item.command === `gps advert ${advertPolicy}`)
    if (!command) {
      setError('Choose a supported GPS advert policy.')
      return
    }
    sendChoice(command)
  }

  return <details ref={panel}>
    <summary>Administrator CLI</summary>
    <p>Choose a supported query or confirmed management action. Commands are never retried automatically.
      Replies are saved with other messages when you sync; history here lasts while this repeater stays selected.</p>
    <p>Companion firmware v1.11 and earlier may cause CLI commands to be ignored. Upgrade the companion firmware if commands do not receive replies.</p>
    <p>Reply tags help match responses, but a delayed reply from an earlier browser session can still be mistaken for a new one.</p>
    <label>Search CLI commands, forms, and history
      <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
    </label>
    {choices.length > 0 ? <ul className="repeater-cli-choices" aria-label="Available CLI commands">
      {choices.map((item) => <li key={item.command}>
        <button type="button" aria-pressed={selected === item.command} disabled={!ready || busy || pending}
          onClick={() => setSelected(item.command)}><code>{item.command}</code> — {item.description}</button>
      </li>)}
    </ul> : <p>No command choices match.</p>}
    {matchingForms.length > 0 && <>
      <p>Matching management forms</p>
      <ul className="repeater-cli-choices" aria-label="Matching management forms">
        {matchingForms.map(([id, form]) => <li key={id}>
          <button type="button" onClick={() => {
            const section = panel.current?.querySelector<HTMLDetailsElement>(`details[data-cli-section="${id}"]`)
            if (section) {
              section.open = true
              section.querySelector('summary')?.focus()
            }
          }}>Open form: {form.title}</button>
        </li>)}
      </ul>
    </>}
    {selected === 'neighbors' && <p>Each reply line is a four-byte key prefix, seconds since heard, and SNR multiplied by 4, separated by colons.
      The list is limited by the repeater. Only unique matches with saved coordinates can be mapped; separate dots do not imply a route.</p>}
    {selected === 'get public.key' && <p>Compare the reported key with the saved contact; a match alone does not prove identity.
      Replies may be delayed or misattributed and firmware support varies.</p>}
    {selected === 'get role' && <p>This reads the node's firmware role, not the current user's access level. Firmware support varies.</p>}
    {selected === 'get bootloader.ver' && <p>{bootloaderDiagnosticHelp}</p>}
    {selected === 'get radio' && <p>In v1.14.1 this reports preferences, not active radio settings or proof of persistence.
      Frequency uses floating-point precision; bandwidth is rounded to three decimals. Replies can be delayed.</p>}
    {powerDiagnosticHelp(selected) && <p>{powerDiagnosticHelp(selected)} Firmware and hardware support vary; replies may be delayed.</p>}
    {bridgeDiagnosticHelp(selected) && <p>{bridgeDiagnosticHelp(selected)} Firmware and build support vary; replies may be delayed or unsupported.</p>}
    {selected === 'sensor get gps' && <p>This reads the reported GPS activity setting, not a fix or hardware power state.
      In v1.14.1, 1 means active and 0 inactive; null means the setting was not found. Other firmware may differ and replies may be stale.</p>}
    {selected === 'gps sync' && gpsClockSync && <p>{gpsClockSync.warning}</p>}
    {selected === 'gps setloc' && gpsSetLocation && <p>{gpsSetLocation.warning}</p>}
    {selected === 'clear stats' && action && 'warning' in action && <p>{action.warning}</p>}
    {selected.startsWith('log ') && action && 'warning' in action && <p>{action.warning}</p>}
    {selected.startsWith('set bridge.enabled ') && action && 'warning' in action && <p>{action.warning}</p>}
    {selected.startsWith('set bridge.source ') && action && 'warning' in action && <p>{action.warning}</p>}
    {selected === 'clkreboot' && action && 'warning' in action && <p>{action.warning}</p>}
    {selected === 'get adc.multiplier' && <p>In v1.14.1, a supported query returns the board-reported multiplier to three decimals,
      not whether it is the default or an override. Board and firmware support varies.</p>}
    {selected === 'discover.neighbors' && action && 'warning' in action && <p>{action.warning}</p>}
    <div className="contact-actions">
      <button type="button" disabled={!action || !ready || busy || pending || syncStatus.syncing} onClick={() => {
        if (action) sendChoice(action)
      }}>
        {action ? `Send ${action.command}` : 'Select a command'}
      </button>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing} onClick={() => {
        setSyncRequested(true)
        void messageSync.sync()
      }}>Sync messages for replies</button>
      <button type="button" disabled={!history.length || pending} onClick={() => setHistory([])}>Clear CLI history</button>
    </div>
    <details data-cli-section="clock">
      <summary>{managementForms.clock.title}</summary>
      <p>{repeaterClockWarning} This sends the entered time, not the browser or connected radio's clock.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('clock', 'Read the repeater clock', false)}>Read repeater clock</button>
      </div>
      <form className="contact-actions" onSubmit={submitClock}>
        <label>Time in UTC
          <input type="datetime-local" step="1" required min="1970-01-01T00:00:01" max="2106-02-07T06:28:15"
            value={clockTime} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setClockTime(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set repeater clock</button>
      </form>
    </details>
    <details data-cli-section="removeNeighbor">
      <summary>{managementForms.removeNeighbor.title}</summary>
      <p>{repeaterRemoveNeighborWarning} Enter the full 64-character hexadecimal public key, not the prefix in
        the neighbor list. Sync the reply and request the neighbor list separately after removal.</p>
      <form className="contact-actions" onSubmit={submitRemoveNeighbor}>
        <label>Neighbor full public key
          <input type="text" required value={neighborKey} autoComplete="off" spellCheck={false}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setNeighborKey(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Remove cached neighbor</button>
      </form>
    </details>
    <details data-cli-section="regions">
      <summary>{managementForms.regions.title}</summary>
      <p>The read controls do not change regions. Changes below affect the active map. The tree reply
        may be truncated without an indication, so it is not a
        complete inventory. In the tree, <code>F</code> marks flood permission, <code>^</code> marks the home region,
        and <code>*</code> is the wildcard for unscoped floods. Other routing rules can still block forwarding.</p>
      <p>Individual queries use firmware prefix matching: an exact match is preferred, but an incomplete or ambiguous
        prefix can return a different region. Compare the returned name. Region-tree replies require repeater firmware
        v1.12 or later; other query support varies by firmware.</p>
      <p>Filtered lists report region flood flags, not actual forwarding; other rules can block floods. Replies may omit
        names without warning, can become stale, and omit a leading <code>#</code>. The v1.14.1 firmware source handles
        remote administrator requests, but its documentation labels these lists serial-only; other builds may reject
        them or not reply.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region', 'Read the region tree', false)}>Read region tree</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region home', 'Read the home region', false)}>Read home region</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region default', 'Read the default scope region', false)}>Read default scope region</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region list allowed', 'List regions with flood permission', false)}>List flood-allowed regions</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region list denied', 'List regions without flood permission', false)}>List flood-denied regions</button>
      </div>
      <form className="contact-actions" onSubmit={submitRegionQuery}>
        <label>Region name or prefix
          <input type="text" required value={regionName} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRegionName(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Read region</button>
      </form>
      <p>Add a named region under the wildcard, or move an existing exact name there. Firmware treats names
        differing only by a leading <code>#</code> as the same name. New regions deny floods by default; moved
        regions keep their permissions. This can affect routes and remote access. Read and compare the region first:
        queries use prefix matching and the tree can be truncated, so neither proves a name is absent.
        Unprefixed names are limited to 29 UTF-8 bytes; names beginning with <code>#</code> or <code>$</code> to 30.
        Private <code>$</code> regions require keys; this action does not configure them.
        Sync the reply and read the region again. The change is not saved until the separate entire region-map save.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={putRegion}>Add or move region under wildcard</button>
      <p>Remove uses an exact name, ignoring a leading <code>#</code>; the wildcard cannot be removed.
        Firmware refuses to remove a region with children. Before removing the home region, set another home region
        and verify its reply: removal does not reset the home reference, and a later home query can misleadingly
        report <code>*</code>. Removing a region can disrupt routes and remote access and does not remove private keys.
        Sync the reply and inspect the map again; changes remain unsaved until the separate entire region-map save.
        The tree can be truncated and individual reads use prefix matching, so read-back has limitations.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={removeRegion}>Remove named region</button>
      <p>To change a named region's flood permission, read it first and compare the returned name. Firmware prefers
        exact names but may match a different region, including when names differ only by a leading <code>#</code>.
        The change reply does not identify the affected entry. Read and compare it again afterward, but read-back uses
        the same matching and cannot eliminate ambiguity. The change applies
        to one entry, not its children, and is not saved until the separate region-map save. Denying can disrupt routes
        and remote access; allowing does not override other rules or guarantee forwarding.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => changeRegionFlood(true)}>Allow flood forwarding for named region</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => changeRegionFlood(false)}>Deny flood forwarding for named region</button>
      </div>
      <p>The home region is the entry marked <code>^</code> in the tree. Firmware prefers an exact name, but a prefix can select a different region;
        compare the reply and read the home setting again. Setting <code>*</code> marks the wildcard as home. Changes are active but not saved
        until you separately save the entire region map.</p>
      <form className="contact-actions" onSubmit={submitHomeRegion}>
        <label>Home region name or prefix (<code>*</code> for wildcard)
          <input type="text" required value={homeRegion} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setHomeRegion(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set home region</button>
      </form>
      <p>Unscoped flood forwarding can be changed for the wildcard region only. Denying it can disrupt mesh routes
        and remote access. Other routing rules can still block forwarding when allowed. Changes affect the live map
        but are not saved by these commands. Sync the reply and read the wildcard state before deciding whether to save.</p>
      <p>Saving is separate and writes the entire current region map, including unrelated changes by other administrators.
        Radio acceptance alone does not confirm the change or save.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region get *', 'Read wildcard region', false)}>Read wildcard region</button>
        {regionActions.map((item) => <button key={item.command} type="button"
          disabled={!ready || busy || pending || syncStatus.syncing} onClick={() => sendChoice(item)}>{item.description}</button>)}
      </div>
    </details>
    <details data-cli-section="floodLimit">
      <summary>{managementForms.floodLimit.title}</summary>
      <p>These limits apply to forwarded flood packets, not direct packets. The overall limit applies to all floods;
        the unscoped and advertisement limits also apply to their matching packets. The lowest applicable limit wins.
        Zero stops forwarding matching floods and can disrupt routes or remote access. Other routing and region
        rules still apply.</p>
      <p>Verify firmware support before using a specific limit: some older firmware answers its query with the overall
        limit instead, so a numeric reply does not prove support. If an unscoped query returns 255, it indicates an
        unset value tracking the overall limit; these controls cannot restore that unset state after changing it.</p>
      <form className="contact-actions" onSubmit={submitFloodLimit}>
        <label>Flood limit type
          <select value={floodLimitKind} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'flood.max' || value === 'flood.max.unscoped' || value === 'flood.max.advert') setFloodLimitKind(value)
            }}>
            <option value="flood.max">Overall</option>
            <option value="flood.max.unscoped">Unscoped</option>
            <option value="flood.max.advert">Advertisement</option>
          </select>
        </label>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send(`get ${floodLimitKind}`, `Read ${floodLimitKind} hop limit`, false)}>Read selected limit</button>
        <label>Flood hop limit (0 to 64)
          <input type="text" inputMode="numeric" required value={floodLimit}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setFloodLimit(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set flood hop limit</button>
      </form>
    </details>
    <details data-cli-section="loopDetection">
      <summary>{managementForms.loopDetection.title}</summary>
      <p>Loop detection only checks forwarded flood packets for repeated occurrences of this repeater's ID/hash in
        their path. Thresholds for 1-, 2-, and 3-byte path hashes are: minimal (4/2/1), moderate (2/1/1), and strict
        (1/1/1). Off disables the check. More restrictive modes can drop flooded packets and reduce reachability.
        This CLI setting requires repeater firmware v1.14 or later.</p>
      <form className="contact-actions" onSubmit={submitLoopDetection}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get loop.detect', 'Read flood loop detection mode', false)}>Read current mode</button>
        <label>New flood loop detection mode
          <select required value={loopDetection} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setLoopDetection(event.currentTarget.value)}>
            <option value="">Choose a mode</option>
            <option value="off">Off</option>
            <option value="minimal">Minimal</option>
            <option value="moderate">Moderate</option>
            <option value="strict">Strict</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set loop detection</button>
      </form>
    </details>
    <details data-cli-section="pathHash">
      <summary>{managementForms.pathHash.title}</summary>
      <p>This controls the hash width used in this repeater's manual flood advertisements, not the hash widths of packets it
        forwards. On repeater v1.14.0, scheduled flood advertisements still use one-byte hashes; v1.14.1 and later also
        apply the setting to scheduled flood advertisements. Repeater firmware v1.14 and later can forward all supported hash widths. Repeater
        firmware v1.13 and earlier drops multi-byte path hashes, so enabling them can limit flood propagation across a mixed-version mesh.
        Modes 0, 1, and 2 use 1, 2, and 3 bytes (256, 65,536, and 16,777,216 possible IDs), respectively; their
        paths can encode at most 63, 32, and 21 hops. This setting requires repeater firmware v1.14 or later.</p>
      <form className="contact-actions" onSubmit={submitPathHashMode}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get path.hash.mode', 'Read advert path hash size', false)}>Read current size</button>
        <label>New advert path hash size
          <select required value={pathHashMode} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setPathHashMode(event.currentTarget.value)}>
            <option value="">Choose a size</option>
            <option value="0">1 byte — 256 IDs, up to 63 encoded hops</option>
            <option value="1">2 bytes — 65,536 IDs, up to 32 encoded hops</option>
            <option value="2">3 bytes — 16,777,216 IDs, up to 21 encoded hops</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set advert hash size</button>
      </form>
    </details>
    <details data-cli-section="airtime">
      <summary>{managementForms.airtime.title}</summary>
      <p>Lower factors permit more airtime and may violate local regulations; higher factors can delay traffic and
        remote access. Repeater firmware v1.14.1 uses an airtime budget that refills at approximately
        1 / (1 + factor) of elapsed time; it permits bursts, not a fixed pause after each transmission. Existing
        budget and scheduled timing can carry over after a change. This is not a guarantee of regulatory compliance.
        Check your jurisdiction and channel plan. Read the current factor first, then sync the reply and read it
        again after changing it. Read-back is a preference, not a measurement of airtime. The input range is 0–9
        with up to 2 decimal places.</p>
      <form className="contact-actions" onSubmit={submitAirtimeFactor}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get af', 'Read airtime factor', false)}>Read airtime factor</button>
        <label>New airtime factor (0–9)
          <input type="text" inputMode="decimal" required value={airtimeFactor}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAirtimeFactor(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set airtime factor</button>
      </form>
    </details>
    <details data-cli-section="retransmission">
      <summary>{managementForms.retransmission.title}</summary>
      <p>These factors control randomized retransmission delays for flood and direct traffic separately. Lower values
        can increase collisions; higher values can increase latency. Zero removes this random delay, not other delays.
        Changing either can affect mesh routes and remote access. Read the selected factor before changing it, then
        sync the reply and read it again. The supported input range is 0–2 with up to 2 decimal places.</p>
      <form className="contact-actions" onSubmit={submitRetransmitDelay}>
        <label>Retransmission delay type
          <select value={retransmitKind} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'txdelay' || value === 'direct.txdelay') setRetransmitKind(value)
            }}>
            <option value="txdelay">Flood</option>
            <option value="direct.txdelay">Direct</option>
          </select>
        </label>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send(`get ${retransmitKind}`, `Read ${retransmitKind === 'txdelay' ? 'flood' : 'direct'} retransmission delay factor`, false)}>Read selected delay</button>
        <label>New delay factor (0–2)
          <input type="text" inputMode="decimal" required value={retransmitDelay}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRetransmitDelay(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set retransmission delay</button>
      </form>
    </details>
    <details data-cli-section="receiveDelay">
      <summary>{managementForms.receiveDelay.title}</summary>
      <p>{receiveDelayWarning} A base of zero disables this delay calculation. Calculated delays below 50 ms
        are processed immediately; larger delays are capped. This control accepts 0–20 with up to 2 decimal places.
        Read the preference first, then sync the reply and read it again.</p>
      <form className="contact-actions" onSubmit={submitReceiveDelay}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get rxdelay', 'Read receive-delay base', false)}>Read receive-delay base</button>
        <label>New receive-delay base (0–20)
          <input type="text" inputMode="decimal" required value={receiveDelay}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setReceiveDelay(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set receive-delay base</button>
      </form>
    </details>
    <details data-cli-section="batteryCalibration">
      <summary>{managementForms.batteryCalibration.title}</summary>
      <p>{repeaterAdcMultiplierSafety}</p>
      <form className="contact-actions" onSubmit={submitAdcMultiplier}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get adc.multiplier', 'Read battery ADC multiplier', false)}>Read battery ADC multiplier</button>
        <label>New battery ADC multiplier (0–10, up to 3 decimals)
          <input type="text" inputMode="decimal" required value={adcMultiplier}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAdcMultiplier(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set battery ADC multiplier</button>
      </form>
      <p>{repeaterAdcMultiplierCaveats}</p>
    </details>
    <details data-cli-section="radioSettings">
      <summary>{managementForms.radioSettings.title}</summary>
      <p>{repeaterRadioSettingsSafety} Read and record the current preferences first; enter all four new values explicitly.</p>
      <form className="contact-actions" onSubmit={submitRadioSettings}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get radio', 'Read radio parameter preferences', false)}>Read radio preferences</button>
        <label>New frequency (400–2500 MHz)
          <input type="text" inputMode="decimal" required value={radioFrequency}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRadioFrequency(event.currentTarget.value)} />
        </label>
        <label>New bandwidth (7.8–500 kHz)
          <input type="text" inputMode="decimal" required value={radioBandwidth}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRadioBandwidth(event.currentTarget.value)} />
        </label>
        <label>New spreading factor (5–12)
          <input type="text" inputMode="numeric" required value={radioSpreadingFactor}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRadioSpreadingFactor(event.currentTarget.value)} />
        </label>
        <label>New coding rate denominator (5–8)
          <input type="text" inputMode="numeric" required value={radioCodingRate}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRadioCodingRate(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set radio preferences</button>
      </form>
      <p>Frequency and bandwidth accept up to three decimals. These ranges avoid values clamped when v1.14.1 loads
        preferences; they do not establish device support. {repeaterRadioSettingsCaveats}</p>
    </details>
    <details data-cli-section="tempRadio">
      <summary>{managementForms.tempRadio.title}</summary>
      <p>{repeaterTempRadioWarning}</p>
      <form className="contact-actions" onSubmit={submitTempRadio}>
        <label>Temporary frequency (400–2500 MHz)
          <input type="text" inputMode="decimal" required value={tempFrequency} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setTempFrequency(event.currentTarget.value)} />
        </label>
        <label>Temporary bandwidth (7.8–500 kHz)
          <input type="text" inputMode="decimal" required value={tempBandwidth} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setTempBandwidth(event.currentTarget.value)} />
        </label>
        <label>Temporary spreading factor (5–12)
          <input type="text" inputMode="numeric" required value={tempSpreadingFactor} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setTempSpreadingFactor(event.currentTarget.value)} />
        </label>
        <label>Temporary coding rate denominator (5–8)
          <input type="text" inputMode="numeric" required value={tempCodingRate} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setTempCodingRate(event.currentTarget.value)} />
        </label>
        <label>Override duration in minutes (1–35791)
          <input type="text" inputMode="numeric" required value={tempDuration} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setTempDuration(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set temporary override</button>
      </form>
      <p>Frequency and bandwidth accept up to three decimals. The duration limit avoids signed timer overflow in v1.14.1;
        even within it restoration is not guaranteed. Read and record radio preferences separately before changing anything.</p>
    </details>
    <details data-cli-section="transmitPower">
      <summary>{managementForms.transmitPower.title}</summary>
      <p>Read the stored preference first. Firmware documents a range of 1–22 dBm, but supported values vary by board.
        Check the repeater manual and local regulations; an external power amplifier can increase output, and excessive
        power may be unlawful. Firmware saves the preference and attempts to apply it, but may report OK even if applying
        it fails. Sync the reply and read the preference again; a matching read-back shows only the stored preference,
        not the applied or radiated RF power.</p>
      <form className="contact-actions" onSubmit={submitTransmitPower}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get tx', 'Read stored transmit power preference', false)}>Read stored transmit power</button>
        <label>New transmit power (1–22 dBm)
          <input type="number" step="any" required value={transmitPower}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setTransmitPower(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set transmit power</button>
      </form>
    </details>
    <details data-cli-section="receiverGain">
      <summary>{managementForms.receiverGain.title}</summary>
      <p>Support depends on the radio and firmware build; repeater firmware v1.14.1 implements this for SX1262 and
        SX1268 builds. Changing gain may affect reception and power use. Read the preference first, sync the reply, and
        compare it after a change. On some unsupported builds the read can return radio parameters rather than{' '}
        <code>on</code> or <code>off</code>; that is not a gain result. An OK reply or matching read-back does not prove
        that the radio applied the preference or saved it successfully. In v1.14.1, saving also sets a local advert
        interval below 60 minutes to zero; an already scheduled advert may still be sent.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get radio.rxgain', 'Read receiver boosted-gain preference', false)}>Read receiver gain preference</button>
        {receiverGainCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
    </details>
    <details data-cli-section="agc">
      <summary>{managementForms.agc.title}</summary>
      <p>Set a periodic automatic gain control (AGC) reset interval in seconds.
        This control accepts 0–1020 in multiples of four, avoiding the rounding or wrapping possible in v1.14.1.
        {` ${agcResetWarning}`} Read the preference first, then sync the reply and read it again.</p>
      <form className="contact-actions" onSubmit={submitAgcResetInterval}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get agc.reset.interval', 'Read AGC reset interval', false)}>Read AGC reset interval</button>
        <label>New AGC reset interval (seconds)
          <input type="text" inputMode="numeric" required value={agcResetInterval}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAgcResetInterval(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set AGC reset interval</button>
      </form>
    </details>
    <details data-cli-section="interference">
      <summary>{managementForms.interference.title}</summary>
      <p>Enter a whole value from 0 to 255; this is the v1.14.1 storage range, not a recommended setting.
        Choose a value appropriate for the device and environment. {interferenceWarning} Read the preference first,
        then sync the reply and read it again.</p>
      <form className="contact-actions" onSubmit={submitInterferenceThreshold}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get int.thresh', 'Read interference threshold', false)}>Read interference threshold</button>
        <label>New interference threshold (0–255)
          <input type="text" inputMode="numeric" required value={interferenceThreshold}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setInterferenceThreshold(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set interference threshold</button>
      </form>
    </details>
    <details data-cli-section="multiAck">
      <summary>{managementForms.multiAck.title}</summary>
      <p>In repeater firmware v1.14.1, enabling this attempts to queue one extra multipart acknowledgement (ACK)
        when forwarding an eligible direct ACK, and can delay the normal ACK. It can use more airtime; other nodes
        may not support multipart ACKs, and delivery or improved reliability is not guaranteed. Already queued ACKs
        are unaffected. Firmware support varies. Read the preference first, sync the reply, and read it again after
        a change. A numeric reply reports the preference, not whether ACKs were sent or the preference was saved.
        Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get multi.acks', 'Read extra direct ACK preference', false)}>Read extra direct ACK preference</button>
        {multiAckCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
    </details>
    <details data-cli-section="powerSaving">
      <summary>{managementForms.powerSaving.title}</summary>
      <p>Depending on the board and firmware, enabling this preference may let the repeater sleep when idle and be less responsive.
        An <code>on</code> reply reports the preference, not actual sleep; for example, Pico W repeater firmware v1.14.1 does not implement sleep.
        Read the preference explicitly; sync each reply and check it after changing it. Radio acceptance alone does not confirm the command succeeded.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('powersaving', 'Read repeater power-saving preference', false)}>Read power-saving preference</button>
        {powerSavingCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
    </details>
    <details data-cli-section="packetLog">
      <summary>{managementForms.packetLog.title}</summary>
      <p>These actions send separate commands and require confirmation. On repeater v1.14.1 the log stores packet metadata
        on the repeater, including timestamps and some address prefixes; it can expose traffic patterns and consume storage.
        Logging stops on reboot, but stopping does not erase the log. Erasing does not stop logging, and the file can be recreated.
        Erasure is not guaranteed to be secure and does not remove backups. Firmware support varies.</p>
      <p>This app cannot read the log or check whether logging is active. In v1.14.1 reading the log is serial-only;
        writing or removing it can fail even when the command replies. Replies and commands may arrive late.</p>
      <div className="contact-actions">
        {packetLogCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
    </details>
    <details data-cli-section="bridge">
      <summary>{managementForms.bridge.title}</summary>
      <p>Enabling a bridge can expose mesh packets to an external interface and introduce packets from it into the mesh.
        Disabling it can interrupt routes and remote access that depend on the bridge; queued packets can still be processed.
        Check the interface, peer and local recovery method before changing it.</p>
      <p>In repeater v1.14.1 the change attempts to start or stop the bridge immediately and save the preference.
        Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent.
        A reply or preference read-back does not prove the bridge is working, stopped, or saved. Commands and replies may
        arrive late, and firmware and build support vary. Read the bridge type and enabled preference separately.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get bridge.type', 'Read compiled bridge type', false)}>Read compiled bridge type</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get bridge.enabled', 'Read bridge enabled preference', false)}>Read bridge enabled preference</button>
        {bridgeCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
      <p>Packet source selects which radio observations are offered to the external bridge, not whether packets can enter
        from it. Changing it can expose different traffic and affect routes or remote access. In v1.14.1, the commands
        use <code>rx</code> or <code>tx</code>, while the reported preference is <code>logRx</code> or <code>logTx</code>.
        The change applies to subsequent observations and attempts to save the preference. A reply or matching read-back
        does not prove packets were bridged or the setting was saved; firmware and build support vary.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get bridge.source', 'Read bridge packet source preference', false)}>Read bridge packet source preference</button>
        {bridgeSourceCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
      <p>In v1.14.1, the bridge delay schedules packets entering from the bridge for later mesh processing,
        not packets sent to the bridge. Already queued packets retain their scheduled time. Zero removes this added
        delay but does not guarantee immediate processing; packets can be dropped if the queue is full. Changing it
        can affect latency, routes and remote access. Read the preference separately; it does not prove actual timing
        or persistence. The advert-save side effect above also applies. Commands and replies may arrive late;
        firmware and build support vary.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('get bridge.delay', 'Read bridge delay preference', false)}>Read bridge delay preference</button>
      <form className="contact-actions" onSubmit={submitBridgeDelay}>
        <label>Bridge inbound delay (0–10000 ms)
          <input type="text" inputMode="numeric" required value={bridgeDelay}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setBridgeDelay(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set bridge inbound delay</button>
      </form>
    </details>
    <details data-cli-section="bridgeChannel">
      <summary>{managementForms.bridgeChannel.title}</summary>
      <p>Changing this channel can disconnect ESP-NOW bridge peers, interrupt routes and prevent remote access.
        Verify peer settings, local regulations, device support and a local recovery method first; accepting a value
        does not guarantee that the channel is supported or legal. This control is for ESP-NOW bridges; firmware and
        build support vary.</p>
      <p>In repeater v1.14.1, a running bridge turns Wi-Fi off before attempting an immediate restart; a stopped bridge
        is not started. Restart or saving can fail, and saving also sets a local advert interval below 60 minutes to zero;
        an already scheduled advert may still be sent. An OK reply or matching preference does not prove the channel
        was applied, a peer is connected, or the setting was saved. Commands and replies may arrive late.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('get bridge.channel', 'Read ESP-NOW bridge channel preference', false)}>Read ESP-NOW bridge channel</button>
      <form className="contact-actions" onSubmit={submitBridgeChannel}>
        <label>ESP-NOW bridge channel (1–14)
          <input type="text" inputMode="numeric" required value={bridgeChannel}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setBridgeChannel(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set ESP-NOW bridge channel</button>
      </form>
    </details>
    <details data-cli-section="bridgeBaud">
      <summary>{managementForms.bridgeBaud.title}</summary>
      <p>Changing this rate can interrupt bridge traffic, routes and remote access. Check the peer baud rate, device support
        and a local recovery method first; acceptance does not guarantee the hardware or peer supports the rate.
        This control accepts whole rates from 9600 to 115200, the default v1.14.1 firmware range.
        Customized builds can use a different maximum; firmware and RS-232 build support vary.</p>
      <p>In repeater v1.14.1, a running bridge immediately attempts to restart its serial interface; a stopped bridge is not
        started. In-flight data may be lost, and partial received frames may remain across the restart. Saving can fail and
        also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent.
        An OK reply or matching preference does not prove the interface or peer is working or the setting was saved.
        Commands and replies may arrive late.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('get bridge.baud', 'Read RS-232 bridge baud preference', false)}>Read RS-232 bridge baud rate</button>
      <form className="contact-actions" onSubmit={submitBridgeBaud}>
        <label>RS-232 bridge baud rate (9600–115200)
          <input type="text" inputMode="numeric" required value={bridgeBaud}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setBridgeBaud(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set RS-232 bridge baud rate</button>
      </form>
    </details>
    <details data-cli-section="advertInterval">
      <summary>{managementForms.advertInterval.title}</summary>
      <p>Changing an interval affects future transmissions. Use 0 to disable. Local intervals are even minutes
        from 60 to 240; flood intervals are hours from 3 to 168.</p>
      <form className="contact-actions" onSubmit={submitInterval}>
        <label>Advertisement interval type
          <select value={intervalKind} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'advert.interval' || value === 'flood.advert.interval') setIntervalKind(value)
            }}>
            <option value="advert.interval">Local (minutes)</option>
            <option value="flood.advert.interval">Flood (hours)</option>
          </select>
        </label>
        <label>Interval value
          <input type="number" min="0" step="1" required value={interval}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setInterval(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set interval</button>
      </form>
    </details>
    <details data-cli-section="removeAccess">
      <summary>{managementForms.removeAccess.title}</summary>
      <p>Enter the client's full 64-character hexadecimal public key, not the six-byte prefix shown by access-list inspection.
        This removes the entire entry, but does not change passwords: the client can log in again with a valid password, and a
        blank guest password may allow guest access. Removing the connected radio or repeater is not offered here.</p>
      <p>In repeater firmware v1.14.1, removing an entry can misdirect the reply. Saving is delayed and can fail, so an
        OK reply does not verify persistence. Inspect the access list again, but it can omit entries; absence does not prove removal.</p>
      <form className="contact-actions" onSubmit={submitRemoveAccess}>
        <label>Client full public key
          <input type="text" required value={accessKey} autoComplete="off" spellCheck={false}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAccessKey(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Remove access-list entry</button>
      </form>
    </details>
    <details data-cli-section="limitedAccess">
      <summary>{managementForms.limitedAccess.title}</summary>
      <p>Enter the client's full 64-character hexadecimal public key, not an access-list prefix.
        The connected radio and repeater are not offered as targets.</p>
      <p>{repeaterLimitedAccessWarning}</p>
      <form className="contact-actions" onSubmit={submitLimitedAccess}>
        <label>Client role full public key
          <input type="text" required value={limitedAccessKey} autoComplete="off" spellCheck={false}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setLimitedAccessKey(event.currentTarget.value)} />
        </label>
        <label>Non-admin role
          <select required value={limitedRole} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const role = event.currentTarget.value
              if (role === '' || role === 'read-only' || role === 'read-write') setLimitedRole(role)
            }}>
            <option value="">Choose a role</option>
            <option value="read-only">Read-only (1)</option>
            <option value="read-write">Read-write (2)</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set client role</button>
      </form>
    </details>
    <details data-cli-section="adminAccess">
      <summary>{managementForms.adminAccess.title}</summary>
      <p>Enter the client's full 64-character hexadecimal public key, not an access-list prefix.
        The connected radio and repeater are not offered as targets.</p>
      <p>{repeaterGrantAdminWarning}</p>
      <form className="contact-actions" onSubmit={submitGrantAdmin}>
        <label>Administrator full public key
          <input type="text" required value={adminAccessKey} autoComplete="off" spellCheck={false}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAdminAccessKey(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Grant administrator access</button>
      </form>
    </details>
    <details data-cli-section="guestPassword">
      <summary>{managementForms.guestPassword.title}</summary>
      <p>Changes the password used for guest repeater access, not the administrator password. Changing it does not
        revoke already-authorized guest identities; they may still access the repeater. Firmware stores a
        maximum of 15 printable ASCII characters. The value is sent only after confirmation, is cleared from the
        input when confirmation is accepted, and is redacted from this page's CLI history. Firmware returns <code>OK</code>
        for the command; do not query <code>get guest.password</code>, which returns the password in plaintext. Sync the
        reply to check acceptance. This does not prove which value is stored. Clearing is not offered because a
        blank guest password could allow unauthenticated guest access. Choose a unique password; do not reuse the
        administrator password.</p>
      <form className="contact-actions" onSubmit={submitGuestPassword}>
        <label>New guest password
          <input type="password" autoComplete="new-password" required value={guestPassword}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setGuestPassword(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set guest password</button>
      </form>
    </details>
    <details data-cli-section="name">
      <summary>{managementForms.name.title}</summary>
      <p>The field starts empty. Read the stored name first; this does not change the public key or send an advertisement.
        Advertisements can show a shorter name when they include location. Names must be 1 to 31 UTF-8 bytes,
        without leading or trailing spaces, control characters, or <code>[]/\:,?*</code>.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('get name', 'Read the advertised name', false)}>Read repeater name</button>
      <form className="contact-actions" onSubmit={submitName}>
        <label>New repeater name
          <input type="text" required value={repeaterName} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRepeaterName(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set repeater name</button>
      </form>
    </details>
    <details data-cli-section="owner">
      <summary>{managementForms.owner.title}</summary>
      <p>Replaces the current owner information. It can be requested over the mesh; do not include passwords or private data.
        Repeater firmware v1.12 or later is required. The field starts empty; use get owner.info to read the current value.
        Use line breaks instead of |, and leave blank to clear.</p>
      <form className="repeater-owner-form" onSubmit={submitOwnerInfo}>
        <label htmlFor={ownerInfoId}>Owner information</label>
        <textarea id={ownerInfoId} rows={4} value={ownerInfo} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setOwnerInfo(event.currentTarget.value)} />
        <p>Maximum 119 UTF-8 bytes, including line breaks.</p>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set owner information</button>
      </form>
    </details>
    <details data-cli-section="gps">
      <summary>{managementForms.gps.title}</summary>
      <p>GPS support depends on the repeater firmware and hardware. Enabling GPS can expose sensor coordinates through location
        telemetry or later advertisements with the share policy and may change the device clock, disrupting later commands. Disabling does not erase
        stored coordinates or recall locations already sent or queued; some boards cannot power off the receiver.
        An ok reply does not prove a fix, hardware state, or persistence.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('sensor get gps', 'Read GPS activity setting', false)}>Read GPS activity setting</button>
        {gpsCommands.map((command) => <button key={command.command} type="button"
          disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => sendChoice(command)}>{command.description}</button>)}
      </div>
      <p>Each action sends a separate command. Sync replies explicitly; request the activity setting again to check the reported state.
        In v1.14.1, 1 means active and 0 inactive; null means the setting was not found.
        The <code>gps</code> status command is not offered because repeater v1.14.1 may crash when a GPS receiver is not detected.</p>
      <p>GPS clock synchronization does not enable GPS. An ok reply does not prove a fix or clock change; a change may happen later and can
        disrupt commands. Some providers do not apply it. GPS may already adjust the clock automatically. Read the clock separately.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('clock', 'Read the repeater clock', false)}>Read repeater clock</button>
        {gpsClockSync && <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => sendChoice(gpsClockSync)}>{gpsClockSync.description}</button>}
      </div>
    </details>
    <details data-cli-section="position">
      <summary>{managementForms.position.title}</summary>
      <p>Advertisements use these stored coordinates only when the GPS advert policy is <code>prefs</code>.
        Policy <code>none</code> omits location; <code>share</code> uses sensor coordinates.
        Read the current values with <code>get lat</code> and <code>get lon</code>. Changing one coordinate does not change the other.</p>
      <p>Copying sensor coordinates replaces both stored values. They can be stale or zero even without a GPS fix or receiver.
        Firmware support varies. Sync replies and read both stored coordinates separately; an ok reply does not prove a valid fix or persistence.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get lat', 'Read stored latitude', false)}>Read stored latitude</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get lon', 'Read stored longitude', false)}>Read stored longitude</button>
        {gpsSetLocation && <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => sendChoice(gpsSetLocation)}>{gpsSetLocation.description}</button>}
      </div>
      <p>Check the policy explicitly below. Some firmware builds do not support this command; an unsupported reply does not establish the policy.
        Changes affect newly created advertisements but do not send one or recall already queued or transmitted locations. Sensor coordinates may be stale or zero;
        selecting share does not enable GPS. Sync replies and read the policy again to check the change.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('gps advert', 'Read GPS advert policy', false)}>Read GPS advert policy</button>
      <form className="contact-actions" onSubmit={submitAdvertPolicy}>
        <label>New GPS advert policy
          <select required value={advertPolicy} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAdvertPolicy(event.currentTarget.value)}>
            <option value="">Choose a policy</option>
            <option value="none">None — omit location</option>
            <option value="prefs">Prefs — stored coordinates</option>
            <option value="share">Share — sensor coordinates</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set GPS advert policy</button>
      </form>
      <form className="repeater-position-form" onSubmit={(event) => submitPosition(event, 'lat', latitude)}>
        <label htmlFor={`${ownerInfoId}-latitude`}>Latitude (-90 to 90)</label>
        <input id={`${ownerInfoId}-latitude`} type="text" inputMode="decimal" required
          value={latitude} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setLatitude(event.currentTarget.value)} />
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set latitude</button>
      </form>
      <form className="repeater-position-form" onSubmit={(event) => submitPosition(event, 'lon', longitude)}>
        <label htmlFor={`${ownerInfoId}-longitude`}>Longitude (-180 to 180)</label>
        <input id={`${ownerInfoId}-longitude`} type="text" inputMode="decimal" required
          value={longitude} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setLongitude(event.currentTarget.value)} />
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set longitude</button>
      </form>
    </details>
    {pending && <p role="status">Sending to the radio…</p>}
    {syncRequested && syncStatus.error && <p role="alert">{syncStatus.error}</p>}
    {error && <p role="alert">{error}</p>}
    <h4>CLI history</h4>
    {!history.length ? <p>No commands sent in this view.</p> : !matchingHistory.length ? <p>No history matches.</p> :
      <ol className="repeater-cli-history">
        {[...matchingHistory].reverse().map((item) => <li key={item.tag}>
          <strong><code>{item.command}</code></strong>
          <span> · {item.unconfirmed ? 'Send unconfirmed' : `Accepted by radio (${item.route})`}</span>
          {item.reply !== null ? <pre>{item.reply.text || '(empty reply)'}</pre> :
            <p>{now >= item.deadline ? 'No reply synced before the deadline. It may still arrive.' :
              'Waiting for a reply. Sync messages to check.'}</p>}
          {item.command === 'get public.key' && item.reply !== null &&
            <p className="contact-status">
              {{ match: 'Reported key matches the saved contact.', mismatch: 'Reported key differs from the saved contact.',
                unrecognized: 'Unrecognized public-key reply; it cannot be compared.' }[compareRepeaterPublicKey(item.reply.text, contactKey)]}
              {' '}A match alone does not prove identity; replies can be delayed or misattributed.
            </p>}
          {item.command === 'get role' && item.reply !== null &&
            <p className="contact-status">This is the reported firmware role, not your access level. Firmware support varies.</p>}
          {item.command === 'get bootloader.ver' && item.reply !== null &&
            <p className="contact-status">{bootloaderDiagnosticHelp}</p>}
          {item.command === 'get radio' && item.reply !== null &&
            <p className="contact-status">This reports preferences, not active radio settings or proof of persistence.
              In v1.14.1 frequency uses floating-point precision and bandwidth is rounded to three decimals.</p>}
          {item.command.startsWith('set radio ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove persistence or successful application. Read preferences separately;
              they can apply on reboot or when a temporary radio override expires, and a delayed change may arrive after a later change.</p>}
          {item.command.startsWith('tempradio ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove the override applied or that settings will be restored.
              Expiry uses then-current preferences, not necessarily the previous active settings.</p>}
          {powerDiagnosticHelp(item.command) && item.reply !== null &&
            <p className="contact-status">{powerDiagnosticHelp(item.command)} Firmware and hardware support vary; replies may be delayed.</p>}
          {bridgeDiagnosticHelp(item.command) && item.reply !== null &&
            <p className="contact-status">{bridgeDiagnosticHelp(item.command)} Firmware and build support vary; replies may be delayed or unsupported.</p>}
          {item.command.startsWith('set bridge.enabled ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove the bridge is working, stopped, or saved. Read the preference separately;
              a delayed command may still change it later.</p>}
          {item.command.startsWith('set bridge.source ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove packets were bridged or the setting was saved. Read the preference separately;
              a delayed command may still change it later.</p>}
          {item.command.startsWith('set bridge.delay ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove actual timing or persistence. Read the preference separately;
              a delayed command may still change it later.</p>}
          {item.command.startsWith('set bridge.channel ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove the channel was applied, a peer is connected, or the setting was saved.
              Read the preference separately; a delayed command may still change it later.</p>}
          {item.command.startsWith('set bridge.baud ') && item.reply !== null &&
            <p className="contact-status">A reply does not prove the interface or peer is working or the setting was saved.
              Read the preference separately; a delayed command may still change it later.</p>}
          {item.command === 'sensor get gps' && item.reply !== null &&
            <p className="contact-status">This is a reported activity setting, not proof of a current fix, receiver power state, or persistence.
              In v1.14.1, 1 means active and 0 inactive. A null or unsupported reply does not establish hardware support. Firmware and hardware support vary.</p>}
          {(item.command === 'gps on' || item.command === 'gps off') && item.reply !== null &&
            <p className="contact-status">An ok reply does not prove a fix, hardware state, or persistence. Request the GPS activity setting separately.</p>}
          {item.command === 'gps sync' && item.reply !== null &&
            <p className="contact-status">An ok reply does not prove a fix or clock change. Read the clock separately; it may still change later.</p>}
          {item.command === 'gps setloc' && item.reply !== null &&
            <p className="contact-status">An ok reply does not prove a valid fix or persistence. Read both stored coordinates separately; firmware support varies.</p>}
          {item.command === 'clear stats' && item.reply !== null &&
            <p className="contact-status">An OK reply does not verify every effect. Request status separately; counters can increase immediately.</p>}
          {item.command.startsWith('log ') && item.reply !== null &&
            <p className="contact-status">A reply does not verify the current logging state, saved records, or successful erasure.
              A delayed command may still change the log later.</p>}
          {item.command === 'get adc.multiplier' && item.reply !== null &&
            <p className="contact-status">A read-back does not prove accurate voltage or persistence. In v1.14.1 it is rounded and does not identify a default or override.</p>}
          {item.command.startsWith('set adc.multiplier ') && item.reply !== null &&
            <p className="contact-status">An OK reply does not prove accurate voltage or persistence. Read the multiplier and battery status separately.</p>}
          {item.command === 'region' && item.reply !== null &&
            <p className="contact-status">The region tree may be truncated without an indication; it is not a complete inventory.
              F marks flood permission, ^ marks the home region, and * is the unscoped wildcard.</p>}
          {item.command.startsWith('region get ') && item.reply !== null &&
            <p className="contact-status">Firmware may match a prefix to a different region. Compare the returned name.</p>}
          {(item.command === 'region list allowed' || item.command === 'region list denied') && item.reply !== null &&
            <p className="contact-status">This flag snapshot may omit names without warning and can become stale.
              A leading # is omitted; flood permission does not guarantee forwarding.</p>}
          {item.command === 'powersaving' && item.reply !== null &&
            <p className="contact-status">An on reply reports the preference, not actual sleep; behavior depends on the board and firmware.</p>}
          {item.command === 'get radio.rxgain' && item.reply !== null &&
            <p className="contact-status">An on/off reply reports the current preference, not the applied radio setting or successful persistence.
              Some unsupported builds return radio parameters instead of a gain result.</p>}
          {item.command === 'get rxdelay' && item.reply !== null &&
            <p className="contact-status">A read-back reports the preference, not measured delay or successful persistence.</p>}
          {item.command === 'get agc.reset.interval' && item.reply !== null &&
            <p className="contact-status">A numeric read-back reports the preference, not whether a reset occurred or the preference was saved.</p>}
          {item.command === 'get int.thresh' && item.reply !== null &&
            <p className="contact-status">A numeric read-back reports the preference, not whether interference detection worked or the preference was saved.</p>}
          {item.command === 'get multi.acks' && item.reply !== null &&
            <p className="contact-status">A numeric read-back reports the preference, not whether ACKs were sent or the preference was saved.</p>}
          {item.command === 'discover.neighbors' && item.reply !== null &&
            <p className="contact-status">An OK reply does not prove a broadcast occurred or that any neighbors replied.
              Discovery responses are unauthenticated and do not prove identity. Wait up to 60 seconds, then request neighbors
              separately; old entries may remain and the list can be incomplete.</p>}
          {item.command.startsWith('neighbor.remove ') && item.reply !== null &&
            <p className="contact-status">An OK reply does not prove an entry matched. The neighbor can reappear;
              older snapshots and maps remain stale, and a new neighbor list can be incomplete.</p>}
          {item.command.startsWith('setperm ') && item.command.endsWith(' 0') && item.reply !== null &&
            <p className="contact-status">An OK reply does not verify persistence. Firmware v1.14.1 may misdirect the reply,
              and absence from the access list does not prove removal.</p>}
          {item.command.startsWith('setperm ') && !item.command.endsWith(' 0') && item.reply !== null &&
            <p className="contact-status">An OK reply does not verify persistence. Adding an entry to a full table can evict
              another client, including an administrator; the access list can omit entries.</p>}
          {item.command === 'neighbors' && item.reply !== null &&
            <NeighborReport reply={item.reply.text} syncedAt={item.reply.syncedAt} name={name} repeaterPosition={repeaterPosition}
              nodes={neighborNodes} onMap={onMap} />}
        </li>)}
      </ol>}
  </details>
}

function NeighborReport({ reply, syncedAt, name, repeaterPosition, nodes, onMap }: {
  reply: string
  syncedAt: number
  name: string
  repeaterPosition: Coordinates | null
  nodes: readonly PathNode[]
  onMap?: (path: MapPath) => void
}) {
  const date = new Date(syncedAt)
  const syncTime = date.toLocaleString()
  const timing = <p className="contact-status">Reply synced <time dateTime={date.toISOString()}>{syncTime}</time> (browser time). {neighborTiming}</p>
  let neighbors
  try {
    neighbors = parseRepeaterNeighbors(reply)
  } catch (reason) {
    return <>{timing}<p className="contact-status">{reason instanceof Error ? reason.message : 'The neighbor list could not be read.'}</p></>
  }
  if (!neighbors.length) return <>{timing}<p className="contact-status">No neighbors were reported.</p></>

  const resolved = neighbors.map((neighbor) => ({
    ...neighbor,
    matches: resolvePath([neighbor.keyPrefix], nodes)[0].matches,
  }))
  const mappedCount = resolved.filter(({ matches }) => matches.length === 1 && mapPosition(matches[0].position)).length
  const path: MapPath = {
    title: `Neighbors heard by ${name}`,
    description: `Reply synced ${syncTime} (browser time). ${neighborTiming}`,
    connect: false,
    points: [
      { label: `${name} (repeater)`, position: repeaterPosition },
      ...resolved.map(({ keyPrefix, secondsAgo, snrQuarterDb, matches }) => ({
        label: `${matches.length === 1 ? matches[0].name : `${keyPrefix} (${matches.length ? 'ambiguous prefix' : 'not in saved contacts'})`} · reported age ${secondsAgo}s at reply · SNR ${snrQuarterDb / 4} dB`,
        position: matches.length === 1 ? matches[0].position : null,
      })),
    ],
  }
  return <div className="repeater-neighbor-report">
    {timing}
    <ul aria-label="Neighbors in reply">
      {resolved.map(({ keyPrefix, secondsAgo, snrQuarterDb, matches }, index) => <li key={`${keyPrefix}:${index}`}>
        {matches.length === 1 ? matches[0].name : keyPrefix} · reported age {secondsAgo}s at reply · {snrQuarterDb / 4} dB
        {matches.length > 1 ? ' · Ambiguous saved-contact prefix; not mapped'
          : matches.length === 0 ? ' · Not in saved contacts'
            : !mapPosition(matches[0].position) ? ' · Position unavailable' : ''}
      </li>)}
    </ul>
    {onMap && <button type="button" disabled={!mappedCount} onClick={() => onMap(path)}>
      Show known neighbors on map
    </button>}
    {!mappedCount && <p className="contact-status">No uniquely matched neighbors have mappable saved positions.</p>}
  </div>
}
