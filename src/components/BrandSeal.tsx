import React from 'react'

interface BrandSealProps {
  size?: number
  className?: string
}

/**
 * 品牌印面：松绿底 + 纸色 π。与 app-icon 同一套轮廓，只把颜色换成主题 token，
 * 这样 Paper / Ink 下分别用深松绿与浅松绿，其余形状不变。
 */
export const BrandSeal: React.FC<BrandSealProps> = ({ size = 20, className }) => (
  <svg
    viewBox="128 128 768 768"
    width={size}
    height={size}
    role="img"
    aria-label="Pi Workbench"
    className={className}
    style={{ flexShrink: 0 }}
  >
    <rect x="128" y="128" width="768" height="768" rx="152" fill="rgb(var(--accent))" />
    <g
      transform="translate(262.5 722.2) scale(0.7934 -0.7934)"
      fill="rgb(var(--accent-fg))"
      fillRule="nonzero"
    >
      <path d="M45 417 14 427C26 463 38.3 490.5 57 508.5C75.7 526.5 102 536 142 536H615L605 453H111C89 453 65 443 45 417ZM113 0 169 483H236L215 0ZM494 -6C458 -6 431 14.2 419 49.5C413 67.2 411 88 413 112L443 483H494L501 116C501.7 89.3 505 72.5 511 65.5C517 58.5 524 55 532 55C545.3 55 557 57.7 573 71L590 29C569.3 12.3 552 2.3 538 -1C524 -4.3 509.3 -6 494 -6Z" />
    </g>
  </svg>
)
