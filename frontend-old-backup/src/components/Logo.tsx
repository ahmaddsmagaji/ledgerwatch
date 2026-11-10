export default function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      height={size}
      width={(size * 750) / 650}
      viewBox="290 290 750 650"
      role="img"
      aria-label="Ledgerwatch"
    >
      <path fill="#ffffff" d="M303 301H453V790H545C610 792 650 815 685 845L762 930H400C340 930 303 890 303 830Z" />
      <g fill="#00e05a">
        <path d="M511 301H918Q960 301 960 350V384H511Z" />
        <path d="M511 429H918Q960 429 960 465V501H511Z" />
        <path d="M511 544H918Q960 544 960 580V615H511Z" />
        <path d="M511 653H922L850 727H511Z" />
        <path
          d="M700 811L742 770L815 830L950 692L1026 716L815 928Z"
          stroke="#00e05a"
          strokeWidth="8"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}
