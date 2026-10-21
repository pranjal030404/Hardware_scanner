import { describe, expect, it } from 'vitest'
import { layoutTopology } from '../src/topology/layout'
import type { DeviceSummary } from '@shared/schemas'
import type { TopologyEdge } from '@shared/api'

const dev = (id: string, category: DeviceSummary['category'] = 'usb'): DeviceSummary => ({
  id, key: id, category, subtype: null, name: id, manufacturer: null, model: null, vendorId: null, productId: null, busType: null, driver: null,
  status: 'ok', presence: 'present', firstSeen: '', lastSeen: '', lastScanned: '', source: 's'
})
const edge = (from: string, to: string, directness: TopologyEdge['directness'] = 'reported'): TopologyEdge => ({ fromId: from, toId: to, type: 'bus_attachment', directness, confidence: directness === 'reported' ? 1 : 0.5, source: 's' })

describe('layoutTopology', () => {
  const nodes = ['root', 'hub', 'kbd', 'cam', 'lonely'].map((i) => dev(i))
  const edges = [edge('hub', 'root'), edge('kbd', 'hub'), edge('cam', 'hub')]

  it('arranges real relationships as a tree and lists unrelated devices separately', () => {
    const l = layoutTopology(nodes, edges)
    expect(l.nodes.map((n) => [n.device.id, n.depth])).toEqual([['root', 0], ['hub', 1], ['cam', 2], ['kbd', 2]])
    expect(l.unconnected.map((d) => d.id)).toEqual(['lonely']) // no link is invented for it
    expect(l.edges).toHaveLength(3)
    const hub = l.nodes.find((n) => n.device.id === 'hub')!
    const [cam, kbd] = [l.nodes.find((n) => n.device.id === 'cam')!, l.nodes.find((n) => n.device.id === 'kbd')!]
    expect(hub.y).toBe((cam.y + kbd.y) / 2) // parent centred on children
  })
  it('hides inferred relationships when only confirmed ones are requested', () => {
    const l = layoutTopology([...nodes, dev('guess')], [...edges, edge('guess', 'root', 'inferred')], { confirmedOnly: true })
    expect(l.nodes.find((n) => n.device.id === 'guess')).toBeUndefined()
    expect(l.unconnected.map((d) => d.id)).toContain('guess')
  })
  it('collapses a branch and reports how many descendants are hidden', () => {
    const l = layoutTopology(nodes, edges, { collapsed: new Set(['hub']) })
    expect(l.nodes.map((n) => n.device.id)).toEqual(['root', 'hub'])
    expect(l.nodes[1]).toMatchObject({ hiddenDescendants: 2, childCount: 2 })
    expect(l.edges).toHaveLength(1)
  })
  it('filters by category', () => {
    const mixed = [dev('r', 'pci'), dev('a', 'usb'), dev('b', 'storage')]
    const l = layoutTopology(mixed, [edge('a', 'r'), edge('b', 'r')], { categories: new Set(['pci', 'usb']) })
    expect(l.nodes.map((n) => n.device.id)).toEqual(['r', 'a'])
  })
  it('survives cycles and self references without hanging', () => {
    const l = layoutTopology([dev('a'), dev('b')], [edge('a', 'b'), edge('b', 'a'), edge('a', 'a')])
    expect(l.nodes.length).toBeGreaterThan(0)
  })
  it('lays out thousands of nodes quickly', () => {
    const n = Array.from({ length: 5000 }, (_, i) => dev(`n${i}`))
    const e = n.slice(1).map((x, i) => edge(x.id, `n${Math.floor(i / 5)}`))
    const t0 = performance.now()
    const l = layoutTopology(n, e)
    expect(l.nodes).toHaveLength(5000)
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
