import { z } from 'zod'
import { DesignSchema } from '../circuit/schema'
import { CategorySchema, DeviceStatusSchema, FindingCategorySchema, FindingStatusSchema, SETTING_KEYS, SeveritySchema, type Settings } from './schemas'

/**
 * The complete set of renderer -> main channels. Anything not listed here is rejected by the main
 * process. There is intentionally no generic "run command" or "read file" channel.
 */
export const IPC_REQUEST_SCHEMAS = {
  'app:info': z.undefined(),
  'overview:get': z.undefined(),
  'inventory:list': z
    .object({
      category: CategorySchema.optional(),
      search: z.string().max(200).optional(),
      status: DeviceStatusSchema.optional(),
      includeMissing: z.boolean().optional()
    })
    .strict(),
  'inventory:get': z.object({ id: z.string().min(1).max(64) }).strict(),
  'inventory:scan': z.object({ collectorIds: z.array(z.string().max(64)).max(64).optional() }).strict(),
  'topology:get': z.undefined(),
  'diagnostics:status': z.undefined(),
  'diagnostics:list': z
    .object({ status: FindingStatusSchema.optional(), severity: SeveritySchema.optional(), category: FindingCategorySchema.optional(), search: z.string().max(200).optional() })
    .strict(),
  'diagnostics:get': z.object({ id: z.string().min(1).max(64) }).strict(),
  'diagnostics:setStatus': z
    .object({ id: z.string().min(1).max(64), action: z.enum(['acknowledge', 'dismiss', 'resolve', 'reopen']), reason: z.string().max(300).optional() })
    .strict(),
  'diagnostics:evaluate': z.undefined(),
  'diagnostics:setRuleEnabled': z.object({ ruleId: z.string().min(1).max(64), enabled: z.boolean() }).strict(),
  'snapshots:list': z.undefined(),
  'snapshots:get': z.object({ id: z.string().min(1).max(64) }).strict(),
  'snapshots:create': z.object({ label: z.string().max(80).optional(), rescan: z.boolean().optional() }).strict(),
  'snapshots:compare': z.object({ baseId: z.string().min(1).max(64), targetId: z.string().min(1).max(64), includeVolatile: z.boolean().optional() }).strict(),
  'snapshots:delete': z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict(),
  'metrics:status': z.undefined(),
  'metrics:query': z
    .object({
      series: z.array(z.object({ metric: z.string().min(1).max(160), deviceId: z.string().min(1).max(64) }).strict()).min(1).max(40),
      windowSec: z.number().int().min(10).max(2_592_000),
      maxPoints: z.number().int().min(10).max(2000).optional()
    })
    .strict(),
  'metrics:setPaused': z.object({ paused: z.boolean() }).strict(),
  'processes:top': z.object({ limit: z.number().int().min(1).max(50).default(15) }).strict(),
  'collectors:health': z.undefined(),
  'devices:controls': z.undefined(),
  'devices:setEnabled': z.object({ id: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
  'perf:state': z.undefined(),
  'perf:live': z.undefined(),
  'perf:applyProfile': z.object({ id: z.string().regex(/^(stock|quiet|balanced|performance|maximum|custom:\d{1,9})$/) }).strict(),
  // Values are plain tokens (numbers, "max"/"min", governor/preference/profile names); the main process
  // then checks each against the control this device reports, and the helper checks them again.
  'perf:applyCustom': z.object({ label: z.string().min(1).max(80), values: z.array(z.object({ id: z.string().min(1).max(80).regex(/^[a-z0-9_.]+$/), value: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/) }).strict()).min(1).max(16) }).strict(),
  'perf:restore': z.object({ target: z.enum(['stock', 'undo', 'original']) }).strict(),
  'perf:history': z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
  'perf:saveProfile': z.object({ name: z.string().trim().min(1).max(60) }).strict(),
  'perf:deleteProfile': z.object({ id: z.number().int().min(1) }).strict(),
  'perf:testStart': z.object({ mode: z.enum(['benchmark', 'monitor']), seconds: z.number().int().min(10).max(3600), intervalMs: z.number().int().min(250).max(10_000) }).strict(),
  'perf:testPoll': z.undefined(),
  'perf:testCancel': z.undefined(),
  'perf:tests': z.object({ limit: z.number().int().min(1).max(200).default(30) }).strict(),
  'perf:test': z.object({ id: z.number().int().min(1) }).strict(),
  'circuit:list': z.undefined(),
  'circuit:save': z.object({ id: z.number().int().min(1).optional(), name: z.string().trim().min(1).max(60), design: DesignSchema }).strict(),
  'circuit:load': z.object({ id: z.number().int().min(1) }).strict(),
  'circuit:delete': z.object({ id: z.number().int().min(1) }).strict(),
  'devtest:targets': z.undefined(),
  'devtest:check': z.object({ targetId: z.string().min(1).max(200) }).strict(),
  'devtest:deepStart': z.object({ targetId: z.string().min(1).max(200), node: z.string().regex(/^hidraw\d{1,3}$/), seconds: z.number().int().min(3).max(20) }).strict(),
  'devtest:deepPoll': z.object({ sessionId: z.string().min(1).max(64) }).strict(),
  'devtest:liveStart': z.object({ targetId: z.string().min(1).max(200) }).strict(),
  'devtest:livePoll': z.object({ sessionId: z.string().min(1).max(64) }).strict(),
  'devtest:liveStill': z.object({ sessionId: z.string().min(1).max(64), durationMs: z.number().int().min(1000).max(10_000) }).strict(),
  'devtest:liveStop': z.undefined(),
  'events:recent': z.object({ limit: z.number().int().min(1).max(1000).default(100) }).strict(),
  'monitor:status': z.undefined(),
  'monitor:setPaused': z.object({ paused: z.boolean() }).strict(),
  'settings:get': z.undefined(),
  'settings:set': z
    .object({ key: z.enum(SETTING_KEYS as [keyof Settings, ...(keyof Settings)[]]), value: z.unknown() })
    .strict(),
  'export:inventory': z.undefined(),
  'database:backup': z.undefined()
} as const

export type IpcChannel = keyof typeof IPC_REQUEST_SCHEMAS
export const IPC_CHANNELS = Object.keys(IPC_REQUEST_SCHEMAS) as IpcChannel[]
export type IpcRequest<C extends IpcChannel> = z.input<(typeof IPC_REQUEST_SCHEMAS)[C]>
export type { IpcResponses } from './api'
