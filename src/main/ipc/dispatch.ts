import { IPC_CHANNELS, IPC_REQUEST_SCHEMAS, type IpcChannel, type IpcRequest, type IpcResponses } from '@shared/ipc'
import { isTrustedUrl, type Origins } from '../security/policy'

export type Handlers = { [C in IpcChannel]: (input: any) => Promise<IpcResponses[C]> | IpcResponses[C] }

export class IpcError extends Error {
  constructor(readonly code: 'UNKNOWN_CHANNEL' | 'UNTRUSTED_SENDER' | 'INVALID_PAYLOAD', message: string) {
    super(message)
    this.name = 'IpcError'
  }
}

/**
 * Single choke point for every renderer → main call: the channel must be whitelisted, the sender
 * must be our own page, and the payload must satisfy the channel's strict schema. Handlers only
 * ever see validated input.
 */
export async function dispatch<C extends IpcChannel>(
  channel: string,
  payload: unknown,
  senderUrl: string | undefined,
  handlers: Handlers,
  origins: Origins
): Promise<IpcResponses[C]> {
  if (!(IPC_CHANNELS as string[]).includes(channel)) throw new IpcError('UNKNOWN_CHANNEL', `Unknown channel: ${String(channel).slice(0, 64)}`)
  if (!isTrustedUrl(senderUrl, origins)) throw new IpcError('UNTRUSTED_SENDER', 'IPC call from an untrusted frame')
  const schema = IPC_REQUEST_SCHEMAS[channel as IpcChannel]
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new IpcError('INVALID_PAYLOAD', `Invalid payload for ${channel}: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`)
  }
  return (await handlers[channel as IpcChannel](parsed.data as IpcRequest<IpcChannel>)) as IpcResponses[C]
}
