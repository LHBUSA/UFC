import styles from "./HoodieProductPreview.module.css";

const HOODIE_IMAGE = "/store/img/propbetedge-premium-hoodie.jpg";

export function HoodieProductPreview({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`${styles.preview}${compact ? ` ${styles.compact}` : ""}`}
      role="img"
      aria-label="Black PropBetEdge premium hoodie with the metallic PBE and PropBetEdge.ai chest logo and gold fight mark on the sleeve"
    >
      <img
        className={styles.photo}
        src={HOODIE_IMAGE}
        alt="Black PropBetEdge Premium Hoodie with metallic PBE chest logo and gold sleeve mark"
        width={400}
        height={500}
        loading={compact ? "lazy" : "eager"}
        decoding="async"
      />
      <span className={styles.badge}>Cotton Heritage M2580 · Black</span>
    </div>
  );
}
