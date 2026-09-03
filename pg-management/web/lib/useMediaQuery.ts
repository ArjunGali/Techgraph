'use client';

import { useEffect, useState } from 'react';

/**
 * Subscribes to a media query.
 *
 * Returns false on the first render so the static export and the first client
 * paint agree, then settles to the real value. Layout that depends on this is
 * always written so the phone arrangement is the honest default.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * The layout shape currently on screen.
 *
 * Everything responsive in the app asks this rather than sniffing the user
 * agent, so one build adapts to a small phone, a large phone in landscape and
 * a 12-inch tablet purely by available width — and rearranges live when the
 * device is rotated or the app is put in a split-screen window.
 */
export type LayoutShape = 'phone' | 'phone-large' | 'tablet' | 'tablet-large';

export function useLayoutShape(): {
  shape: LayoutShape;
  /** Bottom navigation, single column, full-width forms. */
  isPhone: boolean;
  /** Sidebar navigation, multi-column grids, two-pane views. */
  isTablet: boolean;
  /** Enough width for a master-detail pane alongside the sidebar. */
  isWide: boolean;
  isLandscape: boolean;
} {
  const isAtLeastLargePhone = useMediaQuery('(min-width: 640px)');
  const isAtLeastTablet = useMediaQuery('(min-width: 768px)');
  const isAtLeastLargeTablet = useMediaQuery('(min-width: 1024px)');
  const isLandscape = useMediaQuery('(orientation: landscape)');

  const shape: LayoutShape = isAtLeastLargeTablet
    ? 'tablet-large'
    : isAtLeastTablet
      ? 'tablet'
      : isAtLeastLargePhone
        ? 'phone-large'
        : 'phone';

  return {
    shape,
    isPhone: !isAtLeastTablet,
    isTablet: isAtLeastTablet,
    isWide: isAtLeastLargeTablet,
    isLandscape,
  };
}

/**
 * Measures the element a ref is attached to.
 *
 * Viewport width is the wrong question for a component sitting inside a pane:
 * a table in the left half of a 1280px tablet has about 600px to work with,
 * not 1280. Components that can appear in more than one place ask this instead,
 * so they lay out for the space they actually have.
 */
export function useElementWidth<T extends HTMLElement>(): [
  (element: T | null) => void,
  number,
] {
  const [width, setWidth] = useState(0);
  const [element, setElement] = useState<T | null>(null);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, width];
}
