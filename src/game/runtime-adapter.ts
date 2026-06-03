import { DataConnection, Peer } from 'peerjs'
import {
  fetchServerConfig,
  registerArtwork,
  REGISTRY_PATH,
  type ArtworkRegistration,
  type ControllerAlignmentCross,
  type ControllerInputPacket,
  type ControllerInputState,
  type ControllerPlayerState,
  type ControllerSessionState,
  type ControllerTransport,
  type DomeControlPacket,
} from '@dome-control/runtime'
import type CoopGameEngine from './engine'

declare global {
  interface Window {
    domeControlRuntime?: {
      upsertControllerInput: (id: string, input: ControllerInputState, transport?: ControllerTransport) => void
      removeController: (id: string) => void
      showControllerAlignment: (id: string, cross: ControllerAlignmentCross | null) => void
      getSessionState: () => ControllerSessionState
      getGameSnapshot: () => unknown
    }
  }
}

function nowSeconds() {
  return performance.now() * 0.001
}

export default class ArtworkDomeControlAdapter {
  private readonly query = new URLSearchParams(window.location.search)
  private readonly sessionId = this.query.get('session') ?? 'dome-game-canvas'
  // Human-facing name advertised on the registry; must be unique across artworks.
  private readonly artworkName = this.query.get('name') ?? 'Dome Game'
  // Connection id controllers dial. Unique per instance; controllers learn it
  // from the registry rather than guessing, so a random id is fine.
  private readonly peerId = this.query.get('artwork-peer') ?? `artwork-${Math.random().toString(36).slice(2, 10)}`
  private readonly registryPort = Number(this.query.get('registry-port') ?? 8082)
  private registration: ArtworkRegistration | null = null
  // ICE servers dictated by the server (LAN => []); fetched once, reused on reconnect.
  private iceServers: RTCIceServer[] | null = null
  private transport: ControllerTransport = 'debug-local'
  private peer: Peer | null = null
  private readonly dataConnections = new Map<string, DataConnection>()
  private readonly controllerPeers = new Map<string, string>()
  private readonly peerControllers = new Map<string, string>()
  private readonly peerHost = window.location.hostname || '127.0.0.1'
  private readonly peerPort = window.location.protocol === 'https:' ? Number(window.location.port || 443) : 8081
  private readonly peerPath = '/peerjs'
  private readonly peerSecure = window.location.protocol === 'https:'
  private peerReconnectTimer: number | null = null

  private watchdogTimer: number | null = null

  constructor(
    private readonly engine: CoopGameEngine,
    private readonly onActivity: () => void,
  ) {
    this.connectPeerServer()
    this.startWatchdog()
  }

  private logRuntime(event: string, data?: Record<string, unknown>) {
    console.info(`[${new Date().toISOString()}] [dome-control/artwork] ${event}`, {
      sessionId: this.sessionId,
      artworkPeerId: this.peerId,
      ...data,
    })
  }

  private startWatchdog() {
    let lastTick = Date.now()
    this.watchdogTimer = window.setInterval(() => {
      const now = Date.now()
      if (now - lastTick > 5000) {
        this.peer?.destroy()
        this.peer = null
        this.schedulePeerReconnect(2000)
      }
      lastTick = now
    }, 1000)
  }

  attachGlobal() {
    window.domeControlRuntime = {
      upsertControllerInput: (id, input, transport = 'debug-local') => {
        this.transport = transport
        this.engine.upsertPlayerInput(id, input)
        this.onActivity()
      },
      removeController: (id) => {
        this.engine.removePlayer(id)
        this.onActivity()
      },
      showControllerAlignment: (id, cross) => {
        this.engine.setAlignmentCross(id, cross)
        this.onActivity()
      },
      getSessionState: () => this.getSessionState(),
      getGameSnapshot: () => this.engine.getSnapshot(),
    }
  }

  dispose() {
    if (this.watchdogTimer != null) {
      window.clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.peerReconnectTimer != null) {
      window.clearTimeout(this.peerReconnectTimer)
      this.peerReconnectTimer = null
    }
    this.registration?.dispose()
    this.registration = null
    this.destroyPeer()
    this.engine.setCursorDebugLogger(null)
    this.engine.setMotionDebugLogger(null)
    delete window.domeControlRuntime
  }

  private destroyPeer() {
    for (const connection of this.dataConnections.values()) {
      connection.close()
    }
    this.dataConnections.clear()
    this.controllerPeers.clear()
    this.peerControllers.clear()
    this.peer?.destroy()
    this.peer = null
    if (this.transport === 'webrtc') {
      this.transport = 'debug-local'
    }
  }

  private async connectPeerServer() {
    this.destroyPeer()

    if (this.iceServers === null) {
      this.iceServers = (await fetchServerConfig(this.registryUrl())).iceServers
    }

    const nextPeer = new Peer(this.peerId, {
      host: this.peerHost,
      port: this.peerPort,
      path: this.peerPath,
      secure: this.peerSecure,
      config: { iceServers: this.iceServers ?? [] },
    })
    this.peer = nextPeer

    nextPeer.on('open', () => {
      if (this.peer !== nextPeer) return
      this.logRuntime('peer-open', {
        peerId: this.peerId,
      })
      this.ensureRegistered()
      this.onActivity()
    })

    nextPeer.on('connection', (connection) => {
      if (this.peer !== nextPeer) {
        connection.close()
        return
      }
      this.attachDataConnection(connection)
    })

    nextPeer.on('disconnected', () => {
      if (this.peer !== nextPeer) return
      this.destroyPeer()
      this.onActivity()
      this.schedulePeerReconnect()
    })

    nextPeer.on('close', () => {
      if (this.peer !== nextPeer) return
      this.destroyPeer()
      this.onActivity()
      this.schedulePeerReconnect()
    })

    nextPeer.on('error', () => {
      if (this.peer !== nextPeer) return
      this.destroyPeer()
      this.schedulePeerReconnect()
    })
  }

  private registryUrl() {
    // https artworks reach the registry same-origin (proxied); http artworks
    // connect directly to the registry port.
    return this.peerSecure
      ? `wss://${window.location.host}${REGISTRY_PATH}`
      : `ws://${this.peerHost}:${this.registryPort}${REGISTRY_PATH}`
  }

  // Advertise this artwork on the registry once the peer id is live. The
  // registration owns its own socket and reconnects independently of the peer.
  private ensureRegistered() {
    if (this.registration) return
    this.registration = registerArtwork({
      url: this.registryUrl(),
      id: this.peerId,
      name: this.artworkName,
      sessionId: this.sessionId,
      onRegistered: () => this.logRuntime('registry-registered', { name: this.artworkName }),
      onRejected: (reason) => this.logRuntime('registry-rejected', { name: this.artworkName, reason }),
    })
  }

  private schedulePeerReconnect(delayMs = 1500) {
    if (this.peerReconnectTimer != null) return
    this.peerReconnectTimer = window.setTimeout(() => {
      this.peerReconnectTimer = null
      this.connectPeerServer()
    }, delayMs)
  }

  private attachDataConnection(connection: DataConnection) {
    const remotePeerId = connection.peer
    const metadataSessionId = connection.metadata?.sessionId
    const metadataControllerId = connection.metadata?.controllerId
    if (metadataSessionId && metadataSessionId !== this.sessionId) {
      connection.close()
      return
    }

    this.logRuntime('incoming-connection', {
      remotePeerId,
      metadataControllerId,
      metadataSessionId,
    })

    this.dataConnections.get(remotePeerId)?.close()
    this.dataConnections.set(remotePeerId, connection)

    connection.on('open', () => {
      this.transport = 'webrtc'
      this.logRuntime('connection-open', {
        remotePeerId,
      })
      this.onActivity()
    })

    connection.on('data', (data) => {
      if (!data || typeof data !== 'object') return
      const packet = data as Partial<DomeControlPacket>
      if (packet.sessionId !== this.sessionId || typeof packet.type !== 'string') return
      if (typeof packet.controllerId !== 'string') return
      const controllerId = packet.controllerId

      this.adoptControllerPeer(controllerId, remotePeerId)
      if (packet.type === 'controller-input') {
        const controllerInput = data as ControllerInputPacket
        this.transport = 'webrtc'
        this.engine.upsertPlayerInput(controllerId, controllerInput.input)
        this.onActivity()
        return
      }
      if (packet.type === 'controller-goodbye') {
        this.releaseControllerPeer(controllerId, remotePeerId, true, 'controller-goodbye')
        this.onActivity()
        return
      }
      if (packet.type === 'controller-alignment') {
        const alignment = data as { cross: ControllerAlignmentCross | null }
        this.transport = 'webrtc'
        this.engine.setAlignmentCross(controllerId, alignment.cross)
        this.onActivity()
      }
    })

    connection.on('close', () => {
      this.logRuntime('connection-close', {
        remotePeerId,
      })
      if (this.dataConnections.get(remotePeerId) === connection) {
        this.dataConnections.delete(remotePeerId)
      }
      const controllerId = this.peerControllers.get(remotePeerId)
      if (controllerId) {
        this.releaseControllerPeer(controllerId, remotePeerId, true, 'connection-close')
      }
      if (this.dataConnections.size === 0 && this.transport === 'webrtc') {
        this.transport = 'debug-local'
      }
      this.onActivity()
    })

    connection.on('error', (error) => {
      this.logRuntime('connection-error', {
        remotePeerId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private adoptControllerPeer(controllerId: string, remotePeerId: string) {
    const existingPeerId = this.controllerPeers.get(controllerId)
    const alreadyBound = existingPeerId === remotePeerId && this.peerControllers.get(remotePeerId) === controllerId
    if (alreadyBound) {
      return
    }
    if (existingPeerId && existingPeerId !== remotePeerId) {
      this.dataConnections.get(existingPeerId)?.close()
      this.peerControllers.delete(existingPeerId)
    }
    this.controllerPeers.set(controllerId, remotePeerId)
    this.peerControllers.set(remotePeerId, controllerId)
    this.logRuntime('controller-bound', {
      controllerId,
      remotePeerId,
      replacedPeerId: existingPeerId && existingPeerId !== remotePeerId ? existingPeerId : undefined,
    })
  }

  private releaseControllerPeer(controllerId: string, remotePeerId: string, removePlayer: boolean, reason: string) {
    const currentPeerId = this.controllerPeers.get(controllerId)
    if (currentPeerId === remotePeerId) {
      this.controllerPeers.delete(controllerId)
      if (removePlayer) {
        this.engine.removePlayer(controllerId)
        this.logRuntime('player-removed', {
          controllerId,
          remotePeerId,
          reason,
        })
      }
    }
    if (this.peerControllers.get(remotePeerId) === controllerId) {
      this.peerControllers.delete(remotePeerId)
    }
    this.logRuntime('controller-released', {
      controllerId,
      remotePeerId,
      reason,
      removed: removePlayer,
    })
  }

  getSessionState(): ControllerSessionState {
    const players = this.engine.getControllerPlayers().map((player): ControllerPlayerState => ({
      ...player,
      buttons: { ...player.buttons },
    }))

    return {
      sessionId: this.sessionId,
      transport: this.transport,
      players,
      updatedAt: nowSeconds(),
    }
  }
}
