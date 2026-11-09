import {
  animate,
  motion,
  useMotionValue,
  useTransform,
  type AnimationPlaybackControls,
  type MotionStyle,
} from 'framer-motion';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { usePrefersReducedMotion } from './reduced-motion';

/** GSAP-equivalent curves for slideFill lead/trail */
const EASE_LEAD: [number, number, number, number] = [0.16, 1, 0.3, 1]; // power4.out
const EASE_TRAIL: [number, number, number, number] = [0.65, 0, 0.35, 1]; // power3.inOut
const LEAD_DURATION = 0.28;
const TRAIL_DURATION = 0.62;

type Axis = 'x' | 'y';

type FluidPillProps = {
  containerRef: RefObject<HTMLElement | null>;
  /** CSS selector for the active item inside the container */
  activeSelector?: string;
  axis?: Axis;
  className?: string;
  style?: CSSProperties;
  /** Re-measure when this value changes (route, section, language, etc.) */
  watchKey?: string | number | boolean | null;
};

/**
 * Fluid "stretch & snap" indicator (slideFill).
 * Leading edge moves fast; trailing edge follows with momentum.
 */
export function FluidPill({
  containerRef,
  activeSelector = '.is-active',
  axis = 'y',
  className = 'fluid-pill',
  style,
  watchKey,
}: FluidPillProps) {
  const reduced = usePrefersReducedMotion();
  const lead = useMotionValue(0);
  const trail = useMotionValue(0);
  const itemSize = useMotionValue(0);
  const cross = useMotionValue(0);
  const crossSize = useMotionValue(0);
  const opacity = useMotionValue(0);
  const controlsRef = useRef<AnimationPlaybackControls[]>([]);
  const primed = useRef(false);

  const kill = useCallback(() => {
    controlsRef.current.forEach(c => c.stop());
    controlsRef.current = [];
  }, []);

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return null;
    const el = root.querySelector(activeSelector) as HTMLElement | null;
    if (!el || el.offsetParent === null) return null;
    const r = root.getBoundingClientRect();
    const a = el.getBoundingClientRect();
    const top = a.top - r.top + root.scrollTop;
    const left = a.left - r.left + root.scrollLeft;
    return {
      top,
      left,
      height: a.height,
      width: a.width,
    };
  }, [activeSelector, containerRef]);

  const snapTo = useCallback(
    (box: { top: number; left: number; height: number; width: number }) => {
      kill();
      if (axis === 'y') {
        lead.set(box.top);
        trail.set(box.top);
        itemSize.set(box.height);
        cross.set(box.left);
        crossSize.set(box.width);
      } else {
        lead.set(box.left);
        trail.set(box.left);
        itemSize.set(box.width);
        cross.set(box.top);
        crossSize.set(box.height);
      }
      opacity.set(1);
      primed.current = true;
    },
    [axis, cross, crossSize, itemSize, kill, lead, opacity, trail],
  );

  const animateTo = useCallback(
    (box: { top: number; left: number; height: number; width: number }) => {
      if (reduced || !primed.current) {
        snapTo(box);
        return;
      }
      kill();
      const target = axis === 'y' ? box.top : box.left;
      const size = axis === 'y' ? box.height : box.width;
      const crossPos = axis === 'y' ? box.left : box.top;
      const crossSz = axis === 'y' ? box.width : box.height;

      controlsRef.current = [
        animate(lead, target, { duration: LEAD_DURATION, ease: EASE_LEAD }),
        animate(trail, target, { duration: TRAIL_DURATION, ease: EASE_TRAIL }),
        animate(itemSize, size, { duration: TRAIL_DURATION, ease: EASE_TRAIL }),
        animate(cross, crossPos, { duration: LEAD_DURATION, ease: EASE_LEAD }),
        animate(crossSize, crossSz, { duration: TRAIL_DURATION, ease: EASE_TRAIL }),
        animate(opacity, 1, { duration: 0.15 }),
      ];
    },
    [axis, cross, crossSize, itemSize, kill, lead, opacity, reduced, snapTo, trail],
  );

  const sync = useCallback(
    (immediate = false) => {
      const box = measure();
      if (!box) {
        opacity.set(0);
        primed.current = false;
        return;
      }
      if (immediate) snapTo(box);
      else animateTo(box);
    },
    [animateTo, measure, opacity, snapTo],
  );

  useLayoutEffect(() => {
    sync(!primed.current);
  }, [sync, watchKey]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const onResize = () => sync(true);
    window.addEventListener('resize', onResize);

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sync(true)) : null;
    ro?.observe(root);

    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => sync(false))
        : null;
    mo?.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'aria-current', 'data-active'],
      subtree: true,
      childList: true,
    });

    const onScroll = () => sync(true);
    root.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      kill();
      window.removeEventListener('resize', onResize);
      root.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [containerRef, kill, sync]);

  const start = useTransform([lead, trail], ([l, t]) => Math.min(l as number, t as number));
  const stretch = useTransform(
    [lead, trail, itemSize],
    ([l, t, s]) => Math.abs((l as number) - (t as number)) + (s as number),
  );

  const pillStyle: MotionStyle =
    axis === 'y'
      ? {
          top: start,
          height: stretch,
          left: cross,
          width: crossSize,
          opacity,
        }
      : {
          left: start,
          width: stretch,
          top: cross,
          height: crossSize,
          opacity,
        };

  return (
    <motion.div
      className={className}
      aria-hidden="true"
      style={{ ...pillStyle, ...style }}
    />
  );
}

type FluidNavProps = {
  axis?: Axis;
  activeSelector?: string;
  className?: string;
  pillClassName?: string;
  watchKey?: string | number | boolean | null;
  children: ReactNode;
  role?: string;
  'aria-label'?: string;
};

/** Relative wrapper that hosts FluidPill + nav/tab children */
export function FluidNav({
  axis = 'y',
  activeSelector = '.is-active',
  className = 'fluid-nav',
  pillClassName,
  watchKey,
  children,
  role,
  'aria-label': ariaLabel,
}: FluidNavProps) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={className} data-fluid-axis={axis} role={role} aria-label={ariaLabel}>
      <FluidPill
        containerRef={ref}
        activeSelector={activeSelector}
        axis={axis}
        className={pillClassName}
        watchKey={watchKey}
      />
      {children}
    </div>
  );
}
