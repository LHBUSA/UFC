import styles from "./HoodieProductPreview.module.css";

const CORPORATE_LOGO = "https://propbetedge.ai/logo/pbe-full-600.png";

function FightMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <polygon points="55.1,22.4 55.1,41.6 41.6,55.1 22.4,55.1 8.9,41.6 8.9,22.4 22.4,8.9 41.6,8.9" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinejoin="round" />
      <polygon points="50.5,24.3 50.5,39.7 39.7,50.5 24.3,50.5 13.5,39.7 13.5,24.3 24.3,13.5 39.7,13.5" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="34.5" cy="17.5" r="4.2" fill="currentColor" />
      <path d="M29 24 L40.5 24 L39.5 36 L31 36 Z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M30.5 25.5 L25 29 L30 22.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.8" />
      <path d="M40 25.5 L46.5 28.5 L43.5 21" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.8" />
      <path d="M32 35.5 L27 41.5 L24 49" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5.2" />
      <path d="M38.5 35.5 L43.5 41 L46 49" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5.2" />
    </svg>
  );
}

export function HoodieProductPreview({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`${styles.preview}${compact ? ` ${styles.compact}` : ""}`}
      role="img"
      aria-label="Black PropBetEdge premium hoodie concept with the metallic PBE corporate logo centered on the chest and the gold fight mark on the sleeve"
    >
      <div className={styles.halo} aria-hidden="true" />
      <svg className={styles.hoodie} viewBox="0 0 480 600" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="pbe-hood" x1="0.12" y1="0" x2="0.88" y2="1">
            <stop offset="0%" stopColor="#1d1d1d" />
            <stop offset="52%" stopColor="#080808" />
            <stop offset="100%" stopColor="#171717" />
          </linearGradient>
          <linearGradient id="pbe-sleeve" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#161616" />
            <stop offset="100%" stopColor="#050505" />
          </linearGradient>
        </defs>
        <path d="M149 244 Q153 131 240 131 Q327 131 331 244 L292 218 Q240 247 188 218 Z" fill="url(#pbe-hood)" stroke="rgba(255,255,255,.14)" strokeWidth="2" />
        <path d="M180 180 Q240 215 300 180 L343 191 L412 247 L385 482 L355 466 L355 555 Q355 568 342 568 H138 Q125 568 125 555 V466 L95 482 L68 247 L137 191 Z" fill="url(#pbe-hood)" stroke="rgba(255,255,255,.16)" strokeWidth="2" strokeLinejoin="round" />
        <path d="M137 191 L123 466 L95 482 L68 247 Z M343 191 L357 466 L385 482 L412 247 Z" fill="url(#pbe-sleeve)" opacity=".96" />
        <path d="M179 178 Q240 216 301 178 M169 198 Q240 154 311 198 M214 195 L210 278 M266 195 L270 278 M158 421 H322 L316 489 H164 Z M125 541 H355" fill="none" stroke="rgba(255,255,255,.13)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M138 191 L126 466 M342 191 L354 466" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="2" />
      </svg>

      <img className={styles.logo} src={CORPORATE_LOGO} alt="" decoding="async" />
      <span className={styles.sleeveMark} aria-hidden="true"><FightMark /></span>
      <span className={styles.badge}>Cotton Heritage M2580 · Black</span>
      <span className={styles.note}>Corporate chest logo · fight mark sleeve</span>
    </div>
  );
}
