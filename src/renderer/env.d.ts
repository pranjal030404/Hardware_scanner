/// <reference types="vite/client" />
import type { JSX as ReactJSX } from 'react'

// React 19 no longer declares the global JSX namespace; alias it so `JSX.Element` keeps working.
declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type IntrinsicElements = ReactJSX.IntrinsicElements
    type ElementClass = ReactJSX.ElementClass
  }
}
