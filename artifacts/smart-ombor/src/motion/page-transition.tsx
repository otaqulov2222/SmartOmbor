import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

const EXIT = { opacity: 0, scale: 0.97, y: -8 };
const ENTER_FROM = { opacity: 0, scale: 0.97, y: 14, filter: 'blur(6px)' };
const ENTER_TO = { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' };

type PageTransitionProps = {
  routeKey: string;
  className?: string;
  children: ReactNode;
};

/**
 * Route/section enter-exit: fade + micro scale, blur resolve on enter.
 * Uses AnimatePresence mode="wait" for clean sequential transitions.
 */
export function PageTransition({ routeKey, className = 'page-enter', children }: PageTransitionProps) {
  const reduced = useReducedMotion();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        className={className}
        initial={ENTER_FROM}
        animate={{
          ...ENTER_TO,
          transition: { duration: 0.34, ease: [0.2, 0.8, 0.2, 1] },
        }}
        exit={{
          ...EXIT,
          filter: 'blur(2px)',
          transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
        }}
        style={{ willChange: 'opacity, transform, filter' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

type StaggerProps = {
  className?: string;
  children: ReactNode;
  /** Re-run stagger when section changes */
  watchKey?: string | number;
};

/** Orchestrated micro-stagger for cards / metrics / charts inside a section */
export function StaggerIn({ className, children, watchKey }: StaggerProps) {
  const reduced = useReducedMotion();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      key={watchKey}
      className={className}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: {
          transition: { staggerChildren: 0.04, delayChildren: 0.05 },
        },
      }}
    >
      {children}
    </motion.div>
  );
}

export const staggerItem = {
  hidden: { opacity: 0, y: 8, filter: 'blur(3px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] as const },
  },
};

export const MotionItem = motion.div;
