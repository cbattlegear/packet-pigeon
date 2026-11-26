export type RemoteNodeRole = 'guest' | 'read-only' | 'read-write' | 'admin'
export type RemoteNodeAccess = { role: RemoteNodeRole | null; permissions: number | null; firmware: number | null; route: 'direct' | 'flood' }

// The server's post buffer is 151 bytes including its terminating NUL.
export const maxRoomTextBytes = 150

export function canPostToRoom(access?: RemoteNodeAccess) {
  return access?.role === 'read-write' || access?.role === 'admin'
}
