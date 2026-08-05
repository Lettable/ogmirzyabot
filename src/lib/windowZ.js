// Shared stacking order for the floating (non-modal) windows — the AI chat and
// the mailbox, which can be open at the same time and overlap each other.
//
// Kept inside the band 41–49 so these windows always sit ABOVE the dashboard but
// BELOW the Radix modal layer (z-50 overlay/content used by Join/Leave/Raid/VC)
// and the minimized dock (z-[9999]). Clicking a window calls nextZ() and bumps it
// to the front relative to the other floating window.
let z = 41

export function nextZ() {
  z = z >= 49 ? 41 : z + 1
  return z
}
