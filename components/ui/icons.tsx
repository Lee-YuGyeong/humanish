/**
 * 공용 아이콘. Font Awesome CDN 대신 인라인 SVG 를 쓴다.
 * (CDN 스크립트는 번들 밖 의존성이라 오프라인·CSP 환경에서 깨진다)
 *
 * 쓰는 곳: app/main(로비), app/room(대기방)
 */
type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const CoinIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v8M9.5 10a2.5 2 0 0 1 5 0M9.5 14a2.5 2 0 0 0 5 0" />
  </svg>
);

export const GemIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6 4h12l3 5-9 11L3 9z" />
    <path d="M3 9h18M9 4l-3 5 6 11 6-11-3-5" />
  </svg>
);

export const GearIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

export const SearchIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const SlidersIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 6h16M4 12h16M4 18h16" />
    <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" />
  </svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const CrownIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M3 7l4 4 5-6 5 6 4-4v10H3z" />
  </svg>
);

export const LockIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

export const VolumeIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
  </svg>
);

export const UserPlusIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M15 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
    <circle cx="9" cy="7" r="4" />
    <path d="M18 8v6M21 11h-6" />
  </svg>
);

export const SendIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10z" />
  </svg>
);

export const ExpandIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 10V4h6M20 14v6h-6M20 10V4h-6M4 14v6h6" />
  </svg>
);

export const ArrowLeftIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </svg>
);

export const InfoIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m5 13 4 4L19 7" />
  </svg>
);

/** 진짜 AI */
export const ChipIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
  </svg>
);

/** 스파이 */
export const SpyIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M3 9h18M7 9V7a5 5 0 0 1 10 0v2" />
    <circle cx="8" cy="14" r="3" />
    <circle cx="16" cy="14" r="3" />
    <path d="M11 14h2" />
  </svg>
);
