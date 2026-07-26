import test from 'node:test'
import assert from 'node:assert/strict'
import { opaqueSlideSurface, pickPalette, THEME, WRAP_SURFACE_BACKSTOP, type Theme } from '../src/renderer/components/wrap/wrapKit.tsx'

// DEV-248, the render half: a wrap slide must always sit on an opaque
// background — nothing beneath (the timeline, the sidebar's Settings button)
// may ever bleed through. The shipped bug was a translucent overlay; the fix
// is structural: every full-screen wrap surface paints a SOLID backstop color
// with the theme gradient layered over it, and no palette a seed can pick is
// allowed to contain a see-through stop. These tests pin both halves so a
// future palette or surface change cannot quietly reopen the window.

const SEMI_TRANSPARENT = /rgba\(|transparent|hsla\(|\/\s*0?\.\d/

function assertOpaqueTheme(name: string, theme: Theme) {
  assert.doesNotMatch(theme.bg, SEMI_TRANSPARENT, `${name}.bg must have fully opaque stops`)
  const surface = opaqueSlideSurface(theme)
  assert.equal(surface.backgroundColor, WRAP_SURFACE_BACKSTOP, `${name} surface must carry the solid backstop`)
  assert.equal(surface.backgroundImage, theme.bg, `${name} surface must keep its gradient over the backstop`)
}

test('the backstop itself is a solid hex color, not a gradient or an alpha color', () => {
  assert.match(WRAP_SURFACE_BACKSTOP, /^#[0-9a-fA-F]{6}$/)
})

test('every static THEME gradient is fully opaque and rides an opaque surface', () => {
  for (const [name, theme] of Object.entries(THEME)) assertOpaqueTheme(`THEME.${name}`, theme)
})

test('every seeded palette a wrap can pick is fully opaque on every scene', () => {
  // Seeds cycle through all palette families; cover them all plus a few big
  // seeds so modulo arithmetic changes cannot sneak a translucent family in.
  for (const seed of [0, 1, 2, 3, 4, 5, 97, 20260726]) {
    const palette = pickPalette(seed)
    for (const [name, theme] of Object.entries(palette)) assertOpaqueTheme(`pickPalette(${seed}).${name}`, theme)
  }
})
