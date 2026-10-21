import type { Collector } from '../core/types'
import { linuxAudio } from './audio'
import { linuxBluetooth } from './bluetooth'
import { linuxCpu } from './cpu'
import { linuxDisplay } from './display'
import { linuxI2c } from './i2c'
import { linuxInput, linuxVideo } from './input'
import { linuxMemory } from './memory'
import { linuxNetwork } from './network'
import { linuxPci } from './pci'
import { linuxPower } from './power'
import { linuxSensors } from './sensors'
import { linuxSerial } from './serial'
import { linuxSmart } from './smart'
import { linuxStorage } from './storage'
import { linuxSystem } from './system'
import { linuxUsb } from './usb'

export const linuxCollectors: Collector[] = [
  linuxSystem,
  linuxCpu,
  linuxMemory,
  linuxPci,
  linuxUsb,
  linuxInput,
  linuxVideo,
  linuxNetwork,
  linuxBluetooth,
  linuxStorage,
  linuxSmart,
  linuxDisplay,
  linuxAudio,
  linuxPower,
  linuxSensors,
  linuxI2c,
  linuxSerial
]
