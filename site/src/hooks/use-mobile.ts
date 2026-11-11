import * as React from "react"

// The same edge as Tailwind's md: breakpoint, in rem as it is, so the menu's phone and desktop
// forms switch at the same width even when someone sets a larger browser font size.
const MOBILE_QUERY = "(width < 48rem)"

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => {
      setIsMobile(mql.matches)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
